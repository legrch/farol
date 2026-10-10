package inference

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type credentialTestGate struct{ sync.Mutex }
type credentialTestClock uint64

func (c credentialTestClock) NowMillis() uint64 { return uint64(c) }

type credentialTestStore struct {
	mu      sync.Mutex
	record  CredentialRecord
	reads   int
	writes  []CredentialRecord
	readErr error
	readNil bool
	// Mode is an original store observation, including possible completed writes
	// with lost/malformed receipts. Test setup never replays those effects.
	mode map[int]string
	gate *credentialTestGate
	t    *testing.T
}

func (s *credentialTestStore) noGateIO() {
	if s.gate != nil {
		if !s.gate.TryLock() {
			s.t.Error("storage IO under credential Gate")
		} else {
			s.gate.Unlock()
		}
	}
}
func (s *credentialTestStore) Read(ctx context.Context) (*CredentialRecord, error) {
	s.noGateIO()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	if s.readErr != nil {
		return nil, s.readErr
	}
	if s.readNil {
		return nil, nil
	}
	r := copyCredentialRecord(s.record)
	return &r, nil
}
func (s *credentialTestStore) CompareAndSwap(ctx context.Context, revision uint64, next CredentialRecord) (*CredentialRecord, error) {
	s.noGateIO()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes = append(s.writes, copyCredentialRecord(next))
	mode := s.mode[len(s.writes)]
	if mode == "conflict" || s.record.Revision != revision {
		return nil, Conflict
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	s.record = copyCredentialRecord(next)
	switch mode {
	case "error":
		return nil, errors.New("synthetic-private-store-error")
	case "nil":
		return nil, nil
	case "malformed":
		r := copyCredentialRecord(next)
		r.RefreshToken = "synthetic-wrong-refresh"
		return &r, nil
	case "provenance":
		r := copyCredentialRecord(next)
		r.RefreshProduced = !r.RefreshProduced
		return &r, nil
	}
	r := copyCredentialRecord(next)
	return &r, nil
}
func (s *credentialTestStore) snapshot() CredentialRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return copyCredentialRecord(s.record)
}
func (s *credentialTestStore) switchTo(r CredentialRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Revision <= s.record.Revision || r.Account.Epoch <= s.record.Account.Epoch {
		panic("test switch did not advance revision/epoch")
	}
	s.record = copyCredentialRecord(r)
}

type credentialTestPolicy struct {
	mu        sync.Mutex
	selected  Selection
	denied    bool
	onCurrent func()
}

func (p *credentialTestPolicy) Current(ctx context.Context, s Selection) error {
	p.mu.Lock()
	deny := p.denied || p.selected.Account != s.Account || p.selected.ConsentID != s.ConsentID || p.selected.ConsentRevision != s.ConsentRevision
	hook := p.onCurrent
	p.mu.Unlock()
	if hook != nil {
		hook()
	}
	if deny {
		return errors.New("synthetic-private-consent-error")
	}
	return nil
}
func (p *credentialTestPolicy) selectAccount(s Selection) { p.mu.Lock(); p.selected = s; p.mu.Unlock() }
func (p *credentialTestPolicy) withdraw()                 { p.mu.Lock(); p.denied = true; p.mu.Unlock() }

type credentialTestProvider struct {
	mu      sync.Mutex
	calls   int
	request RefreshRequest
	fn      func(context.Context, RefreshRequest) (*RefreshResult, error)
	gate    *credentialTestGate
	t       *testing.T
}

func (p *credentialTestProvider) Refresh(ctx context.Context, r RefreshRequest) (*RefreshResult, error) {
	if p.gate != nil {
		if !p.gate.TryLock() {
			p.t.Error("provider IO under credential Gate")
		} else {
			p.gate.Unlock()
		}
	}
	p.mu.Lock()
	p.calls++
	p.request = r
	p.mu.Unlock()
	return p.fn(ctx, r)
}
func (p *credentialTestProvider) count() int { p.mu.Lock(); defer p.mu.Unlock(); return p.calls }

