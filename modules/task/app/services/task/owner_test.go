package task

// The existing atomic memory journal is policy evidence only. These tests do
// not prove filesystem durability, host/process lifetime or provider capability.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	admissioncap "github.com/legrch/farol/modules/task/app/capabilities/admission"
	"github.com/legrch/farol/modules/task/app/port"
	admissioncontract "github.com/legrch/farol/modules/task/contracts/admission"
	"github.com/legrch/farol/modules/task/domain"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

func selection(epoch uint64, turn string) port.CurrentBinding {
	return port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task-1", TaskEpoch: epoch, ParticipantID: "coding-participant", TurnID: turn}
}
func ownedService(t *testing.T, r *taskrepo.Route, a *fakeAuthority, f *fakeProvider, d *fakeDelivery) *Service {
	t.Helper()
	s, err := NewOwned(r, a, map[task.Provider]port.Provider{a.binding.Provider: f}, d, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func ownerRoute(t *testing.T, j port.AdmissionJournal) (*taskrepo.Owner, *taskrepo.Route) {
	t.Helper()
	o, err := taskrepo.New(j, "task-1")
	if err != nil {
		t.Fatal(err)
	}
	r, err := o.Select(selection(1, "initiating-turn"))
	if err != nil {
		t.Fatal(err)
	}
	return o, r
}
func current(r port.CurrentTaskAdmission) (*port.CurrentBinding, error) {
	var out *port.CurrentBinding
	err := r.WithCurrent(ctx, func(b *port.CurrentBinding) error {
		if b != nil {
			copy := *b
			out = &copy
		}
		return nil
	})
	return out, err
}
func requireAbsent(t *testing.T, r port.CurrentTaskAdmission, unavailable bool) {
	t.Helper()
	b, err := current(r)
	if b != nil || (unavailable && !errors.Is(err, task.ErrUnavailable)) || (!unavailable && err != nil) {
		t.Fatalf("admission=%+v error=%v unavailable=%v", b, err, unavailable)
	}
}
func requireActive(t *testing.T, r *taskrepo.Route) {
	t.Helper()
	b, err := current(r)
	if err != nil || b == nil || *b != r.Selection() {
		t.Fatalf("admission=%+v error=%v", b, err)
	}
}
func await(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("test-owned writer did not reach barrier")
	}
}
func awaitError(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("test-owned writer did not return")
		return nil
	}
}

type blockedJournal struct {
	*fakeJournal
	admit, finish, invalidate    bool
	entered, release             chan struct{}
	revokeEntered, revokeRelease chan struct{}
}

func (j *blockedJournal) Admit(c context.Context, i task.Intent, v uint64, next task.Task) (*port.Admission, error) {
	if j.admit {
		close(j.entered)
		<-j.release
	}
	return j.fakeJournal.Admit(c, i, v, next)
}
func (j *blockedJournal) Finish(c context.Context, id string, receipt task.Receipt, next task.Task) error {
	if j.finish {
		close(j.entered)
		<-j.release
	}
	return j.fakeJournal.Finish(c, id, receipt, next)
}
func (j *blockedJournal) Invalidate(c context.Context, before port.Snapshot) error {
	if j.invalidate {
		close(j.revokeEntered)
		<-j.revokeRelease
	}
	return j.fakeJournal.Invalidate(c, before)
}

