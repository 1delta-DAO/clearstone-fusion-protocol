use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::sysvar;
use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};
use auction::{calculate_rate_bump, AuctionData};
use constants::*;
use muldiv::MulDiv;

pub mod auction;
pub mod constants;
pub mod error;
pub mod merkle;
pub mod sig;
pub mod state;

use error::FusionError;
use state::OrderState;

declare_id!("9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J");

/// PDA that every maker approves as delegate on their src-asset ATA.
/// The program signs token pulls as this authority inside `fill`.
pub const DELEGATE_SEED: &[u8] = b"delegate";

/// Seed prefix for the per-order `OrderState` PDA.
pub const ORDER_STATE_SEED: &[u8] = b"order";

enum UniTransferParams<'info> {
    NativeTransfer {
        from: AccountInfo<'info>,
        to: AccountInfo<'info>,
        amount: u64,
        program: Program<'info, System>,
    },
    TokenTransfer {
        from: AccountInfo<'info>,
        authority: AccountInfo<'info>,
        to: AccountInfo<'info>,
        mint: InterfaceAccount<'info, Mint>,
        amount: u64,
        program: Interface<'info, TokenInterface>,
    },
}

#[program]
pub mod clearstone_fusion {
    use super::*;

    /// Resolver fills (partially or fully) a maker-signed order.
    ///
    /// Requires the preceding instruction to be a native Ed25519 verify
    /// over `(maker_pubkey, order_hash)`. Pulls src tokens from the
    /// maker's ATA via the program's delegate PDA; the maker must have
    /// previously called SPL Token `Approve` granting the delegate PDA
    /// sufficient allowance.
    pub fn fill(
        ctx: Context<Fill>,
        order: OrderConfig,
        amount: u64,
        merkle_proof: Option<Vec<[u8; 32]>>,
    ) -> Result<()> {
        require!(amount != 0, FusionError::InvalidAmount);
        require!(
            Clock::get()?.unix_timestamp < order.expiration_time as i64,
            FusionError::OrderExpired
        );
        require!(
            order.src_amount != 0 && order.min_dst_amount != 0,
            FusionError::InvalidAmount
        );
        require!(
            order.fee.surplus_percentage as u64 <= BASE_1E2,
            FusionError::InvalidProtocolSurplusFee
        );
        require!(
            order.estimated_dst_amount >= order.min_dst_amount,
            FusionError::InvalidEstimatedTakingAmount
        );
        require!(
            (order.fee.protocol_fee > 0 || order.fee.surplus_percentage > 0)
                == ctx.accounts.protocol_dst_acc.is_some(),
            FusionError::InconsistentProtocolFeeConfig
        );
        require!(
            (order.fee.integrator_fee > 0) == ctx.accounts.integrator_dst_acc.is_some(),
            FusionError::InconsistentIntegratorFeeConfig
        );
        if let ResolverPolicy::AllowedList(list) = &order.resolver_policy {
            require!(
                list.len() <= MAX_ALLOWED_LIST_LEN,
                FusionError::AllowedListTooLong
            );
        }

        enforce_resolver_policy(
            &order.resolver_policy,
            &ctx.accounts.taker.key(),
            merkle_proof,
        )?;

        let order_src_mint = ctx.accounts.src_mint.key();
        let order_dst_mint = ctx.accounts.dst_mint.key();
        let order_receiver = ctx.accounts.maker_receiver.key();
        let protocol_dst_acc = ctx.accounts.protocol_dst_acc.as_ref().map(|a| a.key());
        let integrator_dst_acc = ctx.accounts.integrator_dst_acc.as_ref().map(|a| a.key());

        let order_hash = order_hash(
            &order,
            protocol_dst_acc,
            integrator_dst_acc,
            order_src_mint,
            order_dst_mint,
            order_receiver,
        )?;

        sig::verify_ed25519_preceding_ix(
            &ctx.accounts.instructions_sysvar,
            &ctx.accounts.maker.key(),
            &order_hash,
        )?;

        // Lazy init of OrderState on first fill. Taker pays rent.
        if ctx.accounts.order_state.expiration_time == 0 {
            ctx.accounts.order_state.expiration_time = order.expiration_time;
            ctx.accounts.order_state.bump = ctx.bumps.order_state;
        }
        require!(
            !ctx.accounts.order_state.canceled,
            FusionError::OrderCanceled
        );

        let filled = ctx.accounts.order_state.filled_amount;
        let remaining = order
            .src_amount
            .checked_sub(filled)
            .ok_or(FusionError::OrderFullyFilled)?;
        require!(remaining > 0, FusionError::OrderFullyFilled);
        let fill_amount = std::cmp::min(amount, remaining);

        // Pull src from maker via the delegate PDA.
        let delegate_bump = ctx.bumps.delegate_authority;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.src_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.maker_src_ata.to_account_info(),
                    mint: ctx.accounts.src_mint.to_account_info(),
                    to: ctx.accounts.taker_src_ata.to_account_info(),
                    authority: ctx.accounts.delegate_authority.to_account_info(),
                },
                &[&[DELEGATE_SEED, &[delegate_bump]]],
            ),
            fill_amount,
            ctx.accounts.src_mint.decimals,
        )?;

        let dst_amount = get_dst_amount(
            order.src_amount,
            order.min_dst_amount,
            fill_amount,
            Some(&order.dutch_auction_data),
        )?;
        let (protocol_fee_amount, integrator_fee_amount, maker_dst_amount) = get_fee_amounts(
            order.fee.integrator_fee,
            order.fee.protocol_fee,
            order.fee.surplus_percentage,
            dst_amount,
            get_dst_amount(order.src_amount, order.estimated_dst_amount, fill_amount, None)?,
        )?;

        // Taker pays dst to maker (native or SPL).
        let mut params = if order.dst_asset_is_native {
            UniTransferParams::NativeTransfer {
                from: ctx.accounts.taker.to_account_info(),
                to: ctx.accounts.maker_receiver.to_account_info(),
                amount: maker_dst_amount,
                program: ctx.accounts.system_program.clone(),
            }
        } else {
            UniTransferParams::TokenTransfer {
                from: ctx
                    .accounts
                    .taker_dst_ata
                    .as_ref()
                    .ok_or(FusionError::MissingTakerDstAta)?
                    .to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
                to: ctx
                    .accounts
                    .maker_dst_ata
                    .as_ref()
                    .ok_or(FusionError::MissingMakerDstAta)?
                    .to_account_info(),
                mint: *ctx.accounts.dst_mint.clone(),
                amount: maker_dst_amount,
                program: ctx.accounts.dst_token_program.clone(),
            }
        };
        uni_transfer(&params)?;

        if protocol_fee_amount > 0 {
            match &mut params {
                UniTransferParams::NativeTransfer { amount, to, .. }
                | UniTransferParams::TokenTransfer { amount, to, .. } => {
                    *amount = protocol_fee_amount;
                    *to = ctx
                        .accounts
                        .protocol_dst_acc
                        .as_ref()
                        .ok_or(FusionError::InconsistentProtocolFeeConfig)?
                        .to_account_info();
                }
            }
            uni_transfer(&params)?;
        }

        if integrator_fee_amount > 0 {
            match &mut params {
                UniTransferParams::NativeTransfer { amount, to, .. }
                | UniTransferParams::TokenTransfer { amount, to, .. } => {
                    *amount = integrator_fee_amount;
                    *to = ctx
                        .accounts
                        .integrator_dst_acc
                        .as_ref()
                        .ok_or(FusionError::InconsistentIntegratorFeeConfig)?
                        .to_account_info();
                }
            }
            uni_transfer(&params)?;
        }

        ctx.accounts.order_state.filled_amount = filled
            .checked_add(fill_amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(())
    }

    /// Maker explicitly voids an outstanding order on-chain. Initializes
    /// (or updates) `OrderState` with `canceled = true` so resolvers can
    /// observe cancellation authoritatively instead of relying on stale
    /// off-chain state.
    pub fn cancel(ctx: Context<Cancel>, order: OrderConfig) -> Result<()> {
        if ctx.accounts.order_state.expiration_time == 0 {
            ctx.accounts.order_state.expiration_time = order.expiration_time;
            ctx.accounts.order_state.bump = ctx.bumps.order_state;
        }
        ctx.accounts.order_state.canceled = true;
        ctx.accounts.order_state.filled_amount = order.src_amount;
        Ok(())
    }

    /// Permissionless sweep: close an expired `OrderState` PDA and send
    /// the rent lamports to the caller. Works for any expired order, whether
    /// partially filled, fully filled, or canceled.
    pub fn clean_expired(ctx: Context<CleanExpired>, _order_hash: [u8; 32]) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.order_state.expiration_time as i64,
            FusionError::OrderNotExpired
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(order: OrderConfig)]
pub struct Fill<'info> {
    /// Resolver / taker, authorized by the order's `resolver_policy`.
    #[account(mut, signer)]
    pub taker: Signer<'info>,

    /// CHECK: maker is verified via the preceding Ed25519 instruction
    /// over `order_hash`, which binds this pubkey to the order.
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,

    /// CHECK: must match `order.receiver` (checked via `order_hash` seeds).
    #[account(mut)]
    pub maker_receiver: UncheckedAccount<'info>,

    pub src_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dst_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Maker's ATA of `src_mint` — tokens are pulled from here via the
    /// program's delegate PDA.
    #[account(
        mut,
        associated_token::mint = src_mint,
        associated_token::authority = maker,
        associated_token::token_program = src_token_program,
    )]
    pub maker_src_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Taker's ATA of `src_mint`.
    #[account(
        mut,
        constraint = taker_src_ata.mint.key() == src_mint.key()
    )]
    pub taker_src_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Maker receiver's ATA of `dst_mint`; created if missing.
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = dst_mint,
        associated_token::authority = maker_receiver,
        associated_token::token_program = dst_token_program,
    )]
    pub maker_dst_ata: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// Taker's ATA of `dst_mint`.
    #[account(
        mut,
        associated_token::mint = dst_mint,
        associated_token::authority = taker,
        associated_token::token_program = dst_token_program,
    )]
    pub taker_dst_ata: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    #[account(mut)]
    pub protocol_dst_acc: Option<UncheckedAccount<'info>>,
    #[account(mut)]
    pub integrator_dst_acc: Option<UncheckedAccount<'info>>,

    /// Per-order state. Initialized on first fill; taker pays rent.
    #[account(
        init_if_needed,
        payer = taker,
        space = 8 + OrderState::INIT_SPACE,
        seeds = [
            ORDER_STATE_SEED,
            maker.key().as_ref(),
            &order_hash(
                &order,
                protocol_dst_acc.clone().map(|a| a.key()),
                integrator_dst_acc.clone().map(|a| a.key()),
                src_mint.key(),
                dst_mint.key(),
                maker_receiver.key(),
            )?,
        ],
        bump,
    )]
    pub order_state: Account<'info, OrderState>,

    /// Program's delegate PDA; signs the `TransferChecked` that pulls the
    /// maker's src tokens. The maker must have previously `Approve`d this
    /// PDA on `maker_src_ata`.
    /// CHECK: seed-derived; has no backing data.
    #[account(seeds = [DELEGATE_SEED], bump)]
    pub delegate_authority: UncheckedAccount<'info>,

    pub src_token_program: Interface<'info, TokenInterface>,
    pub dst_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// CHECK: sysvar read to find the preceding Ed25519 verify instruction.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(order: OrderConfig)]
