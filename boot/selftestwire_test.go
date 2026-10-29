package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
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
	ids, _ := selfTestIDsV4(id)
	plan := &durablePlanFake{ids: ids}
	execution.execution = &selfTestExecution{owner: plan, version: 4}
	s.selfTests.entries = map[string]*durableSelfTestExecution{id: execution}
	startBody, _ := json.Marshal(wire.ComputerSelfTestStart{Publication: in.Publication, WorkspaceId: "work"})
	start := desktop.Request{RequestID: "start", OperationID: id, Body: startBody}
	methods := s.Methods()
	marked, err := methods["computer.selftest.marker.begin"].Handle(context.Background(), desktop.Request{RequestID: "marker", OperationID: id, Body: startBody})
	if err != nil || marked == nil || marked.Status != "ok" || store.markerAdmissions != 1 {
		t.Fatal("marker admission failed", marked, err)
	}
	reserved, err := methods["computer.selftest.reserve"].Handle(context.Background(), desktop.Request{RequestID: "reserve", OperationID: id, Body: startBody})
	if err != nil || reserved == nil || reserved.Status != "ok" || wire.Validate("ComputerSelfTestObserve", reserved.Data) != nil || plan.calls != 0 || store.durablePlanStore.admits != 1 {
		t.Fatal("reservation did not durably precede start", reserved, err)
	}
	for range 2 {
		out, err := methods["computer.selftest.start"].Handle(context.Background(), start)
		if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerSelfTestReport", out.Data) != nil {
			t.Fatal("start response", out, err)
		}
		var report wire.ComputerSelfTestReport
		if json.Unmarshal(out.Data, &report) != nil || report.OperationId != id || report.Status != "partial" || len(report.Steps) != 15 {
			t.Fatal("wrong report", report)
		}
		if report.PlanVersion == nil || *report.PlanVersion != "4" || report.Steps[9].Name != "directory search" || report.Steps[9].Status != "pass" || report.Steps[9].OperationId == nil || *report.Steps[9].OperationId != ids.directorySearch || report.Steps[13].Name != "git availability" || report.Steps[13].Status != "pass" || report.Steps[13].OperationId == nil || *report.Steps[13].OperationId != ids.gitVersion || report.Steps[14].Name != "git and hooks" || report.Steps[14].Status != "not_tested" {
			t.Fatal("directory coverage or remaining limits misreported", report)
		}
	}
	if plan.calls != 14 || store.durablePlanStore.admits != 1 || store.durablePlanStore.saves != 1 || native.calls != 0 {
		t.Fatal("repeated child effects")
	}
	version := "4"
	body, _ := json.Marshal(wire.ComputerSelfTestObserve{OperationId: id, WorkspaceId: "work", ComputerGeneration: in.Publication.Generation, PlanVersion: &version})
	out, err := methods["computer.selftest.observe"].Handle(context.Background(), desktop.Request{RequestID: "observe", Body: body})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerSelfTestReport", out.Data) != nil || plan.calls != 14 {
		t.Fatal("observation dispatched", out, err)
	}
	var report wire.ComputerSelfTestReport
	if json.Unmarshal(out.Data, &report) != nil || report.Status != "partial" {
		t.Fatal("stored result lost", report)
	}
}

func TestSelfTestWireObservesVersionTwoWithoutReinterpretingOldRecords(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
	if err != nil {
		t.Fatal(err)
	}
	binding := execution.binding
	binding.Version = 2
	store.record, err = state.RestoreSelfTest(binding, state.Failed, &state.SelfTestResult{Status: "failed", Steps: []state.SelfTestStep{{Name: "scratch", Status: "fail", Operation: id}}})
	if err != nil {
		t.Fatal(err)
	}
	method := s.Methods()["computer.selftest.observe"]
	version := "2"
	input := wire.ComputerSelfTestObserve{OperationId: id, WorkspaceId: "work", ComputerGeneration: in.Publication.Generation, PlanVersion: &version}
	body, _ := json.Marshal(input)
	out, err := method.Handle(context.Background(), desktop.Request{RequestID: "observe", Body: body})
	var report wire.ComputerSelfTestReport
	if err != nil || out == nil || out.Status != "ok" || json.Unmarshal(out.Data, &report) != nil || report.PlanVersion == nil || *report.PlanVersion != "2" || report.Status != "fail" {
		t.Fatal("version two history not observed", out, err)
	}
	input.PlanVersion = nil // Old clients explicitly retain version-one semantics.
	body, _ = json.Marshal(input)
	out, err = method.Handle(context.Background(), desktop.Request{RequestID: "old-observe", Body: body})
	if err != nil || out == nil || out.Status != "unavailable" || journal.admits != 0 || native.calls != 0 {
		t.Fatal("wrong version disclosed or dispatched", out, err)
	}
}