func TestOwnedAdmissionPublishesOnlyAfterSettledIntentAndClosesOnResult(t *testing.T) {
	for _, provider := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(provider), func(t *testing.T) {
			_, j, a, f, d := setup(provider)
			store := &blockedJournal{fakeJournal: j, admit: true, entered: make(chan struct{}), release: make(chan struct{})}
			_, r := ownerRoute(t, store)
			s := ownedService(t, r, a, f, d)
			requireAbsent(t, r, false)
			// The published contract and service use the same owning route.
			controller, err := admissioncap.New(r, r.Selection())
			if err != nil {
				t.Fatal(err)
			}
			contract := admissioncontract.New(controller)
			f.dispatch = func(func(task.Reference) error) {
				if err := contract.WithCurrent(ctx, func(b *admissioncontract.Binding) error {
					if b == nil || b.TaskID != "task-1" || b.TurnID != "initiating-turn" || b.SessionID != "authority-session" {
						return task.ErrIdentity
					}
					b.TurnID = "mutated-copy"
					return nil
				}); err != nil {
					t.Errorf("published contract: %v", err)
				}
			}
			done := make(chan error, 1)
			go func() { _, err := s.Create(ctx, request(provider)); done <- err }()
			await(t, store.entered)
			// This no-IO inspection must complete while the journal is blocked.
			requireAbsent(t, r, true)
			close(store.release)
			if err := awaitError(t, done); err != nil {
				t.Fatal(err)
			}
			requireActive(t, r)
			before, _ := j.Read(ctx, "task-1")
			if before.Task.Admission.State != task.AdmissionActive || before.Task.Reference.SessionID == before.Task.Admission.Binding.SessionID {
				t.Fatal("admission and provider lineage mixed")
			}
			complete(t, s)
			requireAbsent(t, r, false)
			after, _ := j.Read(ctx, "task-1")
			if after.Task.Admission.State != task.AdmissionClosed || after.Task.DispatchID != "create-1" {
				t.Fatalf("terminal publication: %+v", after)
			}
		})
	}
}

func TestOwnedUnknownWindowsNeverReactivateFromReadOrReplay(t *testing.T) {
	for _, window := range []string{"admit", "dispatch", "finish", "progress"} {
		t.Run(window, func(t *testing.T) {
			_, j, a, f, d := setup(task.Codex)
			_, r := ownerRoute(t, j)
			s := ownedService(t, r, a, f, d)
			switch window {
			case "admit":
				j.failAdmit = true
			case "dispatch":
				f.dispatchErr = errors.New("unknown provider outcome")
			case "finish":
				j.failFinish = true
			case "progress":
				j.failProgress = true
				f.progress = []task.Reference{{ThreadID: "thread"}}
				f.ignoreProgressError = true
			}
			_, _ = s.Create(ctx, request(task.Codex))
			requireAbsent(t, r, true)
			calls := f.calls
			_, _ = s.Operation(ctx, OperationRequest{"create-1"})
			_, _ = s.Status(ctx, StatusRequest{"task-1"})
			_, _ = s.Create(ctx, request(task.Codex))
			if f.calls != calls {
				t.Fatal("unknown outcome retried")
			}
			// A settled status read can close the fence to known absence; it
			// never creates a positive projection, even after an ACK loss.
			if b, _ := current(r); b != nil {
				t.Fatal("read/replay reactivated admission")
			}
		})
	}
}

func TestRestartDoesNotRestorePersistedPositiveAdmission(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	_, old := ownerRoute(t, j)
	create(t, ownedService(t, old, a, f, d), task.Codex)
	_, restarted := ownerRoute(t, j)
	s := ownedService(t, restarted, a, f, d)
	requireAbsent(t, restarted, false)
	f.observation.Lifecycle, f.observation.Result = task.Running, ""
	_, _ = s.Operation(ctx, OperationRequest{"create-1"})
	_, _ = s.Status(ctx, StatusRequest{"task-1"})
	create(t, s, task.Codex) // Read receipt, not another provider dispatch.
	requireAbsent(t, restarted, false)
	if f.calls != 1 {
		t.Fatal("restart dispatched provider")
	}
	if _, err := s.Control(ctx, MutationRequest{"steer", "task-1", "steer", task.Message}); err == nil {
		t.Fatal("retained active snapshot admitted steering after restart")
	}
}