func credentialFixture(t *testing.T) (*CredentialManager, *credentialTestStore, *credentialTestProvider, *credentialTestPolicy, Selection) {
	t.Helper()
	s := Selection{Backend: PlanBackend, Account: AccountIdentity{Issuer: "https://auth.openai.com", Subject: "synthetic-subject", ClientID: "synthetic-client", HostID: "urn:uuid:00000000-0000-4000-8000-000000000001", Epoch: 4}, ConsentID: "synthetic-consent", ConsentRevision: 8,
		Model: ModelSelection{Slug: "synthetic-model", CatalogueEpoch: 1, CapabilityEvidence: "synthetic-evidence"}}
	g := &credentialTestGate{}
	store := &credentialTestStore{t: t, gate: g, mode: make(map[int]string), record: CredentialRecord{
		Revision: 3, Account: s.Account, ConsentID: s.ConsentID, ConsentRevision: s.ConsentRevision, ValidatedConsent: true,
		State: CredentialReady, AccessToken: "synthetic-access-old", RefreshToken: "synthetic-refresh-old", ExpiresAtMillis: 10, Generation: 2,
		RequestedScopes: []string{ResourceInvokeScope, DirectTokensScope}, GrantedScopes: []string{ResourceInvokeScope, DirectTokensScope},
	}}
	provider := &credentialTestProvider{t: t, gate: g, fn: func(ctx context.Context, request RefreshRequest) (*RefreshResult, error) {
		if got := store.snapshot(); got.State != CredentialRefreshing || got.Revision != 4 {
			t.Error("refresh occurred without known atomic reservation")
		}
		return &RefreshResult{Account: request.Account, AccessToken: "synthetic-access-new", RefreshToken: "synthetic-refresh-new", ExpiresAtMillis: 100, EarliestRefreshAtMillis: 80,
			GrantedScopes: []string{ResourceInvokeScope, DirectTokensScope}}, nil
	}}
	policy := &credentialTestPolicy{selected: s}
	m, err := NewCredentialManager(g, credentialTestClock(20), store, provider, policy)
	if err != nil {
		t.Fatal(err)
	}
	return m, store, provider, policy, s
}

func requireCredentialError(t *testing.T, got error, want Code) {
	t.Helper()
	if got != want {
		t.Fatalf("error = %v, want %v", got, want)
	}
	if strings.Contains(got.Error(), "synthetic-") {
		t.Fatal("unsanitized error")
	}
}

