package boot

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type durablePlanStore struct {
	record               *state.SelfTestState
	admits, saves, loads int
	admitErr, saveErr    error
	afterLoad            func()
}

type blockingReservationStore struct {
	*durablePlanStore
	entered, release chan struct{}
}

func (s *blockingReservationStore) AdmitSelfTest(ctx context.Context, value *state.SelfTestState) (port.SelfTestAdmission, error) {
	close(s.entered)
	<-s.release
	return s.durablePlanStore.AdmitSelfTest(ctx, value)
}

func (s *durablePlanStore) AdmitSelfTest(_ context.Context, v *state.SelfTestState) (port.SelfTestAdmission, error) {
	s.admits++
	if s.admitErr != nil {
		return port.SelfTestAdmission{}, s.admitErr
	}
	if s.record != nil {
		return port.SelfTestAdmission{Status: port.MutationExisting, Record: s.record}, nil
	}
	s.record = v
	return port.SelfTestAdmission{Status: port.MutationAdmitted, Record: v}, nil
}
func (s *durablePlanStore) LoadSelfTest(context.Context, state.SelfTestBinding) (*state.SelfTestState, error) {
	s.loads++
	if s.afterLoad != nil {
		s.afterLoad()
	}
	return s.record, nil
}
func (s *durablePlanStore) SaveSelfTest(_ context.Context, v *state.SelfTestState) error {
	s.saves++
	if s.saveErr != nil {
		return s.saveErr
	}
	s.record = v
	return nil
}

type durablePlanFake struct {
	ids   selfTestIDs
	calls int
}

func (p *durablePlanFake) workspaceIDs() selfTestIDs { return p.ids }
func (p *durablePlanFake) workspaceCheck(_ context.Context, name, operation string) selfTestStep {
	return p.step(name, operation)
}

func (p *durablePlanFake) step(name, id string) selfTestStep {
	p.calls++
	return selfTestStep{Name: name, Status: "pass", Operation: id}
}
func (p *durablePlanFake) create(context.Context) selfTestStep { return p.step("scratch", p.ids.run) }
func (p *durablePlanFake) write(context.Context) selfTestStep  { return p.step("write", p.ids.write) }
func (p *durablePlanFake) edit(context.Context) selfTestStep   { return p.step("edit", p.ids.edit) }
func (p *durablePlanFake) observe(context.Context) selfTestStep {
	return p.step("mutation read", p.ids.edit)
}
func (p *durablePlanFake) cleanup(context.Context) selfTestStep { return p.step("cleanup", p.ids.run) }
func (p *durablePlanFake) shell(_ context.Context, kind selfTestShellKind) selfTestStep {
	if kind == selfTestShellQuick {
		return p.step("shell", p.ids.quick)
	}
	return p.step("shell cancel", p.ids.cancel)
}

func TestSelfTestReservationIsDurableOneShotAndNeverRecoveredAsPermit(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	for _, mode := range []string{"new", "existing", "lost"} {
		t.Run(mode, func(t *testing.T) {
			store := &durablePlanStore{}
			if mode == "existing" {
				var err error
				store.record, err = state.RestoreSelfTest(binding, state.Prepared, nil)
				if err != nil {
					t.Fatal(err)
				}
			}
			if mode == "lost" {
				store.admitErr = errors.New("lost acknowledgement")
			}
			plan := &durablePlanFake{ids: ids}
			owner := &durableSelfTestExecution{binding: binding, repository: store, preflight: func(context.Context) error { return nil }, execution: &selfTestExecution{owner: plan}}
			admitted := owner.reserveForStart(context.Background())
			if admitted != (mode == "new") || store.admits != 1 || owner.reserveForStart(context.Background()) {
				t.Fatal("reservation repeated or fabricated", mode, admitted)
			}
			out := owner.executeReserved(context.Background())
			if mode == "new" {
				if out.Status != "partial" || plan.calls != 7 || store.saves != 1 {
					t.Fatal("reserved run did not execute", out)
				}
			} else if out.Status != "unknown" || plan.calls != 0 || store.saves != 0 {
				t.Fatal("existing or unknown reservation dispatched", mode, out)
			}
			_ = owner.executeReserved(context.Background())
			_ = owner.execute(context.Background())
			if store.admits != 1 || mode == "new" && plan.calls != 7 || mode != "new" && plan.calls != 0 {
				t.Fatal("attempt replayed", mode)
			}
		})
	}
}

func TestSelfTestStartWithoutReservationNeverAcquiresPermitLater(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	store, plan := &durablePlanStore{}, &durablePlanFake{ids: ids}
	owner := &durableSelfTestExecution{binding: binding, repository: store, preflight: func(context.Context) error { return nil }, execution: &selfTestExecution{owner: plan}}
	if out := owner.executeReserved(context.Background()); out.Status != "unknown" {
		t.Fatal("unreserved run did not refuse", out)
	}
	if owner.reserveForStart(context.Background()) || store.admits != 0 || plan.calls != 0 {
		t.Fatal("unreserved attempt acquired a later permit")
	}
}

func TestSelfTestReservationJoinsShutdownWithoutExecuting(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	store, plan, gate := &durablePlanStore{}, &durablePlanFake{ids: ids}, &selfTestParentGate{}
	owner := &durableSelfTestExecution{binding: binding, repository: store, gate: gate, preflight: func(context.Context) error { return nil }, execution: &selfTestExecution{owner: plan}}
	if !owner.reserveForStart(context.Background()) || gate.disposition() != "pending_operation" {
		t.Fatal("reservation did not retain gate")
	}
	gate.stop()
	gate.wait()
	if gate.disposition() != "operation_unknown" || plan.calls != 0 || store.saves != 0 {
		t.Fatal("shutdown erased or dispatched reservation")
	}
	if out := owner.executeReserved(context.Background()); out.Status != "unknown" || plan.calls != 0 {
		t.Fatal("shutdown reservation replayed", out)
	}
}