pub struct Cancel<'info> {
    #[account(mut, signer)]
    pub maker: Signer<'info>,

    pub src_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dst_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: must match `order.receiver` (checked via `order_hash` seeds).
    pub maker_receiver: UncheckedAccount<'info>,

    /// CHECK: must match `order.fee.protocol_dst_acc` (checked via `order_hash` seeds).
    pub protocol_dst_acc: Option<UncheckedAccount<'info>>,
    /// CHECK: must match `order.fee.integrator_dst_acc` (checked via `order_hash` seeds).
    pub integrator_dst_acc: Option<UncheckedAccount<'info>>,

    #[account(
        init_if_needed,
        payer = maker,
        space = 8 + OrderState::INIT_SPACE,
        seeds = [
            ORDER_STATE_SEED,
            maker.key().as_ref(),
            &order_hash(
                &order,
                protocol_dst_acc.clone().map(|a| a.key()),
                integrator_dst_acc.clone().map(|a| a.key()),
                src_mint.key(),
                dst_mint.key(),
                maker_receiver.key(),
            )?,
        ],
        bump,
    )]
    pub order_state: Account<'info, OrderState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_hash: [u8; 32])]
pub struct CleanExpired<'info> {
    #[account(mut, signer)]
    pub cleaner: Signer<'info>,

    /// CHECK: identifies the order by serving as the `maker` component of the PDA seed.
    pub maker: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ORDER_STATE_SEED, maker.key().as_ref(), &order_hash],
        bump = order_state.bump,
        close = cleaner,
    )]
    pub order_state: Account<'info, OrderState>,
}