func TestCredentialManagerAtomicRotationAndDetachedValues(t *testing.T) {
	m, store, provider, _, s := credentialFixture(t)
	c, err := m.Acquire(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if c.Account != s.Account || c.AccessToken != "synthetic-access-new" || c.Generation != 3 || c.ExpiresAtMillis != 100 {
		t.Fatal("incomplete transient replacement")
	}
	r := store.snapshot()
	if r.Revision != 5 || r.State != CredentialReady || !r.RefreshProduced || r.Generation != 3 || r.AccessToken != "synthetic-access-new" || r.RefreshToken != "synthetic-refresh-new" || r.ExpiresAtMillis != 100 || r.EarliestRefreshAtMillis != 80 {
		t.Fatal("incomplete atomic record replacement")
	}
	if provider.count() != 1 || len(store.writes) != 2 {
		t.Fatal("refresh/settlement count")
	}
	if provider.request.Account != s.Account || provider.request.ConsentID != s.ConsentID || provider.request.ConsentRevision != s.ConsentRevision || provider.request.Generation != 2 || provider.request.RefreshToken != "synthetic-refresh-old" {
		t.Fatal("original refresh binding lost")
	}
	c.GrantedScopes[0] = "mutated"
	c.RequestedScopes[0] = "mutated"
	provider.request.RequestedScopes[0] = "mutated"
	if r := store.snapshot(); !inferenceScopes(r.GrantedScopes) || !inferenceScopes(r.RequestedScopes) {
		t.Fatal("credential scope alias escaped")
	}
	if _, err := m.Acquire(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if provider.count() != 1 {
		t.Fatal("unexpired credential refreshed")
	}
}

func TestCredentialManagerRefreshReadyRequiresOriginalFinalReceiptAcrossRestart(t *testing.T) {
	for _, mode := range []string{"acknowledged", "error", "nil", "malformed", "provenance"} {
		t.Run(mode, func(t *testing.T) {
			m, store, provider, policy, s := credentialFixture(t)
			if mode != "acknowledged" {
				store.mode[2] = mode
			}
			_, err := m.Acquire(context.Background(), s)
			if mode == "acknowledged" {
				if err != nil {
					t.Fatal(err)
				}
				if c, err := m.Acquire(context.Background(), s); err != nil || c.AccessToken != "synthetic-access-new" {
					t.Fatal("same live owner lost known final receipt")
				}
			} else {
				requireCredentialError(t, err, PersistenceUnknown)
				reads := store.reads
				_, err := m.Acquire(context.Background(), s)
				requireCredentialError(t, err, CredentialRefreshUnknown)
				if store.reads != reads {
					t.Fatal("uncertain owner reread its write to infer success")
				}
			}
			if r := store.snapshot(); r.State != CredentialReady || !r.RefreshProduced || r.AccessToken != "synthetic-access-new" || r.RefreshToken != "synthetic-refresh-new" {
				t.Fatal("fixture must preserve original possibly committed Ready observation")
			}
			for _, clock := range []credentialTestClock{20, 200} {
				fresh, err := NewCredentialManager(&credentialTestGate{}, clock, store, provider, policy)
				if err != nil {
					t.Fatal(err)
				}
				reads, writes := store.reads, len(store.writes)
				c, err := fresh.Acquire(context.Background(), s)
				requireCredentialError(t, err, CredentialRefreshUnknown)
				if c.AccessToken != "" || store.reads != reads+1 || len(store.writes) != writes || provider.count() != 1 {
					t.Fatal("fresh owner treated disk Ready as observed final receipt")
				}
				_, err = fresh.Acquire(context.Background(), s)
				requireCredentialError(t, err, CredentialRefreshUnknown)
				if store.reads != reads+1 || len(store.writes) != writes || provider.count() != 1 {
					t.Fatal("restart fence replayed storage/provider work")
				}
			}
		})
	}
}

func TestCredentialManagerWitnessDoesNotAuthorizeChangedReadyRevision(t *testing.T) {
	m, store, provider, _, s := credentialFixture(t)
	if _, err := m.Acquire(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	store.record.Revision++
	store.record.Generation++
	store.mu.Unlock()
	// A same-identity store update is not the exact final record acknowledged by
	// this live manager. It cannot inherit that witness, even while unexpired.
	c, err := m.Acquire(context.Background(), s)
	requireCredentialError(t, err, CredentialRefreshUnknown)
	if c.AccessToken != "" || provider.count() != 1 || len(store.writes) != 2 {
		t.Fatal("changed revision reused a stale final-CAS witness")
	}
}

func TestCredentialManagerTrustedConsentOriginUsableAcrossFreshManagers(t *testing.T) {
	m, store, provider, policy, s := credentialFixture(t)
	store.record.ExpiresAtMillis = 100
	for _, owner := range []int{0, 1} {
		if owner == 1 {
			var err error
			m, err = NewCredentialManager(&credentialTestGate{}, credentialTestClock(20), store, provider, policy)
			if err != nil {
				t.Fatal(err)
			}
		}
		if c, err := m.Acquire(context.Background(), s); err != nil || c.AccessToken != "synthetic-access-old" {
			t.Fatal("trusted consent origin refused")
		}
	}
	if store.snapshot().RefreshProduced || provider.count() != 0 || len(store.writes) != 0 {
		t.Fatal("trusted consent load manufactured refresh evidence")
	}
}

func TestCredentialManagerTrustedOwnerRequalificationUsesNewEpoch(t *testing.T) {
	m, store, provider, policy, s := credentialFixture(t)
	store.mode[2] = "error"
	_, err := m.Acquire(context.Background(), s)
	requireCredentialError(t, err, PersistenceUnknown)
	// This is an explicitly injected trusted owner result, not read-back
	// reconciliation by CredentialManager. The test asserts the required new
	// epoch/revision and independently validated consent-origin provenance.
	r := store.snapshot()
	r.Revision++
	r.Account.Epoch++
	r.RefreshProduced = false
	r.ConsentRevision++
	r.ConsentID = "synthetic-requalified-consent"
	store.switchTo(r)
	s.Account, s.ConsentID, s.ConsentRevision = r.Account, r.ConsentID, r.ConsentRevision
	policy.selectAccount(s)
	c, err := m.Acquire(context.Background(), s)
	if err != nil || c.Account != r.Account || c.AccessToken != "synthetic-access-new" {
		t.Fatal("independent trusted owner requalification not consumable")
	}
	if provider.count() != 1 || len(store.writes) != 2 {
		t.Fatal("requalification caused uncertain-effect replay")
	}
}

func TestCredentialManagerRefusesBeforeRefresh(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*credentialTestStore, *credentialTestPolicy, *Selection)
		want Code
	}{
		{"granted-scope-missing", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) {
			st.record.GrantedScopes = []string{ResourceInvokeScope}
		}, ScopeMissing},
		{"requested-only", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.GrantedScopes = nil }, ScopeMissing},
		{"requested-scope-missing", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.RequestedScopes = nil }, ScopeMissing},
		{"earliest-refresh", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) {
			st.record.EarliestRefreshAtMillis = 21
		}, CredentialUnavailable},
		{"expired-without-refresh", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.RefreshToken = "" }, CredentialUnavailable},
		{"unvalidated-consent", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) {
			st.record.ValidatedConsent = false
		}, Withdrawn},
		{"withdrawn-consent", func(_ *credentialTestStore, p *credentialTestPolicy, _ *Selection) { p.withdraw() }, Withdrawn},
		{"wrong-consent-revision", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.ConsentRevision++ }, Withdrawn},
		{"wrong-account", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) {
			st.record.Account.Subject = "synthetic-other"
			st.record.Account.Epoch++
		}, Withdrawn},
		{"read-error", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) {
			st.readErr = errors.New("synthetic-secret")
		}, CredentialUnavailable},
		{"nil-read", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.readNil = true }, CredentialUnavailable},
		{"invalid-record", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.Generation = 0 }, CredentialUnavailable},
		{"invalid-selection", func(_ *credentialTestStore, _ *credentialTestPolicy, s *Selection) { s.Account.HostID = "" }, Invalid},
		{"non-oauth-issuer", func(_ *credentialTestStore, _ *credentialTestPolicy, s *Selection) {
			s.Account.Issuer = "synthetic-unsupported-issuer"
		}, Invalid},
		{"dynamic-agent-client", func(_ *credentialTestStore, _ *credentialTestPolicy, s *Selection) {
			s.Account.ClientID = "dynamic_agent_client"
		}, Invalid},
		{"unknown-state", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.State = "unsupported" }, CredentialUnavailable},
		{"revision-overflow", func(st *credentialTestStore, _ *credentialTestPolicy, _ *Selection) { st.record.Revision = ^uint64(0) }, CredentialUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			m, store, provider, policy, s := credentialFixture(t)
			test.edit(store, policy, &s)
			_, err := m.Acquire(context.Background(), s)
			requireCredentialError(t, err, test.want)
			if provider.count() != 0 || len(store.writes) != 0 {
				t.Fatal("preflight refusal caused refresh/write")
			}
		})
	}
}

