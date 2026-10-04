package task

// These tests use the actual Filesystem/Owner with an in-memory atomic storage
// seam. They prove policy/serialization/concurrency, never native durability,
// process confinement, provider execution or installed-state acceptance.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	reservationct "github.com/legrch/farol/modules/task/contracts/reservation"
	"github.com/legrch/farol/modules/task/domain"
)

func reservationOwner(t *testing.T, store port.AdmissionJournal) (*Owner, *Route, task.Intent, task.Task) {
	t.Helper()
	i, next := filesystemCreate(task.Claude)
	o, err := New(store, i.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	b := i.Admission
	r, err := o.Select(port.CurrentBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID})
	if err != nil {
		t.Fatal(err)
	}
	out, err := r.Admit(filesystemCtx, i, 0, next)
	if err != nil || out == nil || !out.Claimed {
		t.Fatalf("admit: %+v %v", out, err)
	}
	return o, r, i, next
}
func nativeReservation(i task.Intent) task.NativeReservation {
	return task.NativeReservation{OperationID: i.OperationID, Admission: i.Admission,
		Seal:             task.NativeSeal{Digest: strings.Repeat("c", 64), WorkspaceID: i.Binding.WorkspaceID, Root: i.Binding.Writer.Path, Cwd: i.Binding.Writer.Path + "/subdir", RootIdentity: task.NativeRootIdentity{Device: i.Binding.Writer.Device, Inode: i.Binding.Writer.Inode}, Write: true},
		DeadlineUnixNano: 1800000000123456789}
}
func reservationCurrent(t *testing.T, route *Route, want bool) {
	t.Helper()
	current := false
	err := route.WithCurrent(filesystemCtx, func(b *port.CurrentBinding) error { current = b != nil; return nil })
	if current != want || want && err != nil {
		t.Fatalf("current=%v want=%v err=%v", current, want, err)
	}
}
func reservationReopen(t *testing.T, m *filesystemMemory, binding task.AdmissionBinding) (*Filesystem, *Route) {
	t.Helper()
	j, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	o, err := New(j, binding.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	r, err := o.Select(port.CurrentBinding{OwnerID: binding.OwnerID, SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch, ParticipantID: binding.ParticipantID, TurnID: binding.TurnID})
	if err != nil {
		t.Fatal(err)
	}
	return j, r
}
func TestNativeReservationOwnerFreshRepeatAndReload(t *testing.T) {
	j, m := filesystemFixture(t)
	_, r, i, _ := reservationOwner(t, j)
	in := nativeReservation(i)
	before, _ := j.Read(filesystemCtx, i.TaskID)
	out, err := r.ReserveNative(filesystemCtx, in)
	if err != nil || out == nil || out.Status != port.Reserved || out.Intent != in {
		t.Fatalf("fresh: %+v %v", out, err)
	}
	reservationCurrent(t, r, true)
	after, _ := j.Read(filesystemCtx, i.TaskID)
	if *after != *before {
		t.Fatal("reservation changed task lifecycle, admission, revision or pending")
	}
	for range 2 {
		out, err = r.ReserveNative(filesystemCtx, in)
		if err != nil || out == nil || out.Status != port.Existing || out.Intent != in {
			t.Fatalf("repeat: %+v %v", out, err)
		}
	}
	if m.writes != 2 {
		t.Fatalf("writes=%d", m.writes)
	}
	r.Fence()
	_, restored := reservationReopen(t, m, in.Admission)
	out, err = restored.ReserveNative(filesystemCtx, in)
	if err != nil || out == nil || out.Status != port.Existing || out.Intent != in {
		t.Fatalf("reload: %+v %v", out, err)
	}
	reservationCurrent(t, restored, false)
	if m.writes != 2 {
		t.Fatal("retained record republished")
	}
}
func TestNativeReservationConcurrentCallsReturnOnePermit(t *testing.T) {
	j, m := filesystemFixture(t)
	_, r, i, _ := reservationOwner(t, j)
	var wg sync.WaitGroup
	results := make(chan port.ReservationStatus, 8)
	for range 8 {
		wg.Go(func() {
			out, err := r.ReserveNative(filesystemCtx, nativeReservation(i))
			if err != nil || out == nil {
				t.Errorf("reserve: %+v %v", out, err)
				return
			}
			results <- out.Status
		})
	}
	wg.Wait()
	close(results)
	reserved, existing := 0, 0
	for status := range results {
		switch status {
		case port.Reserved:
			reserved++
		case port.Existing:
			existing++
		}
	}
	if reserved != 1 || existing != 7 || m.writes != 2 {
		t.Fatalf("reserved=%d existing=%d writes=%d", reserved, existing, m.writes)
	}
}
func TestNativeReservationExactIntentConflicts(t *testing.T) {
	j, m := filesystemFixture(t)
	_, r, i, _ := reservationOwner(t, j)
	in := nativeReservation(i)
	if _, err := r.ReserveNative(filesystemCtx, in); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(*task.NativeReservation){
		"digest":      func(v *task.NativeReservation) { v.Seal.Digest = strings.Repeat("d", 64) },
		"deadline":    func(v *task.NativeReservation) { v.DeadlineUnixNano++ },
		"cwd":         func(v *task.NativeReservation) { v.Seal.Cwd = v.Seal.Root },
		"write":       func(v *task.NativeReservation) { v.Seal.Write = false },
		"workspace":   func(v *task.NativeReservation) { v.Seal.WorkspaceID = "other" },
		"root":        func(v *task.NativeReservation) { v.Seal.Root = "/other"; v.Seal.Cwd = "/other" },
		"physical":    func(v *task.NativeReservation) { v.Seal.RootIdentity.Inode = "4" },
		"owner":       func(v *task.NativeReservation) { v.Admission.OwnerID = "other" },
		"session":     func(v *task.NativeReservation) { v.Admission.SessionID = "other" },
		"task":        func(v *task.NativeReservation) { v.Admission.TaskID = "other" },
		"participant": func(v *task.NativeReservation) { v.Admission.ParticipantID = "other" },
		"epoch":       func(v *task.NativeReservation) { v.Admission.TaskEpoch++ },
		"turn":        func(v *task.NativeReservation) { v.Admission.TurnID = "other" },
		"operation":   func(v *task.NativeReservation) { v.OperationID = "other" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			other := in
			mutate(&other)
			out, err := r.ReserveNative(filesystemCtx, other)
			if err == nil || out != nil {
				t.Fatalf("crossed intent: %+v %v", out, err)
			}
		})
	}
	if m.writes != 2 {
		t.Fatal("conflict republished")
	}
}
func TestNativeReservationPublicationUnknownNeverReturnsPermit(t *testing.T) {
	for _, after := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-publication", true: "after-publication"}[after], func(t *testing.T) {
			j, m := filesystemFixture(t)
			_, r, i, _ := reservationOwner(t, j)
			in := nativeReservation(i)
			m.failBefore, m.failAfter = !after, after
			out, err := r.ReserveNative(filesystemCtx, in)
			if out != nil || !errors.Is(err, task.ErrUnknown) {
				t.Fatalf("unknown: %+v %v", out, err)
			}
			reservationCurrent(t, r, false)
			out, err = r.ReserveNative(filesystemCtx, in)
			if after {
				if err != nil || out == nil || out.Status != port.Existing {
					t.Fatalf("retained: %+v %v", out, err)
				}
			} else if out != nil || !errors.Is(err, task.ErrUnknown) {
				t.Fatalf("missing proof: %+v %v", out, err)
			}
			m.failBefore, m.failAfter = false, false
			_, restored := reservationReopen(t, m, in.Admission)
			out, err = restored.ReserveNative(filesystemCtx, in)
			if after {
				if err != nil || out == nil || out.Status != port.Existing {
					t.Fatalf("reload: %+v %v", out, err)
				}
			} else if out != nil || err == nil {
				t.Fatalf("missing reload granted: %+v %v", out, err)
			}
			reservationCurrent(t, restored, false)
			if m.writes != 2 {
				t.Fatal("unknown publication retried")
			}
		})
	}
}

