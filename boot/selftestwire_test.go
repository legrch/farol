package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

// Tests use an injected plan and journal, never a live provider or workspace.
func TestSelfTestWireStartOnceAndObserveOriginal(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
	if err != nil {
		t.Fatal(err)
	}
	ids, _ := selfTestIDsV1(id)
	plan := &durablePlanFake{ids: ids}
	execution.execution = &selfTestExecution{owner: plan}
	s.selfTests.entries = map[string]*durableSelfTestExecution{id: execution}
	startBody, _ := json.Marshal(wire.ComputerSelfTestStart{Publication: in.Publication, WorkspaceId: "work"})
	start := desktop.Request{RequestID: "start", OperationID: id, Body: startBody}
	methods := s.Methods()
	for range 2 {
		out, err := methods["computer.selftest.start"].Handle(context.Background(), start)
		if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerSelfTestReport", out.Data) != nil {
			t.Fatal("start response", out, err)
		}
		var report wire.ComputerSelfTestReport
		if json.Unmarshal(out.Data, &report) != nil || report.OperationId != id || report.Status != "partial" || len(report.Steps) != 9 {
			t.Fatal("wrong report", report)
		}
	}
	if plan.calls != 7 || store.durablePlanStore.admits != 1 || store.durablePlanStore.saves != 1 || native.calls != 0 {
		t.Fatal("repeated child effects")
	}
	body, _ := json.Marshal(wire.ComputerSelfTestObserve{OperationId: id, WorkspaceId: "work", ComputerGeneration: in.Publication.Generation})
	out, err := methods["computer.selftest.observe"].Handle(context.Background(), desktop.Request{RequestID: "observe", Body: body})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerSelfTestReport", out.Data) != nil || plan.calls != 7 {
		t.Fatal("observation dispatched", out, err)
	}
	var report wire.ComputerSelfTestReport
	if json.Unmarshal(out.Data, &report) != nil || report.Status != "partial" {
		t.Fatal("stored result lost", report)
	}
}

func TestSelfTestWireRejectsMalformedRequestsBeforeAdmission(t *testing.T) {
	s, _, journal, native, _ := connectorMutationFixture(t)
	methods := s.Methods()
	for name, req := range map[string]desktop.Request{
		"computer.selftest.start":   {RequestID: "start", OperationID: "bad", Body: []byte(`{}`)},
		"computer.selftest.observe": {RequestID: "observe", OperationID: "unexpected", Body: []byte(`{}`)},
	} {
		out, err := methods[name].Handle(context.Background(), req)
		if err != nil || out == nil || out.Status != "refused" || journal.admits != 0 || native.calls != 0 {
			t.Fatal("malformed request admitted", name, out, err)
		}
	}
}
