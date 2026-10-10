# Browser model policy composition

Ordinary `chat.conversation.start` uses the existing settings/profile resolver,
explicit account approval and Chat lifecycle. Trusted boot captures the Models
projection inside the original private `Grant.WithCurrent`; handles and explicit
Follow turns retain that exact account owner and immutable model capture.

Each Send uses its actual fresh `VerifySend` account observation with the same
private approval. The detached per-turn Models value must retain the startup
pin and capability evidence, then pass its final freshness check inside the
existing account → Chat dispatch guards. This updates observation evidence only;
it does not renew approval, change selection or replay a prior operation.

Follow preserves the entire original resolution, including its configuration
hash and translation identity, alongside selection and required controls. A
changed resolution is refused before successor admission.

This Browser projection describes the compiled software text-turn route. It is
not provider discovery, live entitlement, SIWC credentials or inference billing
authority. The existing qualified profile, physical Browser writer, native host
and installed/provider acceptance remain separate requirements. Legacy creation
does not gain an account grant or Models authority through omission.

Controlled boot tests run the real resolver, approval, Models adapter and Chat
lifecycle with injected Browser/journal boundaries. They cover a forged Follow
configuration hash, fresh observation after initial expiry with the same grant,
and final gate wait exceeding observation expiry. They are portable composition
evidence, not native or provider qualification.
