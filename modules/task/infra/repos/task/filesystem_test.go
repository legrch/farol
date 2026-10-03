package task

// In-memory storage proves journal logic only, not fsync, native filesystem,
// locking, host/process/provider lifetime or installed-state acceptance.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/domain"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

var filesystemCtx = context.Background()

type filesystemMemory struct {
	data                             []byte
	uncertain, failBefore, failAfter bool
	writes                           int
}

func (m *filesystemMemory) Read() ([]byte, bool, error) { return bytes.Clone(m.data), m.uncertain, nil }
func (m *filesystemMemory) Publish(data []byte) error {
	m.writes++
	if m.failBefore {
		m.uncertain = true
		return task.ErrUnknown
	}
	m.data = bytes.Clone(data)
	if m.failAfter {
		m.uncertain = true
		return task.ErrUnknown
	}
	return nil
}
func (*filesystemMemory) Close() error { return nil }
func filesystemFixture(t *testing.T) (*Filesystem, *filesystemMemory) {
	t.Helper()
	data, err := filesystemEncode(filesystemEmpty("dev"))
	if err != nil {
		t.Fatal(err)
	}
	m := &filesystemMemory{data: data}
	j, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	return j, m
}
func filesystemBinding(p task.Provider) task.Binding {
	return task.Binding{Provider: p, ProfileID: "dev", HostID: "host", ProjectID: "project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected", Model: "selected-model", Effort: "high", ConfigDigest: "config"}
}
func filesystemCreate(p task.Provider) (task.Intent, task.Task) {
	i := task.Intent{OperationID: "create", TaskID: "task", Action: task.Create, Binding: filesystemBinding(p), Parent: task.Parent{ThreadID: "parent", TurnID: "parent-turn"}, Admission: task.AdmissionBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "farol-turn"}, Digest: strings.Repeat("a", 64)}
	return i, task.Task{ID: i.TaskID, Binding: i.Binding, Parent: i.Parent, Lifecycle: task.Unknown, Admission: task.ExecutionAdmission{Binding: i.Admission, State: task.AdmissionActive}}
}
func filesystemReference(p task.Provider, id string) task.Reference {
	if p == task.Codex {
		return task.Reference{ThreadID: "thread", TurnID: id}
	}
	return task.Reference{SessionID: "session", InvocationID: id}
}
func filesystemLaunch(t *testing.T, j *Filesystem, p task.Provider) task.Task {
	t.Helper()
	i, next := filesystemCreate(p)
	a, err := j.Admit(filesystemCtx, i, 0, next)
	if err != nil || !a.Claimed {
		t.Fatalf("admit: %+v %v", a, err)
	}
	ref := filesystemReference(p, i.OperationID)
	if err := j.Progress(filesystemCtx, i.OperationID, ref); err != nil {
		t.Fatal(err)
	}
	next.Reference, next.Lifecycle, next.DispatchID = ref, task.Running, i.OperationID
	if err := j.Finish(filesystemCtx, i.OperationID, task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, next); err != nil {
		t.Fatal(err)
	}
	return next
}
func filesystemComplete(t *testing.T, j *Filesystem) task.Task {
	t.Helper()
	before, err := j.Read(filesystemCtx, "task")
	if err != nil {
		t.Fatal(err)
	}
	next := before.Task
	next.Lifecycle, next.Result = task.Completed, "retained first result"
	if next.Admission.State != task.AdmissionRevoked {
		next.Admission.State = task.AdmissionClosed
	}
	if err := j.Observe(filesystemCtx, *before, next); err != nil {
		t.Fatal(err)
	}
	return next
}
func TestFilesystemLogicIntentionClaimsAndReplay(t *testing.T) {
	j, m := filesystemFixture(t)
	i, next := filesystemCreate(task.Codex)
	var wg sync.WaitGroup
	var mu sync.Mutex
	claims := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := j.Admit(filesystemCtx, i, 0, next)
			if err != nil {
				t.Error(err)
				return
			}
			if a.Claimed {
				mu.Lock()
				claims++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if claims != 1 || m.writes != 1 {
		t.Fatalf("claims=%d writes=%d", claims, m.writes)
	}
	a, err := j.Admit(filesystemCtx, i, 0, next)
	if err != nil || a.Claimed || a.Operation.Settled || a.Snapshot.Pending != i.OperationID {
		t.Fatalf("replay: %+v %v", a, err)
	}
	other := i
	other.Digest = strings.Repeat("b", 64)
	if _, err := j.Admit(filesystemCtx, other, 0, next); !errors.Is(err, task.ErrConflict) {
		t.Fatal(err)
	}
	other = i
	other.OperationID = "different-key"
	if _, err := j.Admit(filesystemCtx, other, 1, next); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
}
func TestFilesystemLogicUnknownPublicationFencesWrites(t *testing.T) {
	for _, after := range []bool{false, true} {
		name := "before-image"
		if after {
			name = "after-image"
		}
		t.Run(name, func(t *testing.T) {
			j, m := filesystemFixture(t)
			i, next := filesystemCreate(task.Codex)
			m.failBefore, m.failAfter = !after, after
			if _, err := j.Admit(filesystemCtx, i, 0, next); !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			op, err := j.Lookup(filesystemCtx, i.OperationID)
			if after {
				if err != nil || op == nil || op.Settled {
					t.Fatalf("retained: %+v %v", op, err)
				}
			} else if !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			if _, err := j.Lookup(filesystemCtx, "new-key"); !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			m.failBefore, m.failAfter, m.uncertain = false, false, false
			other := i
			other.OperationID = "new-key"
			if _, err := j.Admit(filesystemCtx, other, 0, next); !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			if m.writes != 1 {
				t.Fatal("publication retried")
			}
		})
	}
}
func TestFilesystemLogicFinalAndParentACKSurviveLostACK(t *testing.T) {
	j, m := filesystemFixture(t)
	i, next := filesystemCreate(task.Codex)
	if _, err := j.Admit(filesystemCtx, i, 0, next); err != nil {
		t.Fatal(err)
	}
	next.Reference, next.Lifecycle, next.Result, next.DispatchID, next.Admission.State = filesystemReference(task.Codex, "create"), task.Completed, "final", "create", task.AdmissionClosed
	m.failAfter = true
	if err := j.Finish(filesystemCtx, "create", task.Receipt{State: task.Known, Reference: next.Reference, Lifecycle: task.Completed, Result: "final"}, next); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	if op, err := j.Lookup(filesystemCtx, "create"); err != nil || !op.Settled || op.Receipt.Result != "final" {
		t.Fatalf("retained final: %+v %v", op, err)
	}
	if snap, err := j.Read(filesystemCtx, "task"); err != nil || snap.Pending != "" || snap.Task.Result != "final" {
		t.Fatalf("retained snapshot: %+v %v", snap, err)
	}
	reconnected, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if op, err := reconnected.Lookup(filesystemCtx, "create"); err != nil || op.Receipt.Result != "final" {
		t.Fatal(err)
	}
	if err := reconnected.Invalidate(filesystemCtx, port.Snapshot{Task: next}); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	// Parent delivery is a separate intention and acknowledgement.
	j, m = filesystemFixture(t)
	filesystemLaunch(t, j, task.Codex)
	completed := filesystemComplete(t, j)
	before, _ := j.Read(filesystemCtx, "task")
	delivery := i
	delivery.OperationID, delivery.Action, delivery.Expected = "deliver", task.Deliver, completed.Reference
	if _, err := j.Admit(filesystemCtx, delivery, before.Revision, completed); err != nil {
		t.Fatal(err)
	}
	completed.DeliveryDispatchID = completed.DispatchID
	m.failAfter = true
	if err := j.Finish(filesystemCtx, "deliver", task.Receipt{State: task.Known, Reference: completed.Reference}, completed); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	if op, err := j.Lookup(filesystemCtx, "deliver"); err != nil || !op.Settled || op.Intent.Parent.ThreadID != "parent" || op.Receipt.State != task.Known {
		t.Fatalf("retained delivery: %+v %v", op, err)
	}
}
func TestFilesystemLogicFollowupRetainsOldResult(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			j, _ := filesystemFixture(t)
			filesystemLaunch(t, j, p)
			old := filesystemComplete(t, j)
			before, _ := j.Read(filesystemCtx, "task")
			i, _ := filesystemCreate(p)
			i.OperationID, i.Expected, i.Admission.TaskEpoch, i.Admission.TurnID = "followup", old.Reference, 2, "farol-followup"
			i.Action = task.Continue
			if p == task.Claude {
				i.Action = task.Resume
			}
			prepared := old
			prepared.Admission = task.ExecutionAdmission{Binding: i.Admission, State: task.AdmissionActive}
			if _, err := j.Admit(filesystemCtx, i, before.Revision, prepared); err != nil {
				t.Fatal(err)
			}
			pending, _ := j.Read(filesystemCtx, "task")
			if pending.Task.Reference != old.Reference || pending.Task.Result != old.Result || pending.Pending != "followup" {
				t.Fatal("old result lost before followup outcome")
			}
			ref := filesystemReference(p, "followup")
			if err := j.Progress(filesystemCtx, "followup", ref); err != nil {
				t.Fatal(err)
			}
			prepared.Reference, prepared.Lifecycle, prepared.DispatchID, prepared.Result = ref, task.Running, "followup", ""
			if err := j.Finish(filesystemCtx, "followup", task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, prepared); err != nil {
				t.Fatal(err)
			}
			retained, _ := j.Lookup(filesystemCtx, "create")
			if retained.Receipt.Result != old.Result || retained.Receipt.Lifecycle != task.Completed || retained.Receipt.Reference != old.Reference {
				t.Fatalf("old dispatch: %+v", retained)
			}
			if err := j.Observe(filesystemCtx, *before, old); !errors.Is(err, task.ErrConflict) {
				t.Fatal(err)
			}
		})
	}
}
func TestFilesystemLogicProgressRefusalKeepsPending(t *testing.T) {
	j, _ := filesystemFixture(t)
	i, next := filesystemCreate(task.Codex)
	_, _ = j.Admit(filesystemCtx, i, 0, next)
	if err := j.Progress(filesystemCtx, "create", task.Reference{ThreadID: "thread"}); err != nil {
		t.Fatal(err)
	}
	if err := j.Progress(filesystemCtx, "create", task.Reference{ThreadID: "foreign"}); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
	for _, r := range []task.Receipt{{State: task.Uncertain}, {State: task.Rejected, Code: "TASK_PROVIDER_REFUSED"}} {
		if err := j.Finish(filesystemCtx, "create", r, next); !errors.Is(err, task.ErrUnknown) {
			t.Fatal(err)
		}
	}
	snap, _ := j.Read(filesystemCtx, "task")
	op, _ := j.Lookup(filesystemCtx, "create")
	if snap.Pending != "create" || op.Settled || op.Lineage.ThreadID != "thread" {
		t.Fatal("unknown fence released")
	}
}
func TestFilesystemLogicRevokePreservesPendingAndEvidence(t *testing.T) {
	j, _ := filesystemFixture(t)
	i, next := filesystemCreate(task.Codex)
	_, _ = j.Admit(filesystemCtx, i, 0, next)
	before, _ := j.Read(filesystemCtx, "task")
	if err := j.Invalidate(filesystemCtx, *before); err != nil {
		t.Fatal(err)
	}
	if err := j.Invalidate(filesystemCtx, *before); !errors.Is(err, task.ErrConflict) {
		t.Fatal(err)
	}
	revoked, _ := j.Read(filesystemCtx, "task")
	if revoked.Pending != before.Pending || revoked.Task.Reference != before.Task.Reference || revoked.Task.Admission.State != task.AdmissionRevoked {
		t.Fatal("revoke changed provider evidence")
	}
	next.Reference, next.Lifecycle, next.DispatchID = filesystemReference(task.Codex, "create"), task.Running, "create"
	if err := j.Finish(filesystemCtx, "create", task.Receipt{State: task.Known, Reference: next.Reference, Lifecycle: task.Running}, next); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
	next.Admission.State = task.AdmissionRevoked
	if err := j.Finish(filesystemCtx, "create", task.Receipt{State: task.Known, Reference: next.Reference, Lifecycle: task.Running}, next); err != nil {
		t.Fatal(err)
	}
}
func TestFilesystemLogicCorruptPartialAndUnknownFormat(t *testing.T) {
	j, m := filesystemFixture(t)
	filesystemLaunch(t, j, task.Codex)
	valid := bytes.Clone(m.data)
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"empty", nil}, {"partial", valid[:len(valid)/2]}, {"case-alias", bytes.Replace(valid, []byte("Version"), []byte("version"), 1)},
		{"version", bytes.Replace(valid, []byte("Version"), []byte("Future"), 1)},
		{"trailing", append(bytes.Clone(valid), []byte("{}")...)}, {"invalid-utf8", append(bytes.Clone(valid), 0xff)},
	} {
		t.Run(test.name, func(t *testing.T) {
			storage := &filesystemMemory{data: test.data}
			if _, err := newFilesystem(storage, "dev"); !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			if storage.writes != 0 {
				t.Fatal("corruption repaired")
			}
		})
	}
	var envelope filesystemEnvelope
	_ = json.Unmarshal(valid, &envelope)
	op := envelope.Image.Operations["create"]
	op.Intent.TaskID = "missing"
	envelope.Image.Operations["create"] = op
	body, _ := json.Marshal(envelope.Image)
	envelope.SHA256 = filesystemHash(body)
	bad, _ := json.Marshal(envelope)
	bad = append(bad, byte(10))
	if _, err := newFilesystem(&filesystemMemory{data: bad}, "dev"); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("checksum authorized inconsistent state")
	}
}
func TestFilesystemLogicUnknownMarkerMissingAndClose(t *testing.T) {
	j, m := filesystemFixture(t)
	m.uncertain = true
	if op, err := j.Lookup(filesystemCtx, "missing"); op != nil || !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Read(filesystemCtx, "missing"); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	if _, err := newFilesystem(&filesystemMemory{}, "dev"); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("missing canonical image treated as empty")
	}
}