// ---------------------------------------------------------------------------
// OrderConfig + ResolverPolicy
// ---------------------------------------------------------------------------

/// Configuration for fees applied to an order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct FeeConfig {
    pub protocol_fee: u16,
    pub integrator_fee: u16,
    pub surplus_percentage: u8,
}

/// Hard cap on the inline AllowedList size. 10 resolvers × 32 bytes + list
/// prefix keeps the fill instruction comfortably under Solana's 1232-byte
/// transaction limit together with the rest of the order payload, accounts,
/// and preceding Ed25519 verify ix. Larger curated sets must use `MerkleRoot`.
pub const MAX_ALLOWED_LIST_LEN: usize = 10;

/// Per-order maker-signed resolver policy.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ResolverPolicy {
    /// Inline list of permitted takers. Empty = permissionless.
    AllowedList(Vec<Pubkey>),
    /// Keccak256 Merkle root over permitted takers (OZ-style sorted pairs).
    MerkleRoot([u8; 32]),
}

impl Default for ResolverPolicy {
    fn default() -> Self {
        ResolverPolicy::AllowedList(Vec::new())
    }
}

/// Off-chain-signed order submitted by the maker.
///
/// `src_asset_is_native` is intentionally absent: the pull-settlement model
/// relies on SPL Token `Approve`, which native SOL doesn't support — sellers
/// of SOL must wrap to wSOL before signing an order.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct OrderConfig {
    pub id: u32,
    pub src_amount: u64,
    pub min_dst_amount: u64,
    pub estimated_dst_amount: u64,
    pub expiration_time: u32,
    pub dst_asset_is_native: bool,
    pub fee: FeeConfig,
    pub dutch_auction_data: AuctionData,
    pub resolver_policy: ResolverPolicy,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn enforce_resolver_policy(
    policy: &ResolverPolicy,
    caller: &Pubkey,
    merkle_proof: Option<Vec<[u8; 32]>>,
) -> Result<()> {
    match policy {
        ResolverPolicy::AllowedList(list) => {
            require!(
                merkle_proof.is_none(),
                FusionError::UnexpectedMerkleProof
            );
            require!(
                list.is_empty() || list.contains(caller),
                FusionError::UnauthorizedResolver
            );
            Ok(())
        }
        ResolverPolicy::MerkleRoot(root) => {
            let proof = merkle_proof.ok_or(FusionError::MissingMerkleProof)?;
            require!(
                proof.len() <= merkle::MAX_MERKLE_PROOF_LEN,
                FusionError::MerkleProofTooDeep
            );
            require!(
                merkle::verify_resolver(&proof, root, caller),
                FusionError::InvalidMerkleProof
            );
            Ok(())
        }
    }
}