func TestFreshFollowupSelectionCannotResurrectOrAffectOldTurn(t *testing.T) {
	for _, provider := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(provider), func(t *testing.T) {
			_, j, a, f, d := setup(provider)
			o, old := ownerRoute(t, j)
			s := ownedService(t, old, a, f, d)
			create(t, s, provider)
			complete(t, s)
			before, _ := j.Read(ctx, "task-1")
			r, err := o.Select(selection(2, "followup-turn"))
			if err != nil {
				t.Fatal(err)
			}
			followup := ownedService(t, r, a, f, d)
			f.receipt.Reference = reference(provider, "turn-2")
			action := task.Continue
			if provider == task.Claude {
				action = task.Resume
			}
			if _, err := followup.Control(ctx, MutationRequest{"follow-up", "task-1", "follow up", action}); err != nil {
				t.Fatal(err)
			}
			requireActive(t, r)
			next := before.Task
			next.Lifecycle, next.Admission.State = task.Running, task.AdmissionActive
			if err := old.Observe(ctx, *before, next); err == nil {
				t.Fatal("old observation accepted")
			}
			old.Fence()
			if err := old.Revoke(ctx); err == nil {
				t.Fatal("old route revoked new turn")
			}
			requireActive(t, r)
			persisted, _ := j.Read(ctx, "task-1")
			if persisted.Task.Admission.Binding.TaskEpoch != 2 || persisted.Task.Reference != f.receipt.Reference {
				t.Fatalf("followup identity: %+v", persisted)
			}
		})
	}
}

func TestRevokeInvalidatesBeforeIOAndPreservesProviderEvidence(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	store := &blockedJournal{fakeJournal: j, invalidate: true, revokeEntered: make(chan struct{}), revokeRelease: make(chan struct{})}
	_, r := ownerRoute(t, store)
	s := ownedService(t, r, a, f, d)
	create(t, s, task.Codex)
	before, _ := j.Read(ctx, "task-1")
	done := make(chan error, 1)
	go func() { done <- r.Revoke(ctx) }()
	await(t, store.revokeEntered)
	requireAbsent(t, r, true) // Gate is free while persistence is blocked.
	close(store.revokeRelease)
	if err := awaitError(t, done); err != nil {
		t.Fatal(err)
	}
	requireAbsent(t, r, false)
	after, _ := j.Read(ctx, "task-1")
	if after.Task.Admission.State != task.AdmissionRevoked || after.Task.Reference != before.Task.Reference || after.Task.Lifecycle != task.Running || after.Pending != before.Pending {
		t.Fatalf("revoke changed provider evidence: %+v", after)
	}
	f.observation.Lifecycle, f.observation.Result = task.Running, ""
	_, _ = s.Status(ctx, StatusRequest{"task-1"})
	requireAbsent(t, r, false)
	if _, err := s.Control(ctx, MutationRequest{"steer", "task-1", "steer", task.Message}); err == nil {
		t.Fatal("revoked task admitted steering")
	}
}

func TestInFlightCompletionCannotPublishAfterFenceOrOverwriteRevoke(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	store := &blockedJournal{fakeJournal: j, finish: true, entered: make(chan struct{}), release: make(chan struct{}), invalidate: true, revokeEntered: make(chan struct{}), revokeRelease: make(chan struct{})}
	_, r := ownerRoute(t, store)
	s := ownedService(t, r, a, f, d)
	done := make(chan error, 1)
	go func() { _, err := s.Create(ctx, request(task.Codex)); done <- err }()
	await(t, store.entered)
	r.Fence() // Invalidate the publication token before releasing the writer.
	revoked := make(chan error, 1)
	go func() { revoked <- r.Revoke(ctx) }()
	close(store.release)
	if err := awaitError(t, done); err != nil {
		t.Fatal(err)
	}
	await(t, store.revokeEntered)
	if b, _ := current(r); b != nil {
		t.Fatal("late settled running receipt restored positive admission")
	}
	close(store.revokeRelease)
	if err := awaitError(t, revoked); err != nil {
		t.Fatal(err)
	}
	requireAbsent(t, r, false)
	persisted, _ := j.Read(ctx, "task-1")
	if persisted.Task.Admission.State != task.AdmissionRevoked {
		t.Fatalf("revoke lost: %+v", persisted)
	}
}