type filesystemAuthority struct{ binding task.Binding }

func (a filesystemAuthority) Resolve(context.Context, port.Selection) (task.Binding, error) {
	return a.binding, nil
}
func (filesystemAuthority) Recheck(context.Context, task.Binding) error      { return nil }
func (filesystemAuthority) RecheckParent(context.Context, task.Parent) error { return nil }

type filesystemProvider struct{ ref task.Reference }

func (filesystemProvider) Supports(context.Context, task.Binding) (task.Capabilities, error) {
	return task.Capabilities{Create: true}, nil
}
func (p filesystemProvider) Dispatch(_ context.Context, _ port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	if err := progress(p.ref); err != nil {
		return task.Receipt{}, err
	}
	return task.Receipt{State: task.Known, Reference: p.ref, Lifecycle: task.Running}, nil
}
func (p filesystemProvider) Observe(context.Context, task.Binding, task.Reference) (port.Observation, error) {
	return port.Observation{Reference: p.ref, Lifecycle: task.Completed, Result: "final"}, nil
}
func TestFilesystemLogicConcreteOwnerComposition(t *testing.T) {
	j, _ := filesystemFixture(t)
	o, _ := New(j, "task")
	r, _ := o.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "farol-turn"})
	binding := filesystemBinding(task.Codex)
	s, err := tasksvc.NewOwned(r, filesystemAuthority{binding}, map[task.Provider]port.Provider{task.Codex: filesystemProvider{filesystemReference(task.Codex, "create")}}, nil, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Create(filesystemCtx, tasksvc.CreateRequest{OperationID: "create", TaskID: "task", Message: "bounded fixture", Selection: port.Selection{Provider: task.Codex, ProjectID: "project", WorkspaceID: "writer", ModelAlias: "selected", Effort: "high"}})
	if err != nil {
		t.Fatal(err)
	}
	var active bool
	if err := r.WithCurrent(filesystemCtx, func(b *port.CurrentBinding) error { active = b != nil; return nil }); err != nil || !active {
		t.Fatal("selected owner did not publish")
	}
	result, err := s.Result(filesystemCtx, tasksvc.ResultRequest{TaskID: "task"})
	if err != nil || !result.Retained || result.Text != "final" {
		t.Fatalf("result: %+v %v", result, err)
	}
	if err := r.WithCurrent(filesystemCtx, func(b *port.CurrentBinding) error { active = b != nil; return nil }); err != nil || active {
		t.Fatal("terminal result did not close owner")
	}
}