/// Canonical hash of the full order, domain-separated by `program_id` so a
/// maker's signature over one deployment cannot be replayed on a sibling
/// program. The maker signs this exact byte string off-chain.
fn order_hash(
    order: &OrderConfig,
    protocol_dst_acc: Option<Pubkey>,
    integrator_dst_acc: Option<Pubkey>,
    src_mint: Pubkey,
    dst_mint: Pubkey,
    receiver: Pubkey,
) -> Result<[u8; 32]> {
    Ok(hashv(&[
        &crate::ID.to_bytes(),
        &order.try_to_vec()?,
        &protocol_dst_acc.try_to_vec()?,
        &integrator_dst_acc.try_to_vec()?,
        &src_mint.to_bytes(),
        &dst_mint.to_bytes(),
        &receiver.to_bytes(),
    ])
    .to_bytes())
}

fn get_dst_amount(
    initial_src_amount: u64,
    initial_dst_amount: u64,
    src_amount: u64,
    opt_data: Option<&AuctionData>,
) -> Result<u64> {
    let mut result = initial_dst_amount
        .mul_div_ceil(src_amount, initial_src_amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if let Some(data) = opt_data {
        let rate_bump = calculate_rate_bump(Clock::get()?.unix_timestamp as u64, data);
        result = result
            .mul_div_ceil(BASE_1E5 + rate_bump, BASE_1E5)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    Ok(result)
}

fn get_fee_amounts(
    integrator_fee: u16,
    protocol_fee: u16,
    surplus_percentage: u8,
    dst_amount: u64,
    estimated_dst_amount: u64,
) -> Result<(u64, u64, u64)> {
    let integrator_fee_amount = dst_amount
        .mul_div_floor(integrator_fee as u64, BASE_1E5)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let mut protocol_fee_amount = dst_amount
        .mul_div_floor(protocol_fee as u64, BASE_1E5)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let actual_dst_amount = (dst_amount - protocol_fee_amount)
        .checked_sub(integrator_fee_amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if actual_dst_amount > estimated_dst_amount {
        protocol_fee_amount += (actual_dst_amount - estimated_dst_amount)
            .mul_div_floor(surplus_percentage as u64, BASE_1E2)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    Ok((
        protocol_fee_amount,
        integrator_fee_amount,
        dst_amount - integrator_fee_amount - protocol_fee_amount,
    ))
}

fn uni_transfer(params: &UniTransferParams<'_>) -> Result<()> {
    match params {
        UniTransferParams::NativeTransfer {
            from,
            to,
            amount,
            program,
        } => system_program::transfer(
            CpiContext::new(
                program.to_account_info(),
                system_program::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                },
            ),
            *amount,
        ),
        UniTransferParams::TokenTransfer {
            from,
            authority,
            to,
            mint,
            amount,
            program,
        } => transfer_checked(
            CpiContext::new(
                program.to_account_info(),
                TransferChecked {
                    from: from.to_account_info(),
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: authority.to_account_info(),
                },
            ),
            *amount,
            mint.decimals,
        ),
    }
}