func TestPendingCompletionRetainsAlreadyDurableRevoke(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	_, r := ownerRoute(t, j)
	s := ownedService(t, r, a, f, d)
	// Revoke within the sole provider effect, after its launch intention was
	// settled but before the known running receipt reaches Finish.
	f.dispatch = func(func(task.Reference) error) {
		if err := r.Revoke(ctx); err != nil {
			t.Error(err)
		}
	}
	create(t, s, task.Codex)
	requireAbsent(t, r, false)
	snap, _ := j.Read(ctx, "task-1")
	op, _ := j.Lookup(ctx, "create-1")
	if snap.Task.Admission.State != task.AdmissionRevoked || snap.Pending != "" || !op.Settled || op.Receipt.State != task.Known {
		t.Fatalf("late finish: %+v %+v", snap, op)
	}
}

func TestRevokeDuringUnsettledAdmissionPreventsProviderCall(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	store := &blockedJournal{fakeJournal: j, admit: true, entered: make(chan struct{}), release: make(chan struct{})}
	_, r := ownerRoute(t, store)
	s := ownedService(t, r, a, f, d)
	done := make(chan error, 1)
	go func() { _, err := s.Create(ctx, request(task.Codex)); done <- err }()
	await(t, store.entered)
	r.Fence()
	close(store.release)
	if err := awaitError(t, done); !errors.Is(err, task.ErrUnknown) {
		t.Fatalf("unsettled launch: %v", err)
	}
	if f.calls != 0 {
		t.Fatal("fenced launch called provider")
	}
	if b, _ := current(r); b != nil {
		t.Fatal("stale admission completion restored positive")
	}
	if err := r.Revoke(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorityDenialAndLostRevokeACKRemainFenced(t *testing.T) {
	for _, window := range []string{"authority", "revoke"} {
		t.Run(window, func(t *testing.T) {
			_, j, a, f, d := setup(task.Codex)
			_, r := ownerRoute(t, j)
			s := ownedService(t, r, a, f, d)
			create(t, s, task.Codex)
			if window == "authority" {
				a.denied = true
				if _, err := s.Status(ctx, StatusRequest{"task-1"}); err == nil {
					t.Fatal("authority denial ignored")
				}
			} else {
				j.failFinish = true
				if err := r.Revoke(ctx); err == nil {
					t.Fatal("lost revoke ACK ignored")
				}
			}
			requireAbsent(t, r, true)
			_, _ = r.Read(ctx, "task-1")
			_, _ = r.Lookup(ctx, "create-1")
			requireAbsent(t, r, true)
		})
	}
}

func TestCancelClosesAdmissionWithoutClaimingProviderTermination(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	_, r := ownerRoute(t, j)
	s := ownedService(t, r, a, f, d)
	create(t, s, task.Codex)
	f.receipt.CancelRequested = true
	f.dispatch = func(func(task.Reference) error) { requireAbsent(t, r, false) }
	result, err := s.Control(ctx, MutationRequest{OperationID: "cancel", TaskID: "task-1", Action: task.Cancel})
	if err != nil || !result.Receipt.CancelRequested {
		t.Fatalf("cancel: %+v %v", result, err)
	}
	requireAbsent(t, r, false)
	snap, _ := j.Read(ctx, "task-1")
	if snap.Task.Lifecycle != task.Running || snap.Task.Admission.State != task.AdmissionRevoked {
		t.Fatalf("cancel treated as terminal: %+v", snap)
	}
}

func TestPrelaunchRevokeAndUnownedConstructorCannotIssueAdmission(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	_, r := ownerRoute(t, j)
	if err := r.Revoke(ctx); !errors.Is(err, task.ErrNotFound) {
		t.Fatal(err)
	}
	_, _ = ownedService(t, r, a, f, d).Create(ctx, request(task.Codex))
	if f.calls != 0 {
		t.Fatal("closed prelaunch epoch reused")
	}
	requireAbsent(t, r, true)
	_, other := ownerRoute(t, journal())
	s := newService(other, a, map[task.Provider]port.Provider{task.Codex: f}, d)
	_, _ = s.Create(ctx, request(task.Codex))
	if f.calls != 0 {
		t.Fatal("unowned service used owning journal")
	}
	requireAbsent(t, other, false)
}

func TestLegacyIntentFingerprintRemainsCompatible(t *testing.T) {
	i := task.Intent{OperationID: "create-1", TaskID: "task-1", Action: task.Create, Binding: binding(task.Codex), Parent: request(task.Codex).Parent}
	// This is the previously published persistent intention schema. Admission
	// must be absent for old preparation entries, including field order.
	legacy := struct {
		OperationID, TaskID, Digest string
		Action                      task.Action
		Binding                     task.Binding
		Parent                      task.Parent
		Expected                    task.Reference
	}{i.OperationID, i.TaskID, i.Digest, i.Action, i.Binding, i.Parent, i.Expected}
	want, _ := json.Marshal(struct {
		Intent  any
		Message string
	}{legacy, "bounded task"})
	s, _, _, _, _ := setup(task.Codex)
	if got := s.digest(i, "bounded task"); got != intent.Fingerprint(want) {
		t.Fatalf("legacy intention fingerprint changed: %s", got)
	}
	i.Admission = task.AdmissionBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task-1", TaskEpoch: 1, ParticipantID: "coding-participant", TurnID: "initiating-turn"}
	if s.digest(i, "bounded task") == intent.Fingerprint(want) {
		t.Fatal("owned intention omitted admission identity")
	}
}

func ExampleNewOwned() {
	// Concrete composition using a memory fixture, not production IO evidence.
	j := journal()
	o, _ := taskrepo.New(j, "task-1")
	r, _ := o.Select(selection(1, "initiating-turn"))
	a := &fakeAuthority{binding: binding(task.Codex)}
	f := &fakeProvider{caps: task.Capabilities{Create: true}, receipt: task.Receipt{State: task.Known, Reference: reference(task.Codex, "turn-1"), Lifecycle: task.Running}, observation: port.Observation{Reference: reference(task.Codex, "turn-1"), Lifecycle: task.Completed, Result: "final"}}
	s, _ := NewOwned(r, a, map[task.Provider]port.Provider{task.Codex: f}, nil, intent.Fingerprint, providerclient.NewProgress)
	controller, _ := admissioncap.New(r, r.Selection())
	contract := admissioncontract.New(controller)
	show := func() {
		_ = contract.WithCurrent(ctx, func(b *admissioncontract.Binding) error { fmt.Println(b != nil); return nil })
	}
	show()
	req := request(task.Codex)
	req.Parent = task.Parent{}
	_, _ = s.Create(ctx, req)
	show()
	_, _ = s.Result(ctx, ResultRequest{"task-1"})
	show()
	// Output:
	// false
	// true
	// false
}

// WithCurrent must not call the backing journal, even when an active value is
// required. Reads here are deliberately unavailable after launch publication.
type inspectionJournal struct {
	*fakeJournal
	forbidReads bool
}

func (j *inspectionJournal) Read(c context.Context, id string) (*port.Snapshot, error) {
	if j.forbidReads {
		return nil, task.ErrUnavailable
	}
	return j.fakeJournal.Read(c, id)
}
func (j *inspectionJournal) Lookup(c context.Context, id string) (*port.Operation, error) {
	if j.forbidReads {
		return nil, task.ErrUnavailable
	}
	return j.fakeJournal.Lookup(c, id)
}
func TestCurrentInspectionDoesNotUseJournalAndSerializesRevoke(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	store := &inspectionJournal{fakeJournal: j}
	_, r := ownerRoute(t, store)
	create(t, ownedService(t, r, a, f, d), task.Codex)
	store.forbidReads = true
	requireActive(t, r)
	store.forbidReads = false
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- r.WithCurrent(ctx, func(b *port.CurrentBinding) error {
			if b == nil {
				return task.ErrState
			}
			close(entered)
			<-release
			if *b != r.Selection() {
				return task.ErrIdentity
			}
			return nil
		})
	}()
	await(t, entered)
	revoked := make(chan error, 1)
	go func() { revoked <- r.Revoke(ctx) }()
	// Revoke may wait only on this no-IO callback before persistence. Once the
	// callback returns, the caller can perform a separate Computer update.
	close(release)
	if err := awaitError(t, done); err != nil {
		t.Fatal(err)
	}
	if err := awaitError(t, revoked); err != nil {
		t.Fatal(err)
	}
	requireAbsent(t, r, false)
}

func TestLostTerminalPublicationClosesCurrentAdmission(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	_, r := ownerRoute(t, j)
	s := ownedService(t, r, a, f, d)
	create(t, s, task.Codex)
	j.failObserve = true
	if _, err := s.Result(ctx, ResultRequest{"task-1"}); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	requireAbsent(t, r, true)
	if f.calls != 1 {
		t.Fatal("observation dispatched a second task")
	}
}

type corruptAdmissionJournal struct {
	*fakeJournal
	change func(*port.Admission)
}

func (j *corruptAdmissionJournal) Admit(c context.Context, i task.Intent, v uint64, next task.Task) (*port.Admission, error) {
	out, err := j.fakeJournal.Admit(c, i, v, next)
	if err == nil {
		j.change(out)
	}
	return out, err
}
func TestMalformedPersistenceAcknowledgementCannotAdmitProviderEffect(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*port.Admission)
	}{
		{"task", func(a *port.Admission) { a.Snapshot.Task.ID = "different-task" }},
		{"binding", func(a *port.Admission) { a.Snapshot.Task.Binding.Model = "different-model" }},
		{"pending", func(a *port.Admission) { a.Snapshot.Pending = "" }},
		{"revision", func(a *port.Admission) { a.Snapshot.Revision = 0 }},
		{"settled", func(a *port.Admission) { a.Operation.Settled = true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, j, a, f, d := setup(task.Codex)
			_, r := ownerRoute(t, &corruptAdmissionJournal{j, test.change})
			_, err := ownedService(t, r, a, f, d).Create(ctx, request(task.Codex))
			if !errors.Is(err, task.ErrUnknown) || f.calls != 0 {
				t.Fatalf("malformed admission: %v calls=%d", err, f.calls)
			}
			requireAbsent(t, r, true)
		})
	}
}

