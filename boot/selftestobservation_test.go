package boot

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type observationHistoryJournal struct {
	*factoryJournal
	entries   []port.SelfTestHistoryEntry
	markers   []port.SelfTestMarkerHistoryEntry
	afterList func()
	err       error
}

func (j *observationHistoryJournal) ListSelfTestMarkers(_ context.Context, _, _, _ string) ([]port.SelfTestMarkerHistoryEntry, error) {
	if j.afterList != nil {
		j.afterList()
	}
	return j.markers, j.err
}

func TestSelfTestMarkerHistoryChecksCurrentAuthorityAndNeverDispatches(t *testing.T) {
	for _, mode := range []string{"current", "revoked", "other", "unavailable", "bad-phase", "unauthorized-empty"} {
		t.Run(mode, func(t *testing.T) {
			s, access, journal, native, in := connectorMutationFixture(t)
			store := &observationHistoryJournal{factoryJournal: &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}}
			s.mutations.dependencies.repository = store
			execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", "00000000-0000-4000-8000-000000000001", in.Publication)
			if err != nil {
				t.Fatal(err)
			}
			binding := execution.binding
			if mode == "other" {
				binding.WorkspaceID = "other"
			}
			store.markers = []port.SelfTestMarkerHistoryEntry{{Binding: binding, Phase: state.SelfTestMarkerSelected}}
			if mode == "bad-phase" {
				store.markers[0].Phase = "invalid"
			}
			if mode == "revoked" {
				store.afterList = func() { access.approval.Generation++; access.PutApproval(access.approval) }
			}
			if mode == "unavailable" {
				store.err = errors.New("unavailable")
			}
			workspace := "work"
			if mode == "unauthorized-empty" {
				workspace = "other"
				store.markers = nil
			}
			out, err := s.listConnectorSelfTestMarkers(context.Background(), s.current, workspace)
			switch mode {
			case "current":
				if err != nil || len(out) != 1 || out[0].Binding != binding {
					t.Fatal("marker missing", out, err)
				}
			case "other":
				if err != nil || len(out) != 0 {
					t.Fatal("marker disclosed", out, err)
				}
			default:
				if err == nil || out != nil {
					t.Fatal("invalid inventory disclosed", out, err)
				}
			}
			if store.markerAdmissions != 0 || journal.admits != 0 || native.calls != 0 {
				t.Fatal("observation caused effect")
			}
		})
	}
}

func (j *observationHistoryJournal) ListSelfTests(_ context.Context, _, _, _ string) ([]port.SelfTestHistoryEntry, error) {
	if j.afterList != nil {
		j.afterList()
	}
	return j.entries, j.err
}

func TestSelfTestHistoryDisclosesOnlyCurrentWorkspaceUnderReadAuthority(t *testing.T) {
	for _, mode := range []string{"current", "revoked", "unavailable", "other-workspace", "invalid-phase", "unauthorized-empty"} {
		t.Run(mode, func(t *testing.T) {
			s, access, journal, native, in := connectorMutationFixture(t)
			store := &observationHistoryJournal{factoryJournal: &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}}
			s.mutations.dependencies.repository = store
			const id = "00000000-0000-4000-8000-000000000001"
			execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
			if err != nil {
				t.Fatal(err)
			}
			binding := execution.binding
			if mode == "other-workspace" {
				binding.WorkspaceID = "other"
			}
			store.entries = []port.SelfTestHistoryEntry{{Binding: binding, Phase: state.OutcomeUnknown}}
			if mode == "invalid-phase" {
				store.entries[0].Phase = "invalid"
			}
			workspace := "work"
			if mode == "unauthorized-empty" {
				store.entries = nil
				workspace = "other"
			}
			if mode == "revoked" {
				store.afterList = func() { access.approval.Generation++; access.PutApproval(access.approval) }
			}
			if mode == "unavailable" {
				store.err = errors.New("unavailable")
			}
			out, err := s.listConnectorSelfTests(context.Background(), s.current, workspace)
			switch mode {
			case "current":
				if err != nil || len(out) != 1 || out[0].Binding != binding || out[0].Phase != state.OutcomeUnknown {
					t.Fatal("original missing", out, err)
				}
			case "other-workspace":
				if err != nil || len(out) != 0 {
					t.Fatal("other workspace disclosed", out, err)
				}
			default:
				if err == nil || out != nil {
					t.Fatal("unqualified history disclosed", out, err)
				}
			}
			if store.durablePlanStore.admits != 0 || journal.admits != 0 || native.calls != 0 {
				t.Fatal("history caused effects")
			}
		})
	}
}

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