func TestFilesystemLogicGlobalOperationBindingAndProfile(t *testing.T) {
	j, m := filesystemFixture(t)
	i, next := filesystemCreate(task.Codex)
	if _, err := j.Admit(filesystemCtx, i, 0, next); err != nil {
		t.Fatal(err)
	}
	other := i
	other.TaskID = "other-task"
	other.Admission.TaskID = "other-task"
	otherNext := next
	otherNext.ID, otherNext.Admission.Binding = other.TaskID, other.Admission
	if _, err := j.Admit(filesystemCtx, other, 0, otherNext); !errors.Is(err, task.ErrConflict) {
		t.Fatal(err)
	}
	other.OperationID = "other-create"
	other.Binding.ProfileID = "other-profile"
	otherNext.Binding = other.Binding
	if _, err := j.Admit(filesystemCtx, other, 0, otherNext); err == nil {
		t.Fatal("journal profile changed")
	}
	if m.writes != 1 {
		t.Fatal("mismatched global operation/profile published")
	}
}
func TestFilesystemLogicDeliveryCannotRepeatOrOverwriteTerminal(t *testing.T) {
	j, _ := filesystemFixture(t)
	filesystemLaunch(t, j, task.Codex)
	terminal := filesystemComplete(t, j)
	before, _ := j.Read(filesystemCtx, "task")
	running := terminal
	running.Lifecycle, running.Result, running.Admission.State = task.Running, "", task.AdmissionActive
	if err := j.Observe(filesystemCtx, *before, running); !errors.Is(err, task.ErrState) {
		t.Fatal(err)
	}
	i, _ := filesystemCreate(task.Codex)
	i.OperationID, i.Action, i.Expected = "deliver", task.Deliver, terminal.Reference
	if _, err := j.Admit(filesystemCtx, i, before.Revision, terminal); err != nil {
		t.Fatal(err)
	}
	unknown, _ := j.Read(filesystemCtx, "task")
	if unknown.Pending != "deliver" || unknown.Task.DeliveryDispatchID != "" {
		t.Fatal("completion fabricated parent acknowledgement")
	}
	terminal.DeliveryDispatchID = terminal.DispatchID
	if err := j.Finish(filesystemCtx, "deliver", task.Receipt{State: task.Rejected, Code: "TASK_PARENT_REFUSED"}, terminal); err != nil {
		t.Fatal(err)
	}
	after, _ := j.Read(filesystemCtx, "task")
	i.OperationID = "different-delivery-key"
	if _, err := j.Admit(filesystemCtx, i, after.Revision, terminal); !errors.Is(err, task.ErrState) {
		t.Fatal(err)
	}
}
func TestFilesystemLogicCancellationAcknowledgesRequestOnly(t *testing.T) {
	j, _ := filesystemFixture(t)
	running := filesystemLaunch(t, j, task.Codex)
	before, _ := j.Read(filesystemCtx, "task")
	i, _ := filesystemCreate(task.Codex)
	i.OperationID, i.Action, i.Expected = "cancel", task.Cancel, running.Reference
	running.Admission.State = task.AdmissionRevoked
	if _, err := j.Admit(filesystemCtx, i, before.Revision, running); err != nil {
		t.Fatal(err)
	}
	running.CancelRequested = true
	if err := j.Finish(filesystemCtx, "cancel", task.Receipt{State: task.Known, Reference: running.Reference, Lifecycle: task.Running, CancelRequested: true}, running); err != nil {
		t.Fatal(err)
	}
	after, _ := j.Read(filesystemCtx, "task")
	if after.Task.Lifecycle != task.Running || !after.Task.CancelRequested || after.Task.Admission.State != task.AdmissionRevoked {
		t.Fatal("cancel converted to terminal")
	}
}
func TestFilesystemLogicReplayAfterLostACKIsOnlyRetainedRead(t *testing.T) {
	j, m := filesystemFixture(t)
	i, next := filesystemCreate(task.Codex)
	m.failAfter = true
	_, _ = j.Admit(filesystemCtx, i, 0, next)
	a, err := j.Admit(filesystemCtx, i, 0, next)
	if err != nil || a.Claimed || a.Operation.Settled || a.Snapshot.Pending != "create" {
		t.Fatalf("read receipt: %+v %v", a, err)
	}
	if m.writes != 1 {
		t.Fatal("unknown publication retried")
	}
}