func TestRejectedProgressClosesAdmissionBeforeProviderReturns(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	_, r := ownerRoute(t, j)
	s := ownedService(t, r, a, f, d)
	f.dispatch = func(progress func(task.Reference) error) {
		// The provider ignores a contradictory lineage callback. Its later known
		// receipt cannot keep native admission open in the intervening window.
		if err := progress(task.Reference{SessionID: "foreign-session"}); !errors.Is(err, task.ErrIdentity) {
			t.Error(err)
		}
		requireAbsent(t, r, true)
	}
	result, err := s.Create(ctx, request(task.Codex))
	if err != nil || result.Receipt.State != task.Uncertain {
		t.Fatalf("invalid progress: %+v %v", result, err)
	}
	requireAbsent(t, r, true)
	op, _ := j.Lookup(ctx, "create-1")
	if op.Settled || op.Lineage != (task.Reference{}) {
		t.Fatalf("contradiction settled: %+v", op)
	}
}

func TestOwnedContinueExactRequiresFreshEpochAndKeepsProviderLineage(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	o, old := ownerRoute(t, j)
	s := ownedService(t, old, a, f, d)
	create(t, s, task.Codex)
	complete(t, s)
	req := ContinueExactRequest{"follow-up", "task-1", "next", "create-1"}
	if _, err := s.ContinueExact(ctx, req); !errors.Is(err, task.ErrState) {
		t.Fatal("closed epoch revived", err)
	}
	if f.calls != 1 {
		t.Fatal(f.calls)
	}
	r, err := o.Select(selection(2, "exact-followup-turn"))
	if err != nil {
		t.Fatal(err)
	}
	followup := ownedService(t, r, a, f, d)
	f.receipt.Reference = reference(task.Codex, "turn-2")
	f.dispatch = func(func(task.Reference) error) {
		op, err := j.Lookup(ctx, req.OperationID)
		if err != nil || op == nil || op.Intent.Expected != reference(task.Codex, "turn-1") || op.Intent.Binding != a.binding || op.Intent.Admission.TaskEpoch != 2 || op.Intent.Admission.TurnID != "exact-followup-turn" || op.Intent.Admission.TurnID == old.Selection().TurnID {
			t.Fatal("exact dispatch or fresh trusted admission changed", op, err)
		}
		requireActive(t, r)
	}
	out, err := followup.ContinueExact(ctx, req)
	if err != nil || out.Receipt.State != task.Known || out.Receipt.Reference.ThreadID != "thread" || out.Receipt.Reference.TurnID != "turn-2" {
		t.Fatal(out, err)
	}
	if _, err := followup.ContinueExact(ctx, req); err != nil || f.calls != 2 {
		t.Fatal("owned replay dispatched", err)
	}
	f.dispatch = nil
	f.observation.Reference = f.receipt.Reference
	complete(t, followup)
	third, err := o.Select(selection(3, "third-farol-turn"))
	if err != nil {
		t.Fatal(err)
	}
	thirdService := ownedService(t, third, a, f, d)
	if _, err := thirdService.ContinueExact(ctx, ContinueExactRequest{"third", "task-1", "next", "create-1"}); !errors.Is(err, task.ErrIdentity) {
		t.Fatal("old parent replaced with latest", err)
	}
	if f.calls != 2 {
		t.Fatal(f.calls)
	}
	f.receipt.Reference = reference(task.Codex, "turn-3")
	out, err = thirdService.ContinueExact(ctx, ContinueExactRequest{"third", "task-1", "next", "follow-up"})
	if err != nil || out.Receipt.Reference != reference(task.Codex, "turn-3") || f.calls != 3 {
		t.Fatal(out, err)
	}
	stored, _ := j.Read(ctx, "task-1")
	if stored.Task.DispatchID != "third" || stored.Task.Binding != a.binding || stored.Task.Admission.Binding.TaskEpoch != 3 {
		t.Fatal(stored)
	}
}