func TestCredentialManagerOneRefreshConcurrentAndRestartFence(t *testing.T) {
	m, store, provider, _, s := credentialFixture(t)
	started, release := make(chan struct{}), make(chan struct{})
	base := provider.fn
	provider.fn = func(ctx context.Context, req RefreshRequest) (*RefreshResult, error) {
		close(started)
		<-release
		return base(ctx, req)
	}
	done := make(chan error, 1)
	go func() { _, err := m.Acquire(context.Background(), s); done <- err }()
	<-started
	_, err := m.Acquire(context.Background(), s)
	requireCredentialError(t, err, AlreadyReserved)
	restarted, err := NewCredentialManager(&credentialTestGate{}, credentialTestClock(20), store, provider, &credentialTestPolicy{selected: s})
	if err != nil {
		t.Fatal(err)
	}
	_, err = restarted.Acquire(context.Background(), s)
	requireCredentialError(t, err, CredentialRefreshUnknown)
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if provider.count() != 1 {
		t.Fatal("duplicate refresh")
	}
}

func TestCredentialManagerLostRotationAndMalformedResultsNeverRetry(t *testing.T) {
	for _, kind := range []string{"lost-response", "nil-result", "wrong-account", "empty-access", "empty-refresh", "invalid-token", "expired", "missing-scope", "oversize-token", "oversize-scopes"} {
		t.Run(kind, func(t *testing.T) {
			m, store, provider, _, s := credentialFixture(t)
			base := provider.fn
			provider.fn = func(ctx context.Context, req RefreshRequest) (*RefreshResult, error) {
				r, _ := base(ctx, req)
				switch kind {
				case "lost-response":
					return nil, errors.New("synthetic-rotated-token-and-provider-detail")
				case "nil-result":
					return nil, nil
				case "wrong-account":
					r.Account.Subject = "synthetic-other"
				case "empty-access":
					r.AccessToken = ""
				case "empty-refresh":
					r.RefreshToken = ""
				case "invalid-token":
					r.AccessToken = "synthetic token\n"
				case "expired":
					r.ExpiresAtMillis = 20
				case "missing-scope":
					r.GrantedScopes = []string{ResourceInvokeScope}
				case "oversize-token":
					r.AccessToken = strings.Repeat("a", (32<<10)+1)
				case "oversize-scopes":
					r.GrantedScopes = append(r.GrantedScopes, strings.Repeat("s", 129))
				}
				return r, nil
			}
			_, err := m.Acquire(context.Background(), s)
			requireCredentialError(t, err, CredentialRefreshUnknown)
			if r := store.snapshot(); r.State != CredentialUnknown || r.AccessToken != "synthetic-access-old" || r.RefreshToken != "synthetic-refresh-old" {
				t.Fatal("unknown refresh exposed partial token replacement")
			}
			_, err = m.Acquire(context.Background(), s)
			requireCredentialError(t, err, CredentialRefreshUnknown)
			if provider.count() != 1 || len(store.writes) != 2 {
				t.Fatal("unknown refresh/write retried")
			}
		})
	}
}

