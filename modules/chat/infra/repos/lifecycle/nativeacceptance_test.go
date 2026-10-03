//go:build darwin || linux

package lifecycle

import (
	"context"
	"crypto/sha256"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	app "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"golang.org/x/sys/unix"
)

var nativeChatRetirement = flag.Bool("chat-native-retirement", false, "run disposable native Chat journal retirement qualification")

// Explicit native-lane invocation (never enable this flag in default CPU CI):
// go test -count=1 -v -run '^TestNativeChatRetirementAggregate$' ./modules/chat/infra/repos/lifecycle -args -chat-native-retirement
//
// Production native storage and the actual Chat Service execute on the same
// physical root. The admitted turn is known NOT_DISPATCHED and explicitly ACKed;
// other cycles have an empty owner. No browser, provider, installed profile or
// subprocess is used. This does not qualify browser cleanup, fs power-loss,
// cross-process locking, boot receipt retention or exact backend-child exit.
// Each case owns a distinct fixture profile and one physical root throughout.
// An unexpected failure stops the aggregate before another case starts.
// All disposable roots are logged and retained, including expected lost-ACK
// fences. There is no automatic deletion, mutation retry or replacement root.
// Known native Retire closes descriptors; failures retain evidence for the lane
// owner, which must observe this exact test process terminal before disposal.
func TestNativeChatRetirementAggregate(t *testing.T) {
	if !*nativeChatRetirement {
		t.Skip("native Chat retirement requires explicit -chat-native-retirement on the Lead native lane")
	}
	cases := []struct {
		name  string
		check func(*testing.T)
	}{
		{"known_clean_same_root_empty_successor", nativeKnownCleanSuccessor},
		{"close_is_not_qualified_retirement", nativeCloseWithoutProof},
		{"lost_retirement_ack_retains_publication_fence", nativeLostRetirementACK},
		{"qualified_claim_has_one_live_writer", nativeExclusiveClaim},
		{"qualified_proof_requires_same_physical_root", nativeWrongRoot},
		{"consumed_proof_cannot_open_later_retirement", nativeConsumedProof},
		{"prior_incarnation_tombstone_is_not_reusable", nativePriorIncarnation},
		{"incarnation_budget_preserves_tombstones", nativeTombstoneBudget},
	}
	for _, tc := range cases {
		if !t.Run(tc.name, tc.check) {
			t.Fatal("native qualification failed; stop aggregate and preserve the exact fixture evidence")
		}
	}
}

func nativeRetirementRoot(t *testing.T) Root {
	t.Helper()
	// Resolve the host's normal temporary parent BEFORE creation; never override
	// TMPDIR or chmod/repair a refused root. MkdirTemp creates our own 0700 child.
	parent, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil || !filepath.IsAbs(parent) {
		t.Fatalf("canonical temporary parent: %v", err)
	}
	path, err := os.MkdirTemp(parent, "farol-chat-native-retirement-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true", path)
	canonical, err := filepath.EvalSymlinks(path)
	var physical unix.Stat_t
	if err != nil || canonical != path || unix.Lstat(path, &physical) != nil || uint32(physical.Mode)&unix.S_IFMT != unix.S_IFDIR || uint32(physical.Mode)&07777 != 0700 || physical.Uid != uint32(os.Geteuid()) {
		t.Fatal("new fixture is not its exact private canonical root")
	}
	return Root{Path: path, ProfileID: "fixture-" + filepath.Base(path), Device: uint64(physical.Dev), Inode: physical.Ino, OwnerUID: physical.Uid}
}

func nativeRetirementScope(root Root, generation string) port.JournalScope {
	return port.JournalScope{ProfileID: root.ProfileID, BackendGeneration: generation}
}

func nativeRetirementOwner(t *testing.T, root Root, scope port.JournalScope, limits Limits) (*Repository, *app.Service) {
	t.Helper()
	r, err := New(context.Background(), root, limits)
	if err != nil {
		t.Fatalf("native New: %v", err)
	}
	s, err := app.New(context.Background(), scope, app.Dependencies{Gate: gate.New(), Journal: r})
	if err != nil {
		t.Fatalf("actual owner OpenFresh: %v", err)
	}
	return r, s
}