func TestOwnedContinueExactUnknownDoesNotReactivateAdmission(t *testing.T) {
	_, j, a, f, d := setup(task.Codex)
	o, old := ownerRoute(t, j)
	s := ownedService(t, old, a, f, d)
	create(t, s, task.Codex)
	complete(t, s)
	r, err := o.Select(selection(2, "unknown-followup-turn"))
	if err != nil {
		t.Fatal(err)
	}
	followup := ownedService(t, r, a, f, d)
	f.receipt.Reference = reference(task.Codex, "turn-2")
	f.progress = []task.Reference{f.receipt.Reference}
	f.dispatchErr = errors.New("lost followup acknowledgement")
	req := ContinueExactRequest{"follow-up", "task-1", "next", "create-1"}
	out, err := followup.ContinueExact(ctx, req)
	if err != nil || out.Receipt.State != task.Uncertain {
		t.Fatal(out, err)
	}
	requireAbsent(t, r, true)
	if replay, err := followup.ContinueExact(ctx, req); err != nil || replay.Receipt.State != task.Uncertain {
		t.Fatal(replay, err)
	}
	requireAbsent(t, r, true)
	third, err := o.Select(selection(3, "cannot-replay-turn"))
	if err != nil {
		t.Fatal(err)
	}
	thirdService := ownedService(t, third, a, f, d)
	if _, err := thirdService.ContinueExact(ctx, ContinueExactRequest{"new-key", "task-1", "next", "create-1"}); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("pending work replayed under fresh epoch", err)
	}
	if f.calls != 2 {
		t.Fatal("unknown effect duplicated", f.calls)
	}
	op, _ := j.Lookup(ctx, req.OperationID)
	if op.Settled || op.Lineage != reference(task.Codex, "turn-2") || op.Intent.Admission.TaskEpoch != 2 {
		t.Fatal(op)
	}
}

