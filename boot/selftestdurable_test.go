package boot

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type durablePlanStore struct {
	record            *state.SelfTestState
	admits, saves     int
	admitErr, saveErr error
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
