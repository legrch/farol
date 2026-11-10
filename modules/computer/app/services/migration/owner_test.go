package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	leaseport "github.com/legrch/farol/modules/computer/app/port/lease"
	obsport "github.com/legrch/farol/modules/computer/app/port/observation"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	lease "github.com/legrch/farol/modules/computer/domain/lease"
	obs "github.com/legrch/farol/modules/computer/domain/observation"
)

const one = "11111111-1111-4111-8111-111111111111"
const boot = "22222222-2222-4222-8222-222222222222"
const goodDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

var measuredFixture = obs.Observation{
	Binding:  obs.Binding{Path: "/Users/test", Device: "17", Inode: "50"},
	Evidence: obs.Evidence{Schema: obs.EvidenceSchema, Filesystem: "apfs", VolumeUUID: "33333333-3333-4333-8333-333333333333", FileID: "50", BirthSeconds: "1", BirthNanoseconds: "0"},
}

func intent() Selection {
	return Selection{
		Request: journal.Request{OperationID: one, RequestDigest: goodDigest, ConsentDigest: goodDigest, ProfileID: "profile", OwnerID: "owner", ComputerID: "computer", WorkspaceID: "work", Root: "/Users/test", ExpectedRevision: "4", ExpectedGeneration: "3", HostLifetimeID: "lifetime"},
		Mode:    Legacy, Saved: obs.Saved{Binding: measuredFixture.Binding},
	}
}

type memoryStore struct {
	journal journal.Journal
	begins  int
	failed  bool
}

func (m *memoryStore) BeginTransition(_ context.Context, r journal.Request) (journal.Entry, bool, error) {
	m.begins++
	if m.failed {
		return journal.Entry{}, false, errors.New("write outcome unknown")
	}
	prior, yes := m.journal.Find(r.OperationID)
	if yes {
		if prior.Request != r {
			return journal.Entry{}, false, journal.ErrRefused
		}
		return prior, false, nil
	}
	next, e := m.journal.Begin(r)
	if e != nil {
		return journal.Entry{}, false, e
	}
	m.journal = next
	value, _ := next.Find(r.OperationID)
	return value, true, nil
}
func (m *memoryStore) AdvanceTransition(_ context.Context, id string, p journal.Phase, r journal.Receipt) error {
	next, e := m.journal.Advance(id, p, r)
	if e == nil {
		m.journal = next
	}
	return e
}
func (m *memoryStore) CertifyTransition(_ context.Context, id string, p journal.Phase, r journal.Receipt) error {
	next, e := m.journal.Certify(id, p, r)
	if e == nil {
		m.journal = next
	}
	return e
}

type bootSource struct{}

func (bootSource) Current(context.Context) (string, error) { return boot, nil }

type prereq bool

func (p prereq) Completed(context.Context) bool { return bool(p) }

type native struct {
	opens, holds, closes int
	allowed              bool
	closeError           bool
	measured             obs.Observation
	device               uint64
}
type anchor struct {
	native *native
	closed bool
}

func (n *native) Acquire(context.Context) (leaseport.Anchor, error) {
	n.opens++
	return &anchor{native: n}, nil
}
func (a *anchor) Requalify(context.Context) error {
	if !a.native.allowed || a.closed {
		return errors.New("anchor stale")
	}
	return nil
}
func (a *anchor) Check(_ context.Context, path string) (lease.Candidate, error) {
	if !a.native.allowed {
		return lease.Candidate{}, nil
	}
	return lease.Candidate{Path: path, Device: a.native.device, Inode: 50, Kind: "current-data-candidate", Authority: "not-established"}, nil
}
func (a *anchor) Close() error {
	if a.closed {
		return errors.New("double close")
	}
	a.closed = true
	a.native.closes++
	if a.native.closeError {
		return errors.New("close unknown")
	}
	return nil
}

type holder struct {
	native *native
	closed bool
}