func TestOwnedResumeExactRequiresFreshEpochSameSessionNewInvocation(t *testing.T) {
	_, j, a, f, d := setup(task.Claude)
	o, old := ownerRoute(t, j)
	s := ownedService(t, old, a, f, d)
	create(t, s, task.Claude)
	complete(t, s)
	req := ResumeExactRequest{"follow-up", "task-1", "next", "create-1"}
	if _, err := s.ResumeExact(ctx, req); !errors.Is(err, task.ErrState) || f.calls != 1 {
		t.Fatal("closed epoch revived", err, f.calls)
	}
	r, err := o.Select(selection(2, "exact-resume-turn"))
	if err != nil {
		t.Fatal(err)
	}
	followup := ownedService(t, r, a, f, d)
	f.receipt.Reference = reference(task.Claude, "turn-2")
	f.progress = []task.Reference{f.receipt.Reference}
	f.dispatch = func(func(task.Reference) error) {
		op, err := j.Lookup(ctx, req.OperationID)
		if err != nil || op == nil || op.Intent.Action != task.Resume || op.Intent.Expected != reference(task.Claude, "turn-1") || op.Intent.Binding != a.binding || op.Intent.Admission.TaskEpoch != 2 || op.Intent.Admission.TurnID != "exact-resume-turn" || op.Intent.Admission.TurnID == old.Selection().TurnID {
			t.Fatal("resume changed selection/session or fresh admission", op, err)
		}
		requireActive(t, r)
	}
	out, err := followup.ResumeExact(ctx, req)
	if err != nil || out.Receipt.State != task.Known || out.Receipt.Reference.SessionID != "session" || out.Receipt.Reference.InvocationID != req.OperationID {
		t.Fatal(out, err)
	}
	requireActive(t, r)
	if replay, err := followup.ResumeExact(ctx, req); err != nil || *replay != *out || f.calls != 2 {
		t.Fatal("owned exact resume replay dispatched", replay, err)
	}
	f.dispatch = nil
	f.observation.Reference = f.receipt.Reference
	complete(t, followup)
	requireAbsent(t, r, false)
	stored, _ := j.Read(ctx, "task-1")
	if stored.Task.DispatchID != req.OperationID || stored.Task.Binding != a.binding || stored.Task.Admission.Binding.TaskEpoch != 2 || stored.Task.Reference != out.Receipt.Reference {
		t.Fatal(stored)
	}
}