func TestCredentialManagerUncertainCASNeverReplays(t *testing.T) {
	for _, phase := range []int{1, 2} {
		for _, mode := range []string{"error", "nil", "malformed", "provenance"} {
			t.Run(string(rune('0'+phase))+"-"+mode, func(t *testing.T) {
				m, store, provider, _, s := credentialFixture(t)
				store.mode[phase] = mode
				_, err := m.Acquire(context.Background(), s)
				requireCredentialError(t, err, PersistenceUnknown)
				_, err = m.Acquire(context.Background(), s)
				requireCredentialError(t, err, CredentialRefreshUnknown)
				wantCalls := phase - 1
				if provider.count() != wantCalls || len(store.writes) != phase {
					t.Fatal("uncertain operation replayed")
				}
			})
		}
	}
}

func TestCredentialManagerKnownCASConflictDoesNotDispatch(t *testing.T) {
	m, store, provider, _, s := credentialFixture(t)
	store.mode[1] = "conflict"
	_, err := m.Acquire(context.Background(), s)
	requireCredentialError(t, err, Conflict)
	if provider.count() != 0 || store.snapshot().State != CredentialReady {
		t.Fatal("known CAS refusal dispatched")
	}
}

func TestCredentialManagerRotationSettlementConflictIsSticky(t *testing.T) {
	m, store, provider, _, s := credentialFixture(t)
	store.mode[2] = "conflict"
	_, err := m.Acquire(context.Background(), s)
	requireCredentialError(t, err, Conflict)
	_, err = m.Acquire(context.Background(), s)
	requireCredentialError(t, err, CredentialRefreshUnknown)
	if provider.count() != 1 || len(store.writes) != 2 {
		t.Fatal("lost rotation settlement replayed")
	}
}

