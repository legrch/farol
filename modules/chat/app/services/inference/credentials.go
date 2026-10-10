package inference

import (
	"context"
	"slices"

	chatport "github.com/legrch/farol/modules/chat/app/port"
)

const (
	ResourceInvokeScope           = "resource.invoke"
	DirectTokensScope             = "chatgpt.tokens.use.direct"
	CredentialRefreshUnknown Code = "INFERENCE_CREDENTIAL_REFRESH_UNKNOWN"
	maxCredentialTokenBytes       = 16 << 10
	// Retained selection fences never evict. Ordinary acquisitions reserve the
	// final slot for a local revoke; exhaustion refuses new selection admission.
	maxCredentialSelections = 64
)

type CredentialState string

const (
	CredentialReady      CredentialState = "ready"
	CredentialRefreshing CredentialState = "refreshing"
	CredentialUnknown    CredentialState = "unknown"
	CredentialRevoked    CredentialState = "revoked"
)

// CredentialRecord is a complete secret-store value, never operation metadata.
// ValidatedConsent must come from the owning OAuth/consent flow. This manager
// cannot authorize consent or transfer credentials between identities.
// RefreshProduced distinguishes a refresh-written record from an independently
// qualified consent record. It must persist atomically with the rotated tokens.
// False is an explicit trusted-owner origin assertion, never a default assigned
// when decoding legacy/unknown credential state. It may be cleared only after
// trusted owner requalification with a new account epoch and record revision.
type CredentialRecord struct {
	Revision                                             uint64
	Account                                              AccountIdentity
	ConsentID                                            string
	ConsentRevision                                      uint64
	ValidatedConsent                                     bool
	RefreshProduced                                      bool
	State                                                CredentialState
	AccessToken, RefreshToken                            string
	RequestedScopes, GrantedScopes                       []string
	ExpiresAtMillis, EarliestRefreshAtMillis, Generation uint64
}

// CredentialStore is the bounded extension point of the existing secret owner;
// no secret-store implementation is supplied by this feature. Read returns a
// detached selected record. CompareAndSwap atomically replaces ALL fields only
// when the selected record still has expectedRevision. A known mismatch returns
// Conflict and performs no write. Success returns an exact detached receipt;
// any other error, nil or mismatched receipt is an uncertain write, never retried.
// Selection/revocation shares this CAS: a trusted account/client/host/consent
// selection change must advance Account.Epoch and Revision before becoming current.
// Revision pins the exact immutable complete record; fields cannot change under
// the same revision. A refreshing/unknown record is fenced after restart. Even a
// refresh-produced ready record needs this manager's original exact final-CAS
// witness: disk readiness does not prove that the writing owner observed success.
// A fresh manager refuses it without replay, including an acknowledged refresh.
// The store owner must requalify origin under a new epoch/revision for restart
// admission; no durable requalification mechanism is implemented here.
// These calls may perform IO, must obey ctx, and occur outside Gate.
type CredentialStore interface {
	Read(context.Context) (*CredentialRecord, error)
	CompareAndSwap(context.Context, uint64, CredentialRecord) (*CredentialRecord, error)
}

// CredentialPolicy checks the exact currently validated OAuth consent/identity.
// Its authority is independent of Computer renewal. A catalogue entry and a
// requested scope are not consent. The actual app also checks its operation
// authority after Acquire and before provider dispatch/disclosure.
type CredentialPolicy interface {
	Current(context.Context, Selection) error
}

type RefreshRequest struct {
	Account         AccountIdentity
	ConsentID       string
	ConsentRevision uint64
	RefreshToken    string
	RequestedScopes []string
	Generation      uint64
}

// RefreshResult is the provider-validated COMPLETE rotating credential result.
// Identity is pinned to the original issuer/subject/client/host/epoch. An absent
// refresh token is not permission to keep the old, possibly rotated token.
type RefreshResult struct {
	Account                                  AccountIdentity
	AccessToken, RefreshToken                string
	GrantedScopes                            []string
	ExpiresAtMillis, EarliestRefreshAtMillis uint64
}

type RefreshProvider interface {
	// Returns a detached immutable value. Opaque errors may follow rotation;
	// they never attest that retrying the old refresh token is safe.
	Refresh(context.Context, RefreshRequest) (*RefreshResult, error)
}

type credentialKey struct {
	Account         AccountIdentity
	ConsentID       string
	ConsentRevision uint64
}

// Content-free witness of the exact full final-CAS receipt. The store contract
// pins every record field under Revision, and the selection key pins identity
// and consent. This is live-origin evidence, never reconstructed from a read.
type credentialWitness struct{ Revision, Generation uint64 }