func TestFilesystemLogicUnsupportedVersionDuplicateAndChecksum(t *testing.T) {
	j, m := filesystemFixture(t)
	filesystemLaunch(t, j, task.Codex)
	var env filesystemEnvelope
	if err := json.Unmarshal(m.data, &env); err != nil {
		t.Fatal(err)
	}
	env.Image.Version = 2
	body, _ := json.Marshal(env.Image)
	env.SHA256 = filesystemHash(body)
	unsupported, _ := json.Marshal(env)
	unsupported = append(unsupported, byte(10))
	var duplicate = append([]byte{'{'}, m.data[1:]...)
	// Add a repeated top-level Image field to an otherwise canonical image.
	imageJSON, _ := json.Marshal(env.Image)
	duplicate = append([]byte{'{', '"', 'I', 'm', 'a', 'g', 'e', '"', ':'}, imageJSON...)
	duplicate = append(duplicate, ',')
	duplicate = append(duplicate, m.data[1:]...)
	var original filesystemEnvelope
	_ = json.Unmarshal(m.data, &original)
	original.SHA256 = strings.Repeat("0", 64)
	checksum, _ := json.Marshal(original)
	checksum = append(checksum, byte(10))
	for _, data := range [][]byte{unsupported, duplicate, checksum} {
		store := &filesystemMemory{data: data}
		if _, err := newFilesystem(store, "dev"); !errors.Is(err, task.ErrUnknown) {
			t.Fatal(err)
		}
		if store.writes != 0 {
			t.Fatal("unsupported/corrupt image repaired")
		}
	}
}
