use anchor_lang::prelude::*;

/// Per-order on-chain state tracking partial fills and cancellation.
///
/// Initialized lazily by the first `fill` (or by `cancel`) at the PDA
/// `["order", maker, order_hash]`. Rent paid by the initializer.
///
/// The account stays alive until `clean_expired` sweeps it post-expiration;
/// keeping it alive until then is what guarantees replay protection for
/// fully-filled orders.
#[account]
#[derive(InitSpace)]
pub struct OrderState {
    /// Cumulative amount of `src_mint` pulled from the maker so far.
    pub filled_amount: u64,
    /// Copied from the signed order on first init; kept here so `clean_expired`
    /// can verify expiration without re-deriving `order_hash`.
    pub expiration_time: u32,
    /// Maker explicitly canceled this order on-chain.
    pub canceled: bool,
    pub bump: u8,
}
