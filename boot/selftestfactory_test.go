package boot

import (
	"context"
	"testing"
)

type factoryJournal struct {
	*chatMutationJournal
	*durablePlanStore
}

// Injected connector and storage. This verifies selection, not native effects.
func TestSelfTestFactorySelectsExactConnectorWithoutAdmission(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
	if err != nil || execution == nil || execution.binding.Identity.OperationID != id || execution.binding.WorkspaceID != "work" || execution.binding.Version != 4 || store.durablePlanStore.admits != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("factory selected or admitted incorrectly", err)
	}
	if err := execution.preflight(context.Background()); err != nil {
		t.Fatal("current owner refused", err)
	}
	changed := in.Publication
	changed.Generation = "99"
	if out, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, changed); err == nil || out != nil {
		t.Fatal("changed publication accepted")
	}
	if _, err := s.newConnectorSelfTest(context.Background(), s.current, "work", "invalid", in.Publication); err == nil {
		t.Fatal("invalid identity accepted")
	}
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if execution.preflight(context.Background()) == nil || store.durablePlanStore.admits != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("closed owner accepted")
	}
}