func (n *native) Hold(_ context.Context, _ string) (obsport.HeldObservation, error) {
	n.holds++
	return &holder{native: n}, nil
}
func (h *holder) Snapshot() (obs.Observation, error) {
	if h.closed {
		return obs.Observation{}, errors.New("closed")
	}
	return h.native.measured, nil
}
func (h *holder) Requalify(context.Context) error {
	if h.closed || !h.native.allowed {
		return errors.New("stale")
	}
	return nil
}
func (h *holder) Close() error {
	if h.closed {
		return errors.New("double close")
	}
	h.closed = true
	h.native.closes++
	if h.native.closeError {
		return errors.New("unknown")
	}
	return nil
}
func makeOwner(p prereq) (*Owner, *memoryStore, *native) {
	store := &memoryStore{journal: journal.Journal{Entries: []journal.Entry{}}}
	n := &native{allowed: true, measured: measuredFixture, device: 17}
	return New(store, bootSource{}, p, n, n, &sync.Mutex{}, digestSource{}), store, n
}
func TestConfirmedWALBeforeNativeHandlesAndNoSecondOwner(t *testing.T) {
	ctx := context.Background()
	o, s, n := makeOwner(false)
	if _, e := o.Begin(ctx, intent()); e == nil || s.begins != 0 || n.opens != 0 {
		t.Fatal("unsettled prerequisite acquired handles")
	}
	o, s, n = makeOwner(true)
	s.failed = true
	if _, e := o.Begin(ctx, intent()); e == nil || n.opens != 0 || n.holds != 0 {
		t.Fatal("unknown WAL acquired handles")
	}
	o, s, n = makeOwner(true)
	r, e := o.Begin(ctx, intent())
	if e != nil || !r.Admitted || n.opens != 1 || n.holds != 1 {
		t.Fatal("admission", e)
	}
	if _, e := o.Begin(ctx, intent()); e == nil {
		t.Fatal("concurrent owner admitted")
	}
	duplicateOwner := New(s, bootSource{}, prereq(true), n, n, &sync.Mutex{}, digestSource{})
	duplicate, e := duplicateOwner.Begin(ctx, intent())
	if e != nil || duplicate.Admitted || n.opens != 1 || n.holds != 1 {
		t.Fatal("replayed old UUID effect", e)
	}
}
func TestLegacyExplicitPickerAndC1C3BoundedCandidate(t *testing.T) {
	ctx := context.Background()
	o, s, n := makeOwner(true)
	if _, e := o.Begin(ctx, intent()); e != nil {
		t.Fatal(e)
	}
	if _, e := o.Confirm(ctx, one, "/Users/other", true); e == nil {
		t.Fatal("different picker root accepted")
	}
	if _, e := o.Confirm(ctx, one, "/Users/test", false); e == nil {
		t.Fatal("non-native picker accepted")
	}
	if _, e := o.Confirm(ctx, one, "/Users/test", true); e != nil {
		t.Fatal(e)
	}
	if s.journal.Entries[0].Phase != journal.Prepared {
		t.Fatal("not prepared")
	}
	if n.closes != 0 {
		t.Fatal("closed originals too early")
	}
}
func TestRebindRemountIsCandidateNotPermission(t *testing.T) {
	ctx := context.Background()
	o, _, n := makeOwner(true)
	choice := intent()
	choice.Mode = Rebind
	choice.Saved.Evidence = &obs.Evidence{}
	*choice.Saved.Evidence = measuredFixture.Evidence
	choice.Saved.Binding.Device = "16"
	n.device = 17
	if _, e := o.Begin(ctx, choice); e != nil {
		t.Fatal(e)
	}
	if _, e := o.Confirm(ctx, one, "", false); e != nil {
		t.Fatalf("current Data candidate was rejected: %v", e)
	}
	o2, _, n2 := makeOwner(true)
	n2.device = 18
	if _, e := o2.Begin(ctx, choice); e != nil {
		t.Fatal(e)
	}
	if _, e := o2.Confirm(ctx, one, "", false); e == nil {
		t.Fatal("different current mount accepted")
	}
}
func TestCompleteUsesOriginalCloseOnceAfterIntent(t *testing.T) {
	ctx := context.Background()
	o, s, n := makeOwner(true)
	if _, e := o.Begin(ctx, intent()); e != nil {
		t.Fatal(e)
	}
	if _, e := o.Confirm(ctx, one, "/Users/test", true); e != nil {
		t.Fatal(e)
	}
	proof := journal.Receipt{EffectID: "effect-1", Digest: strings.Repeat("c", 64)}
	for _, phase := range []journal.Phase{journal.WithdrawIntent, journal.WithdrawAcknowledged, journal.SettingsIntent, journal.SettingsAcknowledged, journal.PublishIntent, journal.PublishAcknowledged, journal.CloseIntent} {
		if e := o.Record(ctx, one, phase, proof); e != nil {
			t.Fatal(phase, e)
		}
	}
	if e := o.Finish(ctx, one, journal.Committed, proof); e != nil {
		t.Fatal(e)
	}
	if n.closes != 2 || s.journal.Unresolved() {
		t.Fatal("close effects or certificate", n.closes)
	}
	if e := o.Finish(ctx, one, journal.Committed, proof); e == nil {
		t.Fatal("repeated close")
	}
}
func TestKnownRefusalVsUnknownCleanup(t *testing.T) {
	ctx := context.Background()
	o, s, n := makeOwner(true)
	o.Begin(ctx, intent())
	proof := journal.Receipt{EffectID: "cleanup", Digest: goodDigest}
	if e := o.Finish(ctx, one, journal.Refused, proof); e != nil || s.journal.Unresolved() {
		t.Fatal("known pre-withdraw refusal", e)
	}
	if n.closes != 2 {
		t.Fatal("bad cleanup")
	}
	o, s, n = makeOwner(true)
	n.closeError = true
	o.Begin(ctx, intent())
	if e := o.Finish(ctx, one, journal.Refused, proof); e == nil || !s.journal.Unresolved() {
		t.Fatal("unknown cleanup falsely refused")
	}
	if n.closes != 2 {
		t.Fatal("unconfirmed close repeated")
	}
}

type digestSource struct{}

func (digestSource) Digest(value obs.Observation) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
