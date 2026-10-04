package boot

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"github.com/legrch/farol/transport/desktop"
)

// The actual delivery app, root mapping and existing owner engine use controlled
// storage/native ports. These tests perform no disk/process/provider effects.
const deliveryOperation = "00000000-0000-4000-8000-000000000003"

type deliveryStoreFixture struct {
	value        delivery.Snapshot
	reads, saves int
	saveFault    string
	beforeSave   func(delivery.Change)
}

func copyDeliverySnapshot(v delivery.Snapshot) delivery.Snapshot {
	if v.Pending != nil {
		p := *v.Pending
		v.Pending = &p
	}
	return v
}
func (s *deliveryStoreFixture) Load(context.Context) (delivery.Snapshot, error) {
	s.reads++
	return copyDeliverySnapshot(s.value), nil
}
func (s *deliveryStoreFixture) CompareAndSet(_ context.Context, c delivery.Change) (delivery.SaveResult, error) {
	s.saves++
	if s.beforeSave != nil {
		s.beforeSave(c)
	}
	if !reflect.DeepEqual(s.value, c.Expected) || s.saveFault == "before" {
		return delivery.SaveResult{Publication: delivery.NotWritten}, nil
	}
	s.value.Revision++
	s.value.Pending = c.Next
	s.value.VerificationInvalidated = s.value.VerificationInvalidated || c.InvalidateVerification
	s.value = copyDeliverySnapshot(s.value)
	if s.saveFault == "after" {
		return delivery.SaveResult{Publication: delivery.PublicationUnknown}, errors.New("lost publication")
	}
	copy := copyDeliverySnapshot(s.value)
	return delivery.SaveResult{Publication: delivery.Committed, Readback: &copy}, nil
}
func deliveryFixture(t *testing.T) (*SettingsDeliveryIngress, *deliveryStoreFixture, *chatMutationJournal, *chatMutationNative, wire.SettingsDeliveryApply) {
	t.Helper()
	m, a, j, n, in := settingsEditFixture(t)
	m.computer.peer.ProfileId = "00000000-0000-4000-8000-000000000001"
	m.computer.computerID = "00000000-0000-4000-8000-000000000002"
	in.WorkspaceId = "00000000-0000-4000-8000-000000000004"
	a.approval.ComputerID = m.computer.computerID
	a.approval.Workspaces[0].WorkspaceID = in.WorkspaceId
	m.computer.clock.(*computerClockFixture).now = time.Now().Truncate(time.Millisecond)
	a.approval.ExpiresAt = m.computer.clock.Now().Add(time.Hour)
	m.computer.publication.approval = a.approval.Clone()
	store := &deliveryStoreFixture{value: delivery.Snapshot{Revision: 8, Current: delivery.Identity{ProfileID: m.computer.peer.ProfileId, OwnerID: m.computer.ownerID, ComputerID: m.computer.computerID, Generation: 3}}}
	root, err := NewSettingsDeliveryIngress(m, store)
	if err != nil {
		t.Fatal(err)
	}
	return root, store, j, n, wire.SettingsDeliveryApply{DeadlineMillis: strconv.FormatInt(time.Now().Add(10*time.Second).UnixMilli(), 10), Request: in}
}
func TestSettingsDeliveryRootApplyThenExactACK(t *testing.T) {
	s, store, j, n, in := deliveryFixture(t)
	store.beforeSave = func(c delivery.Change) {
		if c.Next != nil && (n.calls != 0 || j.admits != 0) {
			t.Fatal("effect preceded durable pending")
		}
	}
	out, err := s.apply(context.Background(), deliveryOperation, in)
	if err != nil || out == nil || out.State != "offered" || out.ReceiptId == nil || out.Result.Phase != "completed" || *out.Retention != "durable" {
		t.Fatalf("apply %+v result=%+v err=%v native=%d engine=%+v", out, out.Result, err, n.calls, s.mutations.operations[deliveryOperation])
	}
	if store.saves != 1 || store.value.Pending == nil || n.calls != 1 || j.admits != 1 || j.saves != 1 {
		t.Fatal("wrong effect/publication count")
	}
	if _, err = s.apply(context.Background(), deliveryOperation, in); err == nil || n.calls != 1 {
		t.Fatal("duplicate Apply")
	}
	observation, err := s.observe(context.Background(), wire.SettingsDeliveryObserve{Pending: out.Pending})
	if err != nil || !reflect.DeepEqual(out, observation) || n.calls != 1 {
		t.Fatal("result changed or executed again")
	}
	ack := wire.SettingsDeliveryACK{ReceiptId: *out.ReceiptId, Pending: out.Pending}
	bad := ack
	bad.ReceiptId = "other"
	if _, err = s.acknowledge(context.Background(), bad); err == nil {
		t.Fatal("forged receipt")
	}
	bad = ack
	bad.Pending.SubmittedAt = "2026-10-04T00:00:00Z"
	if _, err = s.acknowledge(context.Background(), bad); err == nil {
		t.Fatal("crossed pending")
	}
	for i := 0; i < 2; i++ {
		result, err := s.acknowledge(context.Background(), ack)
		if err != nil || !result.Acknowledged {
			t.Fatalf("ack %+v %v", result, err)
		}
	}
	if store.value.Pending != nil || store.saves != 2 || n.calls != 1 {
		t.Fatal("ACK replay saved or executed")
	}
	if err = s.freezeForRetirement(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = s.mutations.freezeForRetirement(); err != nil {
		t.Fatal(err)
	}
}
func TestSettingsDeliveryRootRestoredOriginalGeneration(t *testing.T) {
	s, store, j, n, in := deliveryFixture(t)
	out, err := s.apply(context.Background(), deliveryOperation, in)
	if err != nil {
		t.Fatal(err)
	}
	oldReceipt := *out.ReceiptId
	store.value.Current.Generation = 4
	m, err := settingsMutationIngress(s.mutations.computer, s.mutations.dependencies)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewSettingsDeliveryIngress(m, store)
	if err != nil {
		t.Fatal(err)
	}
	got, err := restarted.observe(context.Background(), wire.SettingsDeliveryObserve{Pending: out.Pending})
	if err != nil || got.Result.ComputerGeneration != "3" || got.Result.Phase != "completed" || *got.ReceiptId == oldReceipt {
		t.Fatalf("rejoin %+v %v", got, err)
	}
	if _, err = restarted.acknowledge(context.Background(), wire.SettingsDeliveryACK{ReceiptId: oldReceipt, Pending: out.Pending}); err == nil {
		t.Fatal("previous lifetime receipt accepted")
	}
	if _, err = restarted.acknowledge(context.Background(), wire.SettingsDeliveryACK{ReceiptId: *got.ReceiptId, Pending: got.Pending}); err != nil {
		t.Fatal(err)
	}
	if n.calls != 1 || j.admits != 1 || j.saves != 1 || store.value.Pending != nil {
		t.Fatal("rejoin repeated effect")
	}
}
func TestSettingsDeliveryRootPublicationAndEffectUnknownStayFenced(t *testing.T) {
	for _, stage := range []string{"pending", "result", "ack"} {
		t.Run(stage, func(t *testing.T) {
			s, store, j, n, in := deliveryFixture(t)
			if stage == "pending" {
				store.saveFault = "after"
			}
			if stage == "result" {
				j.saveFault = "after"
			}
			out, err := s.apply(context.Background(), deliveryOperation, in)
			if stage == "pending" {
				if err == nil || out != nil || n.calls != 0 {
					t.Fatal("lost pending dispatched")
				}
			} else {
				if err != nil || out == nil {
					t.Fatalf("apply %+v result=%+v err=%v native=%d engine=%+v", out, out.Result, err, n.calls, s.mutations.operations[deliveryOperation])
				}
				if stage == "result" && (!store.value.VerificationInvalidated || *out.Retention != "memory_only") {
					t.Fatal("unknown offered without invalidation")
				}
				if stage == "ack" {
					store.saveFault = "after"
				}
				_, err = s.acknowledge(context.Background(), wire.SettingsDeliveryACK{ReceiptId: *out.ReceiptId, Pending: out.Pending})
				if stage == "ack" && err == nil {
					t.Fatal("lost ACK upgraded")
				}
			}
			store.saveFault = ""
			j.saveFault = ""
			calls, saves := n.calls, store.saves
			if _, err = s.apply(context.Background(), deliveryOperation, in); err == nil {
				t.Fatal("uncertain effect replayed")
			}
			if err = s.freezeForRetirement(context.Background()); err == nil {
				t.Fatal("unknown retired")
			}
			if n.calls != calls || store.saves != saves {
				t.Fatal("fence repeated IO")
			}
		})
	}
}
func TestSettingsDeliveryRootRestoredMissingRecordNeverExecutes(t *testing.T) {
	s, store, _, n, in := deliveryFixture(t)
	store.value.Pending = &delivery.Pending{Backend: "go-owner-v2", OperationID: deliveryOperation, ProfileID: store.value.Current.ProfileID, WorkspaceID: in.Request.WorkspaceId, RelativePath: in.Request.RelativePath, ComputerGeneration: 3, BeforeSHA256: in.Request.ExpectedSHA256, SubmittedAt: "2026-10-04T00:00:00.123456789Z"}
	original := *settingsPendingToWire(store.value.Pending)
	out, err := s.observe(context.Background(), wire.SettingsDeliveryObserve{Pending: original})
	if err != nil || out.Result.Phase != "outcome_unknown" || !store.value.VerificationInvalidated || n.calls != 0 {
		t.Fatalf("missing record %+v %v", out, err)
	}
	if err = s.freezeForRetirement(context.Background()); err == nil {
		t.Fatal("missing effect retired")
	}
}
func TestSettingsDeliveryRootFramedRoutesAndDeadline(t *testing.T) {
	s, store, _, n, in := deliveryFixture(t)
	p := taskWireTestConnectMethods(t, s.Methods(), s.mutations.computer.peer)
	raw, _ := json.Marshal(in)
	out := taskWireTestData[wire.SettingsDeliveryResult](t, p.call("computer.settings.delivery.apply", deliveryOperation, string(raw)), "SettingsDeliveryResult")
	observe := wire.SettingsDeliveryObserve{DeadlineMillis: in.DeadlineMillis, Pending: out.Pending}
	raw, _ = json.Marshal(observe)
	again := taskWireTestData[wire.SettingsDeliveryResult](t, p.call("computer.settings.delivery.observe", "observe", string(raw)), "SettingsDeliveryResult")
	if *again.ReceiptId != *out.ReceiptId {
		t.Fatal("offer identity changed")
	}
	ack := wire.SettingsDeliveryACK{DeadlineMillis: in.DeadlineMillis, ReceiptId: *out.ReceiptId, Pending: out.Pending}
	raw, _ = json.Marshal(ack)
	got := taskWireTestData[wire.SettingsDeliveryACKResult](t, p.call("computer.settings.delivery.ack", "ack", string(raw)), "SettingsDeliveryACKResult")
	if !got.Acknowledged || n.calls != 1 || store.saves != 2 {
		t.Fatalf("wrong framed effect counts n=%d saves=%d result=%+v", n.calls, store.saves, out.Result)
	}
	for _, deadline := range []string{"0", strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10), "9007199254740992"} {
		in.DeadlineMillis = deadline
		raw, _ = json.Marshal(in)
		response, err := s.Methods()["computer.settings.delivery.apply"].Handle(context.Background(), desktop.Request{OperationID: "new", Body: raw})
		if err == nil && response.Status == "ok" {
			t.Fatal("invalid deadline accepted")
		}
	}
	if store.saves != 2 || n.calls != 1 {
		t.Fatal("invalid deadline reached effect")
	}
}