func TestCredentialManagerZeroAndRollbackClock(t *testing.T) {
	for _, phase := range []string{"zero-before", "rollback-before", "rollback-after-io"} {
		t.Run(phase, func(t *testing.T) {
			m, store, provider, _, s := credentialFixture(t)
			switch phase {
			case "zero-before":
				m.clock = credentialTestClock(0)
			case "rollback-before":
				store.record.ExpiresAtMillis = 100
				if _, err := m.Acquire(context.Background(), s); err != nil {
					t.Fatal(err)
				}
				m.clock = credentialTestClock(19)
			case "rollback-after-io":
				base := provider.fn
				provider.fn = func(ctx context.Context, req RefreshRequest) (*RefreshResult, error) {
					r, err := base(ctx, req)
					m.clock = credentialTestClock(19)
					return r, err
				}
			}
			_, err := m.Acquire(context.Background(), s)
			if phase == "rollback-after-io" {
				requireCredentialError(t, err, CredentialRefreshUnknown)
				if provider.count() != 1 || store.snapshot().State != CredentialUnknown {
					t.Fatal("clock rollback published rotated credentials")
				}
			} else {
				requireCredentialError(t, err, CredentialUnavailable)
				if provider.count() != 0 || len(store.writes) != 0 {
					t.Fatal("invalid clock refreshed")
				}
			}
		})
	}
}

func TestCredentialManagerSelectionFenceCapacityKeepsRoomForRevoke(t *testing.T) {
	m, store, provider, policy, s := credentialFixture(t)
	store.record.ExpiresAtMillis = 100
	for n := 0; n < maxCredentialSelections-1; n++ {
		s.Account.Subject = "synthetic-selected-" + strconv.Itoa(n)
		s.Account.Epoch++
		r := store.snapshot()
		r.Revision++
		r.Account = s.Account
		store.switchTo(r)
		policy.selectAccount(s)
		if _, err := m.Acquire(context.Background(), s); err != nil {
			t.Fatal(err)
		}
	}
	s.Account.Subject = "synthetic-final-selected"
	s.Account.Epoch++
	r := store.snapshot()
	r.Revision++
	r.Account = s.Account
	store.switchTo(r)
	policy.selectAccount(s)
	_, err := m.Acquire(context.Background(), s)
	requireCredentialError(t, err, CredentialUnavailable)
	if err := m.Revoke(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if r := store.snapshot(); r.State != CredentialRevoked || r.AccessToken != "" || r.RefreshToken != "" {
		t.Fatal("capacity lost reserved revoke slot")
	}
	if provider.count() != 0 || len(m.tracked) > maxCredentialSelections {
		t.Fatal("capacity exceeded or refresh occurred")
	}
	// The original fence remains observable after many newer selections; there
	// is no LRU eviction that could admit stale selected identities again.
	_, err = m.Acquire(context.Background(), s)
	requireCredentialError(t, err, Withdrawn)
}

func TestCredentialManagerRevokeBeforeAndDuringRefresh(t *testing.T) {
	for _, during := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "during"}[during], func(t *testing.T) {
			m, store, provider, _, s := credentialFixture(t)
			if during {
				base := provider.fn
				provider.fn = func(ctx context.Context, req RefreshRequest) (*RefreshResult, error) {
					r, err := base(ctx, req)
					if revokeErr := m.Revoke(ctx, s); revokeErr != nil {
						t.Fatal(revokeErr)
					}
					return r, err
				}
			} else if err := m.Revoke(context.Background(), s); err != nil {
				t.Fatal(err)
			}
			_, err := m.Acquire(context.Background(), s)
			requireCredentialError(t, err, Withdrawn)
			r := store.snapshot()
			if r.State != CredentialRevoked || r.Account.Epoch != s.Account.Epoch+1 || r.AccessToken != "" || r.RefreshToken != "" || r.ValidatedConsent {
				t.Fatal("revoke retained credential authority")
			}
			if during && provider.count() != 1 || !during && provider.count() != 0 {
				t.Fatal("wrong dispatch count")
			}
			_, err = m.Acquire(context.Background(), s)
			requireCredentialError(t, err, Withdrawn)
			writes := len(store.writes)
			err = m.Revoke(context.Background(), s)
			requireCredentialError(t, err, Withdrawn)
			if len(store.writes) != writes {
				t.Fatal("revoke replayed")
			}
		})
	}
}

