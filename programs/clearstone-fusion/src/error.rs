use anchor_lang::error_code;

#[error_code]
pub enum FusionError {
    #[msg("Inconsistent native src trait")]
    InconsistentNativeSrcTrait,
    #[msg("Inconsistent native dst trait")]
    InconsistentNativeDstTrait,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Missing maker dst ata")]
    MissingMakerDstAta,
    #[msg("Not enough tokens in escrow")]
    NotEnoughTokensInEscrow,
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
    #[msg("Invalid cancellation fee")]
    InvalidCancellationFee,
    #[msg("Cancel order by resolver is forbidden")]
    CancelOrderByResolverIsForbidden,
    #[msg("Missing taker dst ata")]
    MissingTakerDstAta,
    #[msg("Missing maker src ata")]
    MissingMakerSrcAta,
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
}