func TestOwnedResumeExactUnknownDoesNotRegrantOrRepeatInvocation(t *testing.T) {
	_, j, a, f, d := setup(task.Claude)
	o, old := ownerRoute(t, j)
	s := ownedService(t, old, a, f, d)
	create(t, s, task.Claude)
	complete(t, s)
	r, err := o.Select(selection(2, "unknown-resume-turn"))
	if err != nil {
		t.Fatal(err)
	}
	followup := ownedService(t, r, a, f, d)
	f.receipt.Reference = reference(task.Claude, "turn-2")
	f.progress = []task.Reference{f.receipt.Reference}
	f.dispatchErr = errors.New("lost resume acknowledgement")
	req := ResumeExactRequest{"follow-up", "task-1", "next", "create-1"}
	out, err := followup.ResumeExact(ctx, req)
	if err != nil || out.Receipt.State != task.Uncertain {
		t.Fatal(out, err)
	}
	requireAbsent(t, r, true)
	if replay, err := followup.ResumeExact(ctx, req); err != nil || replay.Receipt.State != task.Uncertain {
		t.Fatal(replay, err)
	}
	third, err := o.Select(selection(3, "cannot-repeat-resume"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ownedService(t, third, a, f, d).ResumeExact(ctx, ResumeExactRequest{"new-key", "task-1", "next", "create-1"}); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("unknown resume admitted under higher epoch", err)
	}
	op, _ := j.Lookup(ctx, req.OperationID)
	if op.Settled || op.Lineage != reference(task.Claude, "turn-2") || op.Intent.Admission.TaskEpoch != 2 || f.calls != 2 {
		t.Fatal("unknown resume duplicated or settled", op, f.calls)
	}
}