func TestCredentialManagerSelectionSwitchBeforeAndDuringRefresh(t *testing.T) {
	for _, during := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "during"}[during], func(t *testing.T) {
			m, store, provider, policy, s := credentialFixture(t)
			nextSelection := s
			nextSelection.Account.Subject = "synthetic-new-subject"
			nextSelection.Account.Epoch++
			nextSelection.ConsentID = "synthetic-new-consent"
			switchAccount := func() {
				r := store.snapshot()
				r.Revision++
				r.Account, r.ConsentID = nextSelection.Account, nextSelection.ConsentID
				r.State = CredentialReady
				r.AccessToken, r.RefreshToken, r.ExpiresAtMillis = "synthetic-other-access", "synthetic-other-refresh", 100
				store.switchTo(r)
				policy.selectAccount(nextSelection)
			}
			if during {
				base := provider.fn
				provider.fn = func(ctx context.Context, req RefreshRequest) (*RefreshResult, error) {
					r, err := base(ctx, req)
					switchAccount()
					return r, err
				}
			} else {
				switchAccount()
			}
			_, err := m.Acquire(context.Background(), s)
			requireCredentialError(t, err, Withdrawn)
			if r := store.snapshot(); r.Account != nextSelection.Account || r.AccessToken != "synthetic-other-access" || r.RefreshToken != "synthetic-other-refresh" || r.State != CredentialReady {
				t.Fatal("late refresh overwrote new account")
			}
			c, err := m.Acquire(context.Background(), nextSelection)
			if err != nil || c.Account != nextSelection.Account || c.AccessToken != "synthetic-other-access" {
				t.Fatal("new account not independently selectable")
			}
		})
	}
}

func TestCredentialManagerPolicyWithdrawalAndCancellationAfterIO(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "withdrawn", true: "cancelled"}[cancel], func(t *testing.T) {
			m, store, provider, policy, s := credentialFixture(t)
			ctx, cancelContext := context.WithCancel(context.Background())
			defer cancelContext()
			base := provider.fn
			provider.fn = func(ctx context.Context, req RefreshRequest) (*RefreshResult, error) {
				r, err := base(ctx, req)
				if cancel {
					cancelContext()
				} else {
					policy.withdraw()
				}
				return r, err
			}
			c, err := m.Acquire(ctx, s)
			want := Withdrawn
			if cancel {
				want = Cancelled
			}
			requireCredentialError(t, err, want)
			if c.AccessToken != "" {
				t.Fatal("late token disclosed")
			}
			r := store.snapshot()
			if r.State != CredentialUnknown && r.State != CredentialRefreshing {
				t.Fatal("withdrawn/uncertain rotation published")
			}
			_, err = m.Acquire(context.Background(), s)
			requireCredentialError(t, err, CredentialRefreshUnknown)
			if provider.count() != 1 {
				t.Fatal("cancelled refresh replayed")
			}
		})
	}
}

func TestCredentialManagerPreCancelledAndNilPorts(t *testing.T) {
	m, store, provider, policy, s := credentialFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := m.Acquire(ctx, s)
	requireCredentialError(t, err, Cancelled)
	if store.reads != 0 || provider.count() != 0 || len(store.writes) != 0 {
		t.Fatal("cancelled preflight performed IO")
	}
	_, err = m.Acquire(nil, s)
	requireCredentialError(t, err, Invalid)
	_, err = NewCredentialManager(&credentialTestGate{}, credentialTestClock(20), nil, provider, policy)
	requireCredentialError(t, err, Invalid)
}

func TestCredentialManagerRevokeUncertainStoreRemainsWithdrawn(t *testing.T) {
	m, store, provider, _, s := credentialFixture(t)
	store.mode[1] = "error"
	err := m.Revoke(context.Background(), s)
	requireCredentialError(t, err, PersistenceUnknown)
	_, err = m.Acquire(context.Background(), s)
	requireCredentialError(t, err, Withdrawn)
	if provider.count() != 0 || len(store.writes) != 1 {
		t.Fatal("uncertain revoke replayed")
	}
}