func TestSelfTestWireRejectsMalformedRequestsBeforeAdmission(t *testing.T) {
	s, _, journal, native, _ := connectorMutationFixture(t)
	methods := s.Methods()
	for name, req := range map[string]desktop.Request{
		"computer.selftest.marker.history": {RequestID: "markers", OperationID: "unexpected", Body: []byte(`{}`)},
		"computer.selftest.marker.begin":   {RequestID: "marker", OperationID: "bad", Body: []byte(`{}`)},
		"computer.selftest.history":        {RequestID: "history", OperationID: "unexpected", Body: []byte(`{}`)},
		"computer.selftest.reserve":        {RequestID: "reserve", OperationID: "bad", Body: []byte(`{}`)},
		"computer.selftest.start":          {RequestID: "start", OperationID: "bad", Body: []byte(`{}`)},
		"computer.selftest.observe":        {RequestID: "observe", OperationID: "unexpected", Body: []byte(`{}`)},
	} {
		out, err := methods[name].Handle(context.Background(), req)
		if err != nil || out == nil || out.Status != "refused" || journal.admits != 0 || native.calls != 0 {
			t.Fatal("malformed request admitted", name, out, err)
		}
	}
}

func TestSelfTestWireMarkerHistoryReadsOriginalSelection(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &observationHistoryJournal{factoryJournal: &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
	if err != nil {
		t.Fatal(err)
	}
	store.markers = []port.SelfTestMarkerHistoryEntry{{Binding: execution.binding, Phase: state.SelfTestMarkerSettling}}
	body, _ := json.Marshal(wire.ComputerSelfTestHistoryRequest{WorkspaceId: "work"})
	out, err := s.Methods()["computer.selftest.marker.history"].Handle(context.Background(), desktop.Request{RequestID: "markers", Body: body})
	var result wire.ComputerSelfTestMarkerHistory
	if err != nil || out == nil || out.Status != "ok" || json.Unmarshal(out.Data, &result) != nil || len(result.Entries) != 1 || result.Entries[0].Selection.OperationId != id || result.Entries[0].Phase != "settling" {
		t.Fatal("marker not observed", out, err)
	}
	if store.markerAdmissions != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("history caused effects")
	}
}

func TestSelfTestWireHistoryReturnsOriginalWithoutExecution(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &observationHistoryJournal{factoryJournal: &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
	if err != nil {
		t.Fatal(err)
	}
	store.entries = []port.SelfTestHistoryEntry{{Binding: execution.binding, Phase: state.Prepared}}
	body, _ := json.Marshal(wire.ComputerSelfTestHistoryRequest{WorkspaceId: "work"})
	out, err := s.Methods()["computer.selftest.history"].Handle(context.Background(), desktop.Request{RequestID: "history", Body: body})
	var history wire.ComputerSelfTestHistory
	if err != nil || out == nil || out.Status != "ok" || json.Unmarshal(out.Data, &history) != nil || len(history.Entries) != 1 || history.Entries[0].Selection.OperationId != id || history.Entries[0].Phase != "prepared" {
		t.Fatal("original history not observed", out, err)
	}
	if store.durablePlanStore.admits != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("history caused effects")
	}
}

func TestSelfTestWireStartRequiresOriginalLiveReservation(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	body, _ := json.Marshal(wire.ComputerSelfTestStart{Publication: in.Publication, WorkspaceId: "work"})
	methods := s.Methods()
	out, err := methods["computer.selftest.start"].Handle(context.Background(), desktop.Request{RequestID: "start", OperationID: id, Body: body})
	if err != nil || out == nil || out.Status != "refused" || store.durablePlanStore.admits != 0 || native.calls != 0 {
		t.Fatal("unreserved start dispatched", out, err)
	}
	// A durable Prepared record read after restart never supplies a live permit.
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: id, OwnerID: s.root.ownerID, ProfileID: s.root.peer.ProfileId, ComputerID: s.root.computerID}, WorkspaceID: "work", ComputerGeneration: 3, Version: 2}
	store.record, err = state.RestoreSelfTest(binding, state.Prepared, nil)
	if err != nil {
		t.Fatal(err)
	}
	out, err = methods["computer.selftest.reserve"].Handle(context.Background(), desktop.Request{RequestID: "reserve", OperationID: id, Body: body})
	if err != nil || out == nil || out.Status != "refused" || store.durablePlanStore.admits != 0 || native.calls != 0 {
		t.Fatal("old reservation became a permit", out, err)
	}
	store.marker, err = state.RestoreSelfTestMarker(binding, state.SelfTestMarkerSelected)
	if err != nil {
		t.Fatal(err)
	}
	out, err = methods["computer.selftest.marker.begin"].Handle(context.Background(), desktop.Request{RequestID: "marker", OperationID: id, Body: body})
	if err != nil || out == nil || out.Status != "unknown" || store.markerAdmissions != 1 || store.durablePlanStore.admits != 0 {
		t.Fatal("old marker granted permit", out, err)
	}
	out, err = methods["computer.selftest.start"].Handle(context.Background(), desktop.Request{RequestID: "late-start", OperationID: id, Body: body})
	if err != nil || out == nil || native.calls != 0 || store.durablePlanStore.saves != 0 {
		t.Fatal("old reservation executed", out, err)
	}
}