// CredentialManager performs one-shot app-owned refresh. Gate protects only its
// in-memory fences; no storage/provider IO occurs under it. A store reservation
// persists before refresh IO. Any possible rotation with no exact settlement
// stays fenced both in the durable record and this live manager.
type CredentialManager struct {
	gate                     chatport.Gate
	clock                    Clock
	store                    CredentialStore
	provider                 RefreshProvider
	policy                   CredentialPolicy
	busy, uncertain, revoked map[credentialKey]bool
	tracked                  map[credentialKey]bool
	witnesses                map[credentialKey]credentialWitness
	closed                   bool
	lastClockMillis          uint64
}

func NewCredentialManager(gate chatport.Gate, clock Clock, store CredentialStore, provider RefreshProvider, policy CredentialPolicy) (*CredentialManager, error) {
	if gate == nil || clock == nil || store == nil || provider == nil || policy == nil {
		return nil, Invalid
	}
	return &CredentialManager{gate: gate, clock: clock, store: store, provider: provider, policy: policy,
		busy: make(map[credentialKey]bool), uncertain: make(map[credentialKey]bool), revoked: make(map[credentialKey]bool), tracked: make(map[credentialKey]bool), witnesses: make(map[credentialKey]credentialWitness)}, nil
}

func keyOf(s Selection) credentialKey {
	return credentialKey{s.Account, s.ConsentID, s.ConsentRevision}
}

func validCredentialSelection(s Selection) bool {
	return ValidSelection(s)
}

func (m *CredentialManager) begin(s Selection) error {
	m.gate.Lock()
	defer m.gate.Unlock()
	k := keyOf(s)
	if m.closed || m.revoked[k] {
		return Withdrawn
	}
	if m.uncertain[k] {
		return CredentialRefreshUnknown
	}
	if m.busy[k] {
		return AlreadyReserved
	}
	if !m.tracked[k] {
		if len(m.tracked) >= maxCredentialSelections-1 {
			return CredentialUnavailable
		}
		m.tracked[k] = true
	}
	m.busy[k] = true
	return nil
}

func (m *CredentialManager) end(s Selection) {
	m.gate.Lock()
	delete(m.busy, keyOf(s))
	m.gate.Unlock()
}

func (m *CredentialManager) current(ctx context.Context, s Selection) error {
	if ctx.Err() != nil {
		return Cancelled
	}
	m.gate.Lock()
	revoked := m.closed || m.revoked[keyOf(s)]
	m.gate.Unlock()
	if revoked || m.policy.Current(ctx, s) != nil {
		return Withdrawn
	}
	return nil
}

// Clock is a pure injected observation. Serialize its samples to refuse zero or
// rollback without confusing concurrent observation order with clock movement.
func (m *CredentialManager) now() (uint64, error) {
	m.gate.Lock()
	defer m.gate.Unlock()
	now := m.clock.NowMillis()
	if now == 0 || now < m.lastClockMillis {
		return 0, CredentialUnavailable
	}
	m.lastClockMillis = now
	return now, nil
}

func (m *CredentialManager) poison(s Selection) {
	m.gate.Lock()
	m.uncertain[keyOf(s)] = true
	m.gate.Unlock()
}

func (m *CredentialManager) witnessed(s Selection, r CredentialRecord) bool {
	m.gate.Lock()
	defer m.gate.Unlock()
	w, ok := m.witnesses[keyOf(s)]
	return ok && w.Revision == r.Revision && w.Generation == r.Generation
}

func (m *CredentialManager) witness(s Selection, r CredentialRecord) {
	m.gate.Lock()
	defer m.gate.Unlock()
	// Acquire admitted this key before IO; this map shares its no-eviction bound.
	if m.tracked[keyOf(s)] {
		m.witnesses[keyOf(s)] = credentialWitness{r.Revision, r.Generation}
	}
}

func copyCredentialRecord(r CredentialRecord) CredentialRecord {
	r.RequestedScopes = append([]string(nil), r.RequestedScopes...)
	r.GrantedScopes = append([]string(nil), r.GrantedScopes...)
	return r
}

func boundedScopes(scopes []string) bool {
	if len(scopes) > 64 {
		return false
	}
	for _, s := range scopes {
		if s == "" || len(s) > 128 {
			return false
		}
	}
	return true
}

func inferenceScopes(scopes []string) bool {
	invoke, direct := false, false
	for _, s := range scopes {
		invoke = invoke || s == ResourceInvokeScope
		direct = direct || s == DirectTokensScope
	}
	return invoke && direct
}