type blockingReservationStore struct {
	*Filesystem
	entered, release chan struct{}
}

func (s *blockingReservationStore) ReserveNative(ctx context.Context, in task.NativeReservation) (*port.ReservationReceipt, error) {
	close(s.entered)
	<-s.release
	return s.Filesystem.ReserveNative(ctx, in)
}
func TestNativeReservationFenceDuringPublicationConsumesPermit(t *testing.T) {
	j, m := filesystemFixture(t)
	s := &blockingReservationStore{Filesystem: j, entered: make(chan struct{}), release: make(chan struct{})}
	_, r, i, _ := reservationOwner(t, s)
	done := make(chan error, 1)
	go func() {
		out, err := r.ReserveNative(filesystemCtx, nativeReservation(i))
		if out != nil {
			t.Error("fenced publication returned permit")
		}
		done <- err
	}()
	<-s.entered
	r.Fence()
	close(s.release)
	if err := <-done; !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	reservationCurrent(t, r, false)
	out, err := r.ReserveNative(filesystemCtx, nativeReservation(i))
	if err != nil || out == nil || out.Status != port.Existing || m.writes != 2 {
		t.Fatalf("retained: %+v %v writes=%d", out, err, m.writes)
	}
}
func TestNativeReservationOldRecordReloadDoesNotRestoreAdmission(t *testing.T) {
	j, m := filesystemFixture(t)
	_, original, i, _ := reservationOwner(t, j)
	legacy := bytes.Clone(m.data)
	if bytes.Contains(legacy, []byte(`"Reservation"`)) {
		t.Fatal("old canonical image changed")
	}
	image, err := filesystemDecode(legacy)
	if err != nil {
		t.Fatal(err)
	}
	// Independent pre-extension Operation shape pins backward canonical bytes.
	type legacyOperation struct {
		Events  task.EventLog `json:",omitzero"`
		Intent  task.Intent
		Lineage task.Reference
		Receipt task.Receipt
		Settled bool
	}
	type legacyImage struct {
		ProfileID  string
		Version    uint8
		Revision   uint64
		Tasks      map[string]port.Snapshot
		Operations map[string]legacyOperation
	}
	old := legacyImage{image.ProfileID, image.Version, image.Revision, image.Tasks, map[string]legacyOperation{}}
	for id, op := range image.Operations {
		old.Operations[id] = legacyOperation{op.Events, op.Intent, op.Lineage, op.Receipt, op.Settled}
	}
	body, _ := json.Marshal(old)
	encoded, _ := json.Marshal(struct {
		Image  legacyImage
		SHA256 string
	}{old, filesystemHash(body)})
	if !bytes.Equal(legacy, append(encoded, '\n')) {
		t.Fatal("legacy canonical bytes differ")
	}
	_, restored := reservationReopen(t, m, i.Admission)
	if out, err := restored.ReserveNative(filesystemCtx, nativeReservation(i)); out != nil || !errors.Is(err, task.ErrState) {
		t.Fatalf("restored permission: %+v %v", out, err)
	}
	reservationCurrent(t, restored, false)
	if m.writes != 1 {
		t.Fatal("missing legacy field published")
	}
	// The original in-memory active Owner may still reserve its first invocation.
	if out, err := original.ReserveNative(filesystemCtx, nativeReservation(i)); err != nil || out == nil || out.Status != port.Reserved {
		t.Fatalf("original: %+v %v", out, err)
	}
}
func TestNativeReservationNewEpochCannotReuseOldOperation(t *testing.T) {
	j, m := filesystemFixture(t)
	o, original, i, next := reservationOwner(t, j)
	in := nativeReservation(i)
	if _, err := original.ReserveNative(filesystemCtx, in); err != nil {
		t.Fatal(err)
	}
	ref := filesystemReference(task.Claude, i.OperationID)
	next.Reference, next.Lifecycle, next.Result, next.DispatchID = ref, task.Completed, "retained result", i.OperationID
	next.Admission.State = task.AdmissionClosed
	if err := original.Finish(filesystemCtx, i.OperationID, task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Completed, Result: next.Result}, next); err != nil {
		t.Fatal(err)
	}
	before, _ := j.Read(filesystemCtx, i.TaskID)
	b := i.Admission
	b.TaskEpoch++
	b.TurnID = "next-turn"
	newRoute, err := o.Select(port.CurrentBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID})
	if err != nil {
		t.Fatal(err)
	}
	follow := i
	follow.OperationID, follow.Action, follow.Admission, follow.Expected = "resume", task.Resume, b, ref
	prepared := next
	prepared.Admission = task.ExecutionAdmission{Binding: b, State: task.AdmissionActive}
	if out, err := newRoute.Admit(filesystemCtx, follow, before.Revision, prepared); err != nil || out == nil || !out.Claimed {
		t.Fatalf("resume admit: %+v %v", out, err)
	}
	if out, err := newRoute.ReserveNative(filesystemCtx, in); out != nil || !errors.Is(err, task.ErrIdentity) {
		t.Fatalf("old route adopted: %+v %v", out, err)
	}
	wrong := in
	wrong.Admission = b
	if out, err := newRoute.ReserveNative(filesystemCtx, wrong); out != nil || !errors.Is(err, task.ErrIdentity) {
		t.Fatalf("old operation relabelled: %+v %v", out, err)
	}
	if out, err := original.ReserveNative(filesystemCtx, in); err != nil || out == nil || out.Status != port.Existing {
		t.Fatalf("original retained: %+v %v", out, err)
	}
	reservationCurrent(t, newRoute, true)
	if out, err := newRoute.ReserveNative(filesystemCtx, nativeReservation(follow)); err != nil || out == nil || out.Status != port.Reserved {
		t.Fatalf("new invocation: %+v %v", out, err)
	}
	if m.writes != 5 {
		t.Fatalf("unexpected writes=%d", m.writes)
	}
}
func TestNativeReservationSerializationRejectsPartialAndCrossedRecords(t *testing.T) {
	j, m := filesystemFixture(t)
	_, r, i, _ := reservationOwner(t, j)
	if _, err := r.ReserveNative(filesystemCtx, nativeReservation(i)); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*task.NativeReservation){
		"partial":      func(v *task.NativeReservation) { *v = task.NativeReservation{OperationID: v.OperationID} },
		"crossed-turn": func(v *task.NativeReservation) { v.Admission.TurnID = "other" },
		"crossed-root": func(v *task.NativeReservation) { v.Seal.RootIdentity.Inode = "9" },
	} {
		t.Run(name, func(t *testing.T) {
			image, err := filesystemDecode(m.data)
			if err != nil {
				t.Fatal(err)
			}
			op := image.Operations[i.OperationID]
			mutate(&op.Reservation)
			image.Operations[i.OperationID] = op
			body, _ := json.Marshal(image)
			data, _ := json.Marshal(filesystemEnvelope{*image, filesystemHash(body)})
			if _, err := filesystemDecode(append(data, '\n')); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("malformed proof decoded", err)
			}
		})
	}
}
func TestNativeReservationPublishedContractUsesActualOwner(t *testing.T) {
	j, m := filesystemFixture(t)
	_, route, i, _ := reservationOwner(t, j)
	c, err := reservationct.New(route)
	if err != nil {
		t.Fatal(err)
	}
	v := nativeReservation(i)
	b, s := v.Admission, v.Seal
	in := reservationct.Intent{OperationID: v.OperationID, Binding: reservationct.Binding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}, Seal: reservationct.Seal{Digest: s.Digest, WorkspaceID: s.WorkspaceID, Root: s.Root, Cwd: s.Cwd, RootIdentity: reservationct.RootIdentity{Device: s.RootIdentity.Device, Inode: s.RootIdentity.Inode}, Write: s.Write}, DeadlineUnixNano: v.DeadlineUnixNano}
	for n, want := range []reservationct.Status{reservationct.Reserved, reservationct.Existing} {
		out, err := c.Reserve(filesystemCtx, in)
		if err != nil || out == nil || out.Status != want || out.Intent != in {
			t.Fatalf("call %d: %+v %v", n, out, err)
		}
	}
	if m.writes != 2 {
		t.Fatal("contract republished")
	}
}
