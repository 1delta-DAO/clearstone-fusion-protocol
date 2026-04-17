use anchor_lang::error_code;

#[error_code]
pub enum FusionError {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Missing maker dst ata")]
    MissingMakerDstAta,
    #[msg("Order expired")]
    OrderExpired,
    #[msg("Invalid estimated taking amount")]
    InvalidEstimatedTakingAmount,
    #[msg("Protocol surplus fee too high")]
    InvalidProtocolSurplusFee,
    #[msg("Inconsistent protocol fee config")]
    InconsistentProtocolFeeConfig,
    #[msg("Inconsistent integrator fee config")]
    InconsistentIntegratorFeeConfig,
    #[msg("Order not expired")]
    OrderNotExpired,
    #[msg("Missing taker dst ata")]
    MissingTakerDstAta,
    #[msg("Caller is not authorized by the order's resolver policy")]
    UnauthorizedResolver,
    #[msg("AllowedList exceeds the maximum inline size")]
    AllowedListTooLong,
    #[msg("Merkle proof is required for MerkleRoot policy but was not provided")]
    MissingMerkleProof,
    #[msg("Merkle proof was provided for a policy that does not accept one")]
    UnexpectedMerkleProof,
    #[msg("Merkle proof exceeds the maximum allowed depth")]
    MerkleProofTooDeep,
    #[msg("Merkle proof does not verify against the order's root")]
    InvalidMerkleProof,
    #[msg("Order has been canceled by the maker")]
    OrderCanceled,
    #[msg("Order has already been fully filled")]
    OrderFullyFilled,
    #[msg("Preceding Ed25519 signature verification instruction is missing")]
    MissingSignatureInstruction,
    #[msg("Preceding instruction is not an Ed25519 signature verification")]
    InvalidSignatureInstruction,
    #[msg("Ed25519 signature verification instruction is malformed")]
    MalformedSignatureInstruction,
    #[msg("Signed pubkey does not match the declared maker")]
    SignerMismatch,
    #[msg("Signed message does not match the expected order hash")]
    MessageMismatch,
}