func matchesCredential(r CredentialRecord, s Selection) bool {
	return r.Account == s.Account && r.ConsentID == s.ConsentID && r.ConsentRevision == s.ConsentRevision && r.ValidatedConsent
}

func validCredentialRecord(r CredentialRecord) bool {
	return r.Revision != 0 && r.Generation != 0 && r.ExpiresAtMillis != 0 && validCredentialToken(r.AccessToken) && (r.RefreshToken == "" || validCredentialToken(r.RefreshToken)) && boundedScopes(r.RequestedScopes) && boundedScopes(r.GrantedScopes)
}

func validCredentialToken(token string) bool {
	if token == "" || len(token) > maxCredentialTokenBytes {
		return false
	}
	for _, ch := range token {
		if ch <= 32 || ch >= 127 {
			return false
		}
	}
	return true
}

func transientCredential(r CredentialRecord) Credential {
	return Credential{Account: r.Account, AccessToken: r.AccessToken,
		RequestedScopes: append([]string(nil), r.RequestedScopes...), GrantedScopes: append([]string(nil), r.GrantedScopes...),
		ExpiresAtMillis: r.ExpiresAtMillis, Generation: r.Generation}
}

func sameCredentialRecord(a, b CredentialRecord) bool {
	// Complete equality matters: partial receipts must not attest atomic rotation.
	return a.Revision == b.Revision && a.Account == b.Account && a.ConsentID == b.ConsentID && a.ConsentRevision == b.ConsentRevision &&
		a.ValidatedConsent == b.ValidatedConsent && a.RefreshProduced == b.RefreshProduced && a.State == b.State && a.AccessToken == b.AccessToken && a.RefreshToken == b.RefreshToken &&
		a.ExpiresAtMillis == b.ExpiresAtMillis && a.EarliestRefreshAtMillis == b.EarliestRefreshAtMillis && a.Generation == b.Generation &&
		slices.Equal(a.RequestedScopes, b.RequestedScopes) && slices.Equal(a.GrantedScopes, b.GrantedScopes)
}

func (m *CredentialManager) cas(ctx context.Context, old, next CredentialRecord) error {
	receipt, err := m.store.CompareAndSwap(ctx, old.Revision, copyCredentialRecord(next))
	if err == Conflict {
		return Conflict
	}
	if err != nil || receipt == nil || !sameCredentialRecord(*receipt, next) {
		return PersistenceUnknown
	}
	return nil
}

// unknown records a possible lost rotation. It makes at most one CAS attempt;
// nil/error/conflict are retained as original uncertainty, never reconciled by
// reading a newer record and retrying the provider or persistence effect.
func (m *CredentialManager) unknown(ctx context.Context, s Selection, reserved CredentialRecord) {
	m.poison(s)
	if reserved.Revision == ^uint64(0) {
		return
	}
	next := copyCredentialRecord(reserved)
	next.Revision++
	next.State = CredentialUnknown
	_ = m.cas(ctx, reserved, next)
}