func TestSelfTestShutdownWaitsForOriginalReservationIO(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	store := &blockingReservationStore{durablePlanStore: &durablePlanStore{}, entered: make(chan struct{}), release: make(chan struct{})}
	gate, plan := &selfTestParentGate{}, &durablePlanFake{ids: ids}
	owner := &durableSelfTestExecution{binding: binding, repository: store, gate: gate, preflight: func(context.Context) error { return nil }, execution: &selfTestExecution{owner: plan}}
	reserved := make(chan bool, 1)
	go func() { reserved <- owner.reserveForStart(context.Background()) }()
	<-store.entered
	gate.stop()
	joined := make(chan struct{})
	go func() { gate.wait(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("shutdown crossed pending reservation")
	case <-time.After(50 * time.Millisecond):
	}
	close(store.release)
	if <-reserved {
		t.Fatal("cancelled admission granted permit")
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("reservation was not joined")
	}
	if gate.disposition() != "operation_unknown" || plan.calls != 0 {
		t.Fatal("reservation outcome erased or executed")
	}
}

func TestSelfTestReservationExpiryPreservesUnknown(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	store, plan, gate := &durablePlanStore{}, &durablePlanFake{ids: ids}, &selfTestParentGate{}
	owner := &durableSelfTestExecution{binding: binding, repository: store, gate: gate, preflight: func(context.Context) error { return nil }, execution: &selfTestExecution{owner: plan}, reservationBudget: 20 * time.Millisecond}
	if !owner.reserveForStart(context.Background()) {
		t.Fatal("reservation refused")
	}
	gate.wait()
	if gate.disposition() != "operation_unknown" || plan.calls != 0 || store.record == nil || store.record.Phase() != state.Prepared {
		t.Fatal("expiry changed or dispatched history")
	}
	if out := owner.executeReserved(context.Background()); out.Status != "unknown" || plan.calls != 0 {
		t.Fatal("expired reservation replayed", out)
	}
}

func TestSelfTestReservationPreflightFailureDoesNotPoisonGate(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	store, gate := &durablePlanStore{}, &selfTestParentGate{}
	owner := &durableSelfTestExecution{binding: binding, repository: store, gate: gate, preflight: func(context.Context) error { return errors.New("unavailable") }, execution: &selfTestExecution{owner: &durablePlanFake{ids: ids}}}
	if owner.reserveForStart(context.Background()) {
		t.Fatal("failed preflight admitted")
	}
	gate.wait()
	if gate.disposition() != "settled" || store.admits != 0 {
		t.Fatal("pre-admission refusal poisoned gate")
	}
}

func TestDurableSelfTestAdmissionPrecedesEveryChildAndNeverReplays(t *testing.T) {
	for _, mode := range []string{"success", "existing prepared", "admission lost", "save lost", "preflight refused"} {
		t.Run(mode, func(t *testing.T) {
			ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
			binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
			store, owner := &durablePlanStore{}, &durablePlanFake{ids: ids}
			if mode == "existing prepared" {
				store.record, _ = state.RestoreSelfTest(binding, state.Prepared, nil)
			}
			if mode == "admission lost" {
				store.admitErr = errors.New("lost")
			}
			if mode == "save lost" {
				store.saveErr = errors.New("lost")
			}
			preflight := func(context.Context) error {
				if mode == "preflight refused" {
					return errors.New("refused")
				}
				return nil
			}
			d := &durableSelfTestExecution{binding: binding, repository: store, preflight: preflight, execution: &selfTestExecution{owner: owner}}
			out := d.execute(context.Background())
			if mode == "success" {
				if out.Status != "partial" || owner.calls != 7 || store.saves != 1 || store.record.Phase() != state.Completed {
					t.Fatal(out, owner.calls, store.saves)
				}
			} else if out.Status != "unknown" {
				t.Fatal("unconfirmed success", out)
			}
			if mode == "save lost" && (owner.calls != 7 || store.saves != 1 || store.record.Phase() != state.Prepared) {
				t.Fatal("lost save rewritten")
			}
			if mode != "success" && mode != "save lost" && owner.calls != 0 {
				t.Fatal("children dispatched without admission")
			}
			before, admits := owner.calls, store.admits
			out = d.execute(context.Background())
			if owner.calls != before || store.admits != admits || (mode == "success" && out.Status != "partial") || (mode != "success" && out.Status != "unknown") {
				t.Fatal("repeat executed", out)
			}
		})
	}
}

func TestDurableSelfTestLostParentAdmissionFencesAnotherRun(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: ids.run, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	store, owner, gate := &durablePlanStore{admitErr: errors.New("lost admission")}, &durablePlanFake{ids: ids}, &selfTestParentGate{}
	makeExecution := func() *durableSelfTestExecution {
		return &durableSelfTestExecution{binding: binding, repository: store, preflight: func(context.Context) error { return nil }, gate: gate, execution: &selfTestExecution{owner: owner}}
	}
	if out := makeExecution().execute(context.Background()); out.Status != "unknown" || store.admits != 1 || owner.calls != 0 {
		t.Fatal("lost admission", out)
	}
	store.admitErr = nil
	if out := makeExecution().execute(context.Background()); out.Status != "unknown" || store.admits != 1 || owner.calls != 0 {
		t.Fatal("unknown allowed new admission", out)
	}
}
