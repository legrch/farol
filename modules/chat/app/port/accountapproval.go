package port

// AccountScope is independently pinned by trusted composition, including the
// backend incarnation. It is not inferred from a request or a provider snapshot.
type AccountScope struct {
	ProfileID, BackendGeneration, OwnerID, SessionID string
}

// AccountObservation is snapshot evidence, never approval authority. Observed
// requires provider-session-v1, a 64-character lowercase hex principal key, and
// positive JavaScript-safe millisecond times. Unknown carries no principal or
// time authority, even if those fields are populated. The trusted observer hashes
// BOTH provider user and account identity outside this policy.
type AccountObservation struct {
	State, Source, PrincipalKey       string
	ObservedAtMillis, ExpiresAtMillis uint64
}

// AccountClock is injected and sampled under the owner's Gate. Implementations
// must perform no IO and must not reenter the owner.
type AccountClock interface {
	NowMillis() uint64
}

// AccountApproval is an independent immutable value projection, not a capability.
// Copying or decoding it cannot mint a private current Grant.
type AccountApproval struct {
	Scope        AccountScope
	ApprovalID   string
	Revision     uint64
	PrincipalKey string
}