func (m *CredentialManager) Acquire(ctx context.Context, s Selection) (Credential, error) {
	if ctx == nil || !validCredentialSelection(s) {
		return Credential{}, Invalid
	}
	if err := m.begin(s); err != nil {
		return Credential{}, err
	}
	defer m.end(s)
	if err := m.current(ctx, s); err != nil {
		return Credential{}, err
	}
	loaded, err := m.store.Read(ctx)
	if err != nil || loaded == nil {
		return Credential{}, CredentialUnavailable
	}
	r := copyCredentialRecord(*loaded)
	if !matchesCredential(r, s) {
		return Credential{}, Withdrawn
	}
	switch r.State {
	case CredentialRefreshing, CredentialUnknown:
		m.poison(s)
		return Credential{}, CredentialRefreshUnknown
	case CredentialRevoked:
		return Credential{}, Withdrawn
	case CredentialReady:
	default:
		return Credential{}, CredentialUnavailable
	}
	if r.RefreshProduced && !m.witnessed(s, r) {
		m.poison(s)
		return Credential{}, CredentialRefreshUnknown
	}
	if !validCredentialRecord(r) {
		return Credential{}, CredentialUnavailable
	}
	if !inferenceScopes(r.RequestedScopes) || !inferenceScopes(r.GrantedScopes) {
		return Credential{}, ScopeMissing
	}
	now, err := m.now()
	if err != nil {
		return Credential{}, err
	}
	if now < r.ExpiresAtMillis {
		if err := m.current(ctx, s); err != nil {
			return Credential{}, err
		}
		return transientCredential(r), nil
	}
	if r.RefreshToken == "" || now < r.EarliestRefreshAtMillis {
		return Credential{}, CredentialUnavailable
	}
	if r.Revision >= ^uint64(0)-1 || r.Generation == ^uint64(0) {
		return Credential{}, CredentialUnavailable
	}
	if err := m.current(ctx, s); err != nil {
		return Credential{}, err
	}
	reserved := copyCredentialRecord(r)
	reserved.Revision++
	reserved.State = CredentialRefreshing
	if err := m.cas(ctx, r, reserved); err != nil {
		if err == PersistenceUnknown {
			m.poison(s)
		}
		return Credential{}, err
	}
	if err := m.current(ctx, s); err != nil {
		// No refresh IO occurred; retain the selected reservation as fenced. A
		// new explicit consent flow can replace it, but Acquire does not replay it.
		return Credential{}, err
	}
	result, err := m.provider.Refresh(ctx, RefreshRequest{Account: r.Account, ConsentID: r.ConsentID, ConsentRevision: r.ConsentRevision,
		RefreshToken: r.RefreshToken, RequestedScopes: append([]string(nil), r.RequestedScopes...), Generation: r.Generation})
	if err != nil || result == nil {
		m.unknown(ctx, s, reserved)
		return Credential{}, CredentialRefreshUnknown
	}
	now, clockErr := m.now()
	if clockErr != nil || result.Account != r.Account || !validCredentialToken(result.AccessToken) || !validCredentialToken(result.RefreshToken) || result.ExpiresAtMillis <= now || !boundedScopes(result.GrantedScopes) || !inferenceScopes(result.GrantedScopes) {
		m.unknown(ctx, s, reserved)
		return Credential{}, CredentialRefreshUnknown
	}
	if err := m.current(ctx, s); err != nil {
		m.unknown(ctx, s, reserved)
		return Credential{}, err
	}
	next := copyCredentialRecord(reserved)
	next.Revision++
	next.State = CredentialReady
	next.RefreshProduced = true
	next.AccessToken, next.RefreshToken = result.AccessToken, result.RefreshToken
	next.ExpiresAtMillis, next.EarliestRefreshAtMillis = result.ExpiresAtMillis, result.EarliestRefreshAtMillis
	next.GrantedScopes = append([]string(nil), result.GrantedScopes...)
	next.Generation++
	if err := m.cas(ctx, reserved, next); err != nil {
		// Even a known local CAS conflict cannot recover the provider's newly
		// rotated token. Fence this original identity without another write.
		m.poison(s)
		return Credential{}, err
	}
	m.witness(s, next)
	if err := m.current(ctx, s); err != nil {
		return Credential{}, err
	}
	return transientCredential(next), nil
}

// Revoke withdraws this local selection immediately and atomically clears its
// selected secret record. It is not a remote OAuth revocation API. Advancing the
// identity epoch makes late refresh CAS and the original selection unusable.
// A failed/uncertain store write remains locally withdrawn; it is never retried.
func (m *CredentialManager) Revoke(ctx context.Context, s Selection) error {
	if ctx == nil || !validCredentialSelection(s) {
		return Invalid
	}
	m.gate.Lock()
	k := keyOf(s)
	if m.closed || m.revoked[k] {
		m.gate.Unlock()
		return Withdrawn
	}
	if !m.tracked[k] && len(m.tracked) >= maxCredentialSelections {
		// Exhaustion withdraws all local selections and permits this one revoke
		// attempt. Later calls are refused, with no retained-fence eviction.
		m.closed = true
	} else {
		m.tracked[k] = true
		m.revoked[k] = true
	}
	m.gate.Unlock()
	if ctx.Err() != nil {
		return Cancelled
	}
	loaded, err := m.store.Read(ctx)
	if err != nil || loaded == nil {
		return PersistenceUnknown
	}
	r := copyCredentialRecord(*loaded)
	if !matchesCredential(r, s) {
		return Withdrawn
	}
	if r.Revision == ^uint64(0) || r.Account.Epoch == ^uint64(0) {
		return Invalid
	}
	next := copyCredentialRecord(r)
	next.Revision++
	next.Account.Epoch++
	next.State = CredentialRevoked
	next.ValidatedConsent = false
	next.AccessToken, next.RefreshToken = "", ""
	next.GrantedScopes = nil
	next.ExpiresAtMillis, next.EarliestRefreshAtMillis = 0, 0
	return m.cas(ctx, r, next)
}

var _ Credentials = (*CredentialManager)(nil)
