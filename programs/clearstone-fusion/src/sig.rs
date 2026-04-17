use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};

use crate::error::FusionError;

/// Offsets inside the native `Ed25519SigVerify111…` instruction data.
/// See Solana SDK `Ed25519SignatureOffsets`.
const SIG_LEN: usize = 64;
const PK_LEN: usize = 32;
const HEADER_LEN: usize = 16;
const THIS_IX_SENTINEL: u16 = u16::MAX;

/// Verify that the instruction directly preceding the current one is a
/// call to the native Ed25519 verifier over `(expected_pubkey, expected_message)`.
///
/// The native program performs the actual curve math; this check proves that
/// the intended `(pubkey, message)` were the inputs to that verification.
pub fn verify_ed25519_preceding_ix(
    sysvar_instructions: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(sysvar_instructions)? as usize;
    require!(current >= 1, FusionError::MissingSignatureInstruction);

    let prev = load_instruction_at_checked(current - 1, sysvar_instructions)?;
    require!(
        prev.program_id == ed25519_program::ID,
        FusionError::InvalidSignatureInstruction
    );

    let data = &prev.data;
    require!(
        data.len() >= 2 + HEADER_LEN,
        FusionError::MalformedSignatureInstruction
    );
    require!(data[0] == 1, FusionError::MalformedSignatureInstruction);

    let read_u16 = |off: usize| u16::from_le_bytes([data[off], data[off + 1]]);

    let sig_offset = read_u16(2) as usize;
    let sig_ix_index = read_u16(4);
    let pk_offset = read_u16(6) as usize;
    let pk_ix_index = read_u16(8);
    let msg_offset = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;
    let msg_ix_index = read_u16(14);

    require!(
        sig_ix_index == THIS_IX_SENTINEL
            && pk_ix_index == THIS_IX_SENTINEL
            && msg_ix_index == THIS_IX_SENTINEL,
        FusionError::MalformedSignatureInstruction
    );
    require!(
        sig_offset + SIG_LEN <= data.len()
            && pk_offset + PK_LEN <= data.len()
            && msg_offset + msg_size <= data.len(),
        FusionError::MalformedSignatureInstruction
    );

    let pk_bytes = &data[pk_offset..pk_offset + PK_LEN];
    require!(
        pk_bytes == expected_pubkey.as_ref(),
        FusionError::SignerMismatch
    );

    require!(
        msg_size == expected_message.len(),
        FusionError::MessageMismatch
    );
    let msg_bytes = &data[msg_offset..msg_offset + msg_size];
    require!(msg_bytes == expected_message, FusionError::MessageMismatch);

    Ok(())
}