func nativeKnownTerminalTurn(t *testing.T, s *app.Service, scope port.JournalScope) *app.Handle {
	t.Helper()
	b := port.TurnBinding{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration, OwnerID: "native-owner", SessionID: "native-session", TaskID: "native-task", TaskEpoch: 7, ParticipantID: "native-participant", TurnID: "turn-" + scope.BackendGeneration, OperationID: "operation-" + scope.BackendGeneration, TurnGeneration: 1}
	h, err := s.Admit(context.Background(), b, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := h.WithCurrent(context.Background(), func(current *port.CurrentTurn) error {
		if current == nil || current.Binding != b || current.Persistence != port.Committed || current.Turn.Phase != turn.Admitted {
			t.Fatal("native known commit did not publish actual admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	view, err := s.Cancel(context.Background(), h, "result-"+scope.BackendGeneration)
	if err != nil || view.Result.Code != "NOT_DISPATCHED" || view.Reserved || view.SendIntent {
		t.Fatal("fixture is not a known unreserved cancellation", err)
	}
	if _, err := s.Apply(context.Background(), h, app.Change{Action: app.Acknowledge, ResultID: view.Result.ID}); err != nil {
		t.Fatal("explicit initiating-client fixture ACK", err)
	}
	return h
}

func nativeKnownRetirement(t *testing.T, s *app.Service) (port.CleanRetirement, port.RetirementReceipt) {
	t.Helper()
	origin, err := s.Retire(context.Background())
	if err != nil || origin == nil {
		t.Fatal("actual owner did not retire known-clean", err)
	}
	var proof port.RetirementReceipt
	calls := 0
	if err := origin.WithRetirement(context.Background(), func(value *port.RetirementReceipt) error {
		calls++
		if value == nil {
			t.Fatal("nil live-owner retirement proof")
		}
		proof = *value
		proof.Write = port.CopyRetirement(value.Write)
		return nil
	}); err != nil || calls != 1 {
		t.Fatal("actual owner proof callback", err, calls)
	}
	return origin, proof
}

func nativeRetirementPublication(t *testing.T, root Root, limits Limits) (record, [32]byte) {
	t.Helper()
	var dir, claim, snapshot unix.Stat_t
	if unix.Lstat(root.Path, &dir) != nil || uint64(dir.Dev) != root.Device || dir.Ino != root.Inode || dir.Uid != root.OwnerUID || uint32(dir.Mode)&07777 != 0700 {
		t.Fatal("physical root binding changed")
	}
	for name, physical := range map[string]*unix.Stat_t{claimName: &claim, snapshotName: &snapshot} {
		if unix.Lstat(filepath.Join(root.Path, name), physical) != nil || uint32(physical.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(physical.Mode)&07777 != 0600 || physical.Uid != root.OwnerUID || physical.Nlink != 1 {
			t.Fatal("native publication identity is not private and regular", name)
		}
	}
	if snapshot.Size <= 0 || snapshot.Size > int64(limits.Bytes) {
		t.Fatal("native publication exceeded accepted byte bound")
	}
	raw, err := os.ReadFile(filepath.Join(root.Path, snapshotName))
	if err != nil {
		t.Fatal(err)
	}
	value, err := decode(raw, limits)
	if err != nil || value.Root != root.identity() || value.Scope.ProfileID != root.ProfileID {
		t.Fatal("noncanonical or crossed native publication", err)
	}
	return value, sha256.Sum256(raw)
}

func nativeEmptySuccessor(t *testing.T, root Root, next port.JournalScope, limits Limits, origin port.CleanRetirement) (*Repository, *app.Service) {
	t.Helper()
	r, err := NewAfterRetirement(context.Background(), root, next, limits, origin)
	if err != nil {
		t.Fatalf("native qualified successor: %v", err)
	}
	s, err := app.New(context.Background(), next, app.Dependencies{Gate: gate.New(), Journal: r})
	if err != nil {
		t.Fatalf("actual fresh empty incarnation: %v", err)
	}
	value, _ := nativeRetirementPublication(t, root, limits)
	if value.Scope != next || value.Retirement != nil || len(value.Writes) != 0 {
		t.Fatal("retained history restored as new live admission")
	}
	return r, s
}

func nativeKnownCleanSuccessor(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	first := nativeRetirementScope(root, "first")
	_, owner := nativeRetirementOwner(t, root, first, limits)
	initial, _ := nativeRetirementPublication(t, root, limits)
	if initial.Scope != first || initial.Retirement != nil || len(initial.Writes) != 0 {
		t.Fatal("initial journal was not empty")
	}
	h := nativeKnownTerminalTurn(t, owner, first)
	origin, proof := nativeKnownRetirement(t, owner)
	retired, hash := nativeRetirementPublication(t, root, limits)
	if hash != proof.PublicationDigest || retired.Retirement == nil || !port.SameRetirement(*retired.Retirement, proof.Write) || proof.Write.Root != root.identity() || proof.Write.PreviousRevision != 3 || proof.Write.Revision != 4 || len(proof.Write.Turns) != 1 || proof.Write.Turns[0].AcknowledgedRevision != 3 {
		t.Fatal("native known retirement lost exact publication/revision/ACK binding")
	}
	next := nativeRetirementScope(root, "second")
	_, freshOwner := nativeEmptySuccessor(t, root, next, limits, origin)
	fresh, _ := nativeRetirementPublication(t, root, limits)
	if len(fresh.Incarnations) != 2 || fresh.Incarnations[0] != first.BackendGeneration || fresh.Incarnations[1] != next.BackendGeneration {
		t.Fatal("predecessor incarnation tombstone lost")
	}
	if err := h.WithCurrent(context.Background(), func(value *port.CurrentTurn) error {
		if value != nil {
			t.Fatal("old handle became positive in fresh incarnation")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	h2 := nativeKnownTerminalTurn(t, freshOwner, next)
	_, secondProof := nativeKnownRetirement(t, freshOwner)
	if h2.Binding().BackendGeneration == h.Binding().BackendGeneration {
		t.Fatal("new actual handle reused predecessor incarnation")
	}
	_, before := nativeRetirementPublication(t, root, limits)
	if r, err := New(context.Background(), root, limits); r != nil || !errors.Is(err, Refused) {
		t.Fatal("generic New bypassed retained claim", err)
	}
	_, after := nativeRetirementPublication(t, root, limits)
	if before != after || after != secondProof.PublicationDigest {
		t.Fatal("generic refusal changed known retirement")
	}
}

func nativeCloseWithoutProof(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	r, _ := nativeRetirementOwner(t, root, nativeRetirementScope(root, "closed"), limits)
	_, before := nativeRetirementPublication(t, root, limits)
	if err := r.Close(); err != nil {
		t.Fatal("known lifetime close", err)
	}
	if reopened, err := New(context.Background(), root, limits); reopened != nil || !errors.Is(err, Refused) {
		t.Fatal("Close retired permanent claim", err)
	}
	value, after := nativeRetirementPublication(t, root, limits)
	if before != after || value.Retirement != nil {
		t.Fatal("Close fabricated retirement")
	}
}

// This seam drops ONLY the actual native retirement reply. It changes no native
// disk/lock state and implements no positive CleanRetirement origin. The actual
// Service must remain unknown even though the adapter published known bytes.
type nativeLostACKJournal struct {
	repository  *Repository
	publication *port.RetirementReceipt
	retireCalls int
}

func (j *nativeLostACKJournal) OpenFresh(ctx context.Context, s port.JournalScope) (*port.JournalHead, error) {
	return j.repository.OpenFresh(ctx, s)
}
func (j *nativeLostACKJournal) Commit(ctx context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	return j.repository.Commit(ctx, w)
}
func (j *nativeLostACKJournal) Retire(ctx context.Context, w port.RetirementWrite) (*port.RetirementReceipt, error) {
	j.retireCalls++
	receipt, err := j.repository.Retire(ctx, w)
	if err != nil {
		return nil, err
	}
	if receipt == nil {
		return nil, errors.New("native retirement supplied no receipt")
	}
	copy := *receipt
	copy.Write = port.CopyRetirement(receipt.Write)
	j.publication = &copy
	return nil, errors.New("fixture lost native retirement ACK")
}

func nativeLostRetirementACK(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	r, err := New(context.Background(), root, limits)
	if err != nil {
		t.Fatal(err)
	}
	journal := &nativeLostACKJournal{repository: r}
	owner, err := app.New(context.Background(), nativeRetirementScope(root, "lost-ack"), app.Dependencies{Gate: gate.New(), Journal: journal})
	if err != nil {
		t.Fatal(err)
	}
	h := nativeKnownTerminalTurn(t, owner, nativeRetirementScope(root, "lost-ack"))
	if proof, err := owner.Retire(context.Background()); proof != nil || !errors.Is(err, app.Unsettled) {
		t.Fatal("lost ACK minted a qualified live-owner proof", err)
	}
	value, before := nativeRetirementPublication(t, root, limits)
	if journal.retireCalls != 1 || journal.publication == nil || value.Retirement == nil || before != journal.publication.PublicationDigest {
		t.Fatal("test did not exercise actual known native publication before ACK loss")
	}
	if err := h.WithCurrent(context.Background(), func(value *port.CurrentTurn) error {
		if value == nil || value.Persistence != port.UnknownCommit {
			t.Fatal("lost ACK became known absence or positive authority")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// No owner proof exists. Stored metadata and a raw repository receipt are not
	// a substitute; there is deliberately no fake proof port for this reopen.
	if next, err := NewAfterRetirement(context.Background(), root, nativeRetirementScope(root, "after-lost-ack"), limits, nil); next != nil || !errors.Is(err, Invalid) {
		t.Fatal("proof absence admitted a successor", err)
	}
	_, after := nativeRetirementPublication(t, root, limits)
	if after != before {
		t.Fatal("proof-absence refusal changed uncertainty fence")
	}
}

func nativeExclusiveClaim(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	_, owner := nativeRetirementOwner(t, root, nativeRetirementScope(root, "lock-first"), limits)
	origin, _ := nativeKnownRetirement(t, owner)
	holder, err := NewAfterRetirement(context.Background(), root, nativeRetirementScope(root, "lock-holder"), limits, origin)
	if err != nil {
		t.Fatal(err)
	}
	_, before := nativeRetirementPublication(t, root, limits)
	// Independent constructor/open descriptor, same known origin, distinct next
	// scope. The held native claim must refuse it before any publication.
	if contender, err := NewAfterRetirement(context.Background(), root, nativeRetirementScope(root, "lock-contender"), limits, origin); contender != nil || !errors.Is(err, Refused) {
		t.Fatal("two qualified constructors acquired the same native claim", err)
	}
	_, after := nativeRetirementPublication(t, root, limits)
	if after != before {
		t.Fatal("claim refusal changed publication")
	}
	// Only the already-qualified holder is closed; the refused operation is never
	// retried and its alternate scope is never admitted.
	if err := holder.Close(); err != nil {
		t.Fatal("known holder descriptor close", err)
	}
}

func nativeWrongRoot(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	_, owner := nativeRetirementOwner(t, root, nativeRetirementScope(root, "root-first"), limits)
	origin, proof := nativeKnownRetirement(t, owner)
	crossed := root
	crossed.Inode++
	if next, err := NewAfterRetirement(context.Background(), crossed, nativeRetirementScope(root, "root-next"), limits, origin); next != nil || !errors.Is(err, Refused) {
		t.Fatal("qualified proof admitted a crossed physical root", err)
	}
	_, after := nativeRetirementPublication(t, root, limits)
	if after != proof.PublicationDigest {
		t.Fatal("root mismatch changed original publication")
	}
}

func nativeConsumedProof(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	_, owner := nativeRetirementOwner(t, root, nativeRetirementScope(root, "consume-first"), limits)
	origin, _ := nativeKnownRetirement(t, owner)
	_, next := nativeEmptySuccessor(t, root, nativeRetirementScope(root, "consume-second"), limits, origin)
	_, current := nativeKnownRetirement(t, next)
	if r, err := NewAfterRetirement(context.Background(), root, nativeRetirementScope(root, "consume-third"), limits, origin); r != nil || !errors.Is(err, Refused) {
		t.Fatal("consumed older proof admitted another incarnation", err)
	}
	_, after := nativeRetirementPublication(t, root, limits)
	if after != current.PublicationDigest {
		t.Fatal("stale-proof refusal changed latest retirement")
	}
}

func nativePriorIncarnation(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 16}
	first := nativeRetirementScope(root, "reuse-first")
	_, owner := nativeRetirementOwner(t, root, first, limits)
	origin, _ := nativeKnownRetirement(t, owner)
	_, next := nativeEmptySuccessor(t, root, nativeRetirementScope(root, "reuse-second"), limits, origin)
	latestOrigin, current := nativeKnownRetirement(t, next)
	if r, err := NewAfterRetirement(context.Background(), root, first, limits, latestOrigin); r != nil || !errors.Is(err, Refused) {
		t.Fatal("prior incarnation tombstone was reused", err)
	}
	_, after := nativeRetirementPublication(t, root, limits)
	if after != current.PublicationDigest {
		t.Fatal("tombstone refusal changed latest publication")
	}
}

func nativeTombstoneBudget(t *testing.T) {
	root := nativeRetirementRoot(t)
	limits := Limits{Bytes: 1024 * 1024, Records: 3}
	_, owner := nativeRetirementOwner(t, root, nativeRetirementScope(root, "budget-first"), limits)
	for _, generation := range []string{"budget-second", "budget-third"} {
		origin, _ := nativeKnownRetirement(t, owner)
		_, owner = nativeEmptySuccessor(t, root, nativeRetirementScope(root, generation), limits, origin)
	}
	origin, current := nativeKnownRetirement(t, owner)
	if r, err := NewAfterRetirement(context.Background(), root, nativeRetirementScope(root, "budget-fourth"), limits, origin); r != nil || !errors.Is(err, Refused) {
		t.Fatal("saturated tombstones were evicted", err)
	}
	value, after := nativeRetirementPublication(t, root, limits)
	if after != current.PublicationDigest || len(value.Incarnations) != 3 || value.Incarnations[0] != "budget-first" || value.Incarnations[2] != "budget-third" {
		t.Fatal("budget refusal lost retained incarnation fence")
	}
}
