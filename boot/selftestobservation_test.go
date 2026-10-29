package boot

import (
	"context"
	"testing"

	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestObservationReadsOnlyOriginalUnderCurrentAuthority(t *testing.T) {
	s, access, journal, native, in := connectorMutationFixture(t)
	store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
	if err != nil {
		t.Fatal(err)
	}
	store.record, err = state.RestoreSelfTest(execution.binding, state.Prepared, nil)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.observeConnectorSelfTest(context.Background(), s.current, execution.binding)
	if err != nil || out.Status != "unknown" || store.durablePlanStore.loads != 1 || store.durablePlanStore.admits != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("observation changed attempt", out, err)
	}
	store.record, err = state.RestoreSelfTest(execution.binding, state.Failed, &state.SelfTestResult{Status: "failed", Steps: []state.SelfTestStep{{Name: "scratch", Status: "fail", Operation: id, Code: "WORKSPACE_MUTATION_CONFLICT"}}})
	if err != nil {
		t.Fatal(err)
	}
	out, err = s.observeConnectorSelfTest(context.Background(), s.current, execution.binding)
	if err != nil || out.Status != "fail" || len(out.Steps) != 1 || out.Steps[0].Code != "WORKSPACE_MUTATION_CONFLICT" {
		t.Fatal("stored result changed", out, err)
	}
	store.durablePlanStore.afterLoad = func() { access.approval.Generation++; access.PutApproval(access.approval) }
	out, err = s.observeConnectorSelfTest(context.Background(), s.current, execution.binding)
	if err == nil || out.Status != "unknown" || len(out.Steps) != 0 {
		t.Fatal("withdrawn authority disclosed result", out, err)
	}
}
