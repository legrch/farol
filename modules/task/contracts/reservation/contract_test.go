package reservation

// Labelled CPU mapping double: actual Owner/journal integration is tested in
// infra/repos/task. No native/provider qualification is implied here.
import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type reservationDouble struct {
	selection port.CurrentBinding
	received  task.NativeReservation
	status    port.ReservationStatus
	err       error
	corrupt   bool
	calls     int
}

func (d *reservationDouble) Selection() port.CurrentBinding { return d.selection }
func (d *reservationDouble) ReserveNative(_ context.Context, in task.NativeReservation) (*port.ReservationReceipt, error) {
	d.received = in
	d.calls++
	if d.err != nil {
		return nil, d.err
	}
	if d.corrupt {
		in.DeadlineUnixNano++
	}
	return &port.ReservationReceipt{Status: d.status, Intent: in}, nil
}
func contractFixture(t *testing.T) (*Contract, *reservationDouble, Intent) {
	t.Helper()
	b := Binding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: 7, ParticipantID: "participant", TurnID: "turn"}
	d := &reservationDouble{selection: port.CurrentBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}, status: port.Reserved}
	c, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	return c, d, Intent{OperationID: "operation", Binding: b, Seal: Seal{Digest: strings.Repeat("e", 64), WorkspaceID: "workspace", Root: "/fixture/writer", Cwd: "/fixture/writer/subdir", RootIdentity: RootIdentity{Device: "1", Inode: "2"}, Write: true}, DeadlineUnixNano: 1800000000123456789}
}
func code(t *testing.T, err error, want string) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != want {
		t.Fatalf("err=%v want=%s", err, want)
	}
}
func TestReservationContractMapsEveryFieldAndRetainedStatus(t *testing.T) {
	c, d, in := contractFixture(t)
	for _, status := range []port.ReservationStatus{port.Reserved, port.Existing} {
		d.status = status
		out, err := c.Reserve(context.Background(), in)
		if err != nil || out == nil || out.Intent != in || string(out.Status) != string(status) {
			t.Fatalf("mapped: %+v %v", out, err)
		}
		b, s := in.Binding, in.Seal
		want := task.NativeReservation{OperationID: in.OperationID, Admission: task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}, Seal: task.NativeSeal{Digest: s.Digest, WorkspaceID: s.WorkspaceID, Root: s.Root, Cwd: s.Cwd, RootIdentity: task.NativeRootIdentity{Device: s.RootIdentity.Device, Inode: s.RootIdentity.Inode}, Write: s.Write}, DeadlineUnixNano: in.DeadlineUnixNano}
		if d.received != want {
			t.Fatal("input mapping lost identity/seal/deadline")
		}
	}
}
func TestReservationContractRefusesMalformedCrossedAndUnknown(t *testing.T) {
	for name, mutate := range map[string]func(*Intent){
		"binding":   func(v *Intent) { v.Binding.TurnID = "other" },
		"partial":   func(v *Intent) { v.Seal.Digest = "" },
		"deadline":  func(v *Intent) { v.DeadlineUnixNano = 0 },
		"outside":   func(v *Intent) { v.Seal.Cwd = "/fixture/other" },
		"traversal": func(v *Intent) { v.Seal.Cwd = v.Seal.Root + "/../outside" },
	} {
		t.Run(name, func(t *testing.T) {
			c, d, in := contractFixture(t)
			mutate(&in)
			out, err := c.Reserve(context.Background(), in)
			if out != nil || err == nil || d.calls != 0 {
				t.Fatalf("invalid delegated: %+v %v calls=%d", out, err, d.calls)
			}
		})
	}
	for _, corrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown-status", true: "changed-receipt"}[corrupt], func(t *testing.T) {
			c, d, in := contractFixture(t)
			d.corrupt = corrupt
			if !corrupt {
				d.status = "unclassified"
			}
			out, err := c.Reserve(context.Background(), in)
			if out != nil {
				t.Fatal(out)
			}
			code(t, err, "TASK_RESERVATION_UNKNOWN")
		})
	}
}
func TestReservationContractClassifiesWithoutDisclosingErrors(t *testing.T) {
	for _, row := range []struct {
		err  error
		want string
	}{
		{task.ErrUnknown, "TASK_RESERVATION_UNKNOWN"},
		{task.ErrConflict, "TASK_OPERATION_CONFLICT"},
		{task.ErrIdentity, "TASK_IDENTITY_MISMATCH"},
		{task.ErrState, "TASK_STATE_REFUSED"},
		{task.ErrUnsupported, "TASK_RESERVATION_UNAVAILABLE"},
		{errors.New("private native path diagnostic"), "TASK_RESERVATION_UNKNOWN"},
	} {
		c, d, in := contractFixture(t)
		d.err = row.err
		out, err := c.Reserve(context.Background(), in)
		if out != nil {
			t.Fatal(out)
		}
		code(t, err, row.want)
	}
}

func TestReservationContractMissingOwnerAndCancelledContext(t *testing.T) {
	var owner *reservationDouble
	for _, candidate := range []port.SelectedReservation{nil, owner} {
		out, err := New(candidate)
		if out != nil {
			t.Fatal(out)
		}
		code(t, err, "TASK_RESERVATION_UNAVAILABLE")
	}
	c, d, in := contractFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := c.Reserve(ctx, in)
	if out != nil || d.calls != 0 {
		t.Fatal("cancelled request delegated", out)
	}
	code(t, err, "TASK_RESERVATION_UNKNOWN")
}
