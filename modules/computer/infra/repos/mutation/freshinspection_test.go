package mutation

import (
	"bytes"
	"context"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestFreshHistoryCancelledQualificationRefuses(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixtureForCancellation(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := qualifyProcessHistoryBoundedContext(ctx, entries, selection, len(entries)); err == nil {
		t.Fatal("cancelled qualification was accepted")
	}
}

func freshHistoryBoundaryFixtureForCancellation(t *testing.T) (SettledSelection, []settledBytes) {
	t.Helper()
	_, _, scope, intent := processFixture()
	raw, err := encodeProcess(scope, intent)
	if err != nil {
		t.Fatal(err)
	}
	key, err := recordKey(processIdentity(scope, intent.OperationID))
	if err != nil {
		t.Fatal(err)
	}
	return SettledSelection{OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID}, []settledBytes{{key: key, raw: raw}}
}

func TestFreshHistoryPreservesMarkerAndChecksSettledParent(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	key, _ := selfTestMarkerKey(b)
	for _, phase := range []domain.SelfTestMarkerPhase{domain.SelfTestMarkerSelected, domain.SelfTestMarkerSettling, domain.SelfTestMarkerSettled} {
		marker, _ := domain.RestoreSelfTestMarker(b, phase)
		raw, err := encodeSelfTestMarker(marker)
		if err != nil {
			t.Fatal(err)
		}
		entries := []settledBytes{{key: key, raw: raw}}
		_, err = qualifyFreshProcessHistory(entries, selection)
		if (phase != domain.SelfTestMarkerSelected) != (err != nil) {
			t.Fatal("invalid marker qualification", phase, err)
		}
		if phase == domain.SelfTestMarkerSelected {
			ok, err := qualifyStagingHistory(entries, selection)
			if err != nil || ok {
				t.Fatal("unsettled marker granted staging", phase, err)
			}
			continue
		}
		parent, err := domain.RestoreSelfTest(b, domain.Failed, &domain.SelfTestResult{Status: "failed", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "fail", Operation: scratchTestRun}}})
		if err != nil {
			t.Fatal(err)
		}
		parentRaw, _ := encodeSelfTest(parent)
		parentKey, _ := selfTestKey(b.Identity)
		entries = append(entries, settledBytes{key: parentKey, raw: parentRaw})
		if _, err := qualifyFreshProcessHistory(entries, selection); err != nil {
			t.Fatal("valid marker rejected", err)
		}
		if ok, err := qualifyStagingHistory(entries, selection); err != nil || ok != (phase == domain.SelfTestMarkerSettled) {
			t.Fatal("settled marker rejected", err)
		}
	}
}

func TestFreshHistoryRejectsSelectedMarkerBoundToDifferentParent(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	markerRaw, _ := encodeSelfTestMarker(marker)
	markerKey, _ := selfTestMarkerKey(b)
	b.WorkspaceID = "other"
	parent, _ := domain.RestoreSelfTest(b, domain.Prepared, nil)
	parentRaw, _ := encodeSelfTest(parent)
	parentKey, _ := selfTestKey(b.Identity)
	if _, err := qualifyFreshProcessHistory([]settledBytes{{key: markerKey, raw: markerRaw}, {key: parentKey, raw: parentRaw}}, selection); err == nil {
		t.Fatal("crossed binding accepted")
	}
}

func TestStagingHistoryAcceptsSelectedMarkerOnlyWithExactKnownTerminal(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	markerRaw, _ := encodeSelfTestMarker(marker)
	markerKey, _ := selfTestMarkerKey(b)
	for _, phase := range []domain.Phase{domain.Prepared, domain.OutcomeUnknown, domain.Failed} {
		var result *domain.SelfTestResult
		if phase == domain.OutcomeUnknown {
			result = &domain.SelfTestResult{Status: "unknown"}
		}
		if phase == domain.Failed {
			result = &domain.SelfTestResult{Status: "failed", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "fail", Operation: scratchTestRun}}}
		}
		parent, err := domain.RestoreSelfTest(b, phase, result)
		if err != nil {
			t.Fatal(err)
		}
		parentRaw, _ := encodeSelfTest(parent)
		parentKey, _ := selfTestKey(b.Identity)
		allowed, err := qualifyStagingHistory([]settledBytes{{key: markerKey, raw: markerRaw}, {key: parentKey, raw: parentRaw}}, selection)
		if err != nil || allowed != (phase == domain.Failed) {
			t.Fatal("incorrect marker qualification", phase, allowed, err)
		}
	}
}

func TestFreshProcessHistorySeparatesReservationExitAndCleanup(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	for _, kind := range []string{"read-reservation", "write-reservation", "clean-terminal", "group-only-terminal", "unconfirmed-terminal", "read-unconfirmed-terminal"} {
		t.Run(kind, func(t *testing.T) {
			value := terminalValue([]byte("retained output"), nil)
			value.Intent.Seal.Write = kind != "read-reservation" && kind != "read-unconfirmed-terminal"
			key, _ := recordKey(processIdentity(value.Scope, value.Intent.OperationID))
			var raw []byte
			var chunks []processOutputPublication
			var err error
			if kind == "read-reservation" || kind == "write-reservation" {
				raw, err = encodeProcess(value.Scope, value.Intent)
			} else {
				if kind == "group-only-terminal" {
					value.Observation.Supervisor = processsvc.SupervisorExited
					value.Observation.DescendantCleanup = processsvc.CleanupUnverified
				}
				if kind == "unconfirmed-terminal" || kind == "read-unconfirmed-terminal" {
					value.Observation.Supervisor = processsvc.SupervisorExited
					value.Observation.GroupCleanup, value.Observation.DescendantCleanup = processsvc.CleanupUnverified, processsvc.CleanupUnverified
				}
				raw, chunks, err = encodeProcessTerminal(value)
			}
			if err != nil {
				t.Fatal(err)
			}
			entries := []settledBytes{{key, bytes.Clone(raw)}}
			for _, chunk := range chunks {
				entries = append(entries, settledBytes{chunk.key, bytes.Clone(chunk.raw)})
			}
			unknown, err := qualifyFreshProcessHistory(entries, selection)
			wantUnknown := kind == "write-reservation" || kind == "unconfirmed-terminal"
			if err != nil || unknown != wantUnknown {
				t.Fatal("historical uncertainty blocked fresh work or was promoted to cleanup", unknown, err)
			}
			if !bytes.Equal(entries[0].raw, raw) {
				t.Fatal("retained operation was changed")
			}
			if len(chunks) > 0 {
				entries[1].raw[len(entries[1].raw)/2] ^= 1
				if _, err := qualifyFreshProcessHistory(entries, selection); err == nil {
					t.Fatal("corrupt output was hidden by a valid terminal")
				}
			}
			crossed := selection
			crossed.ComputerID = "other"
			if _, err := qualifyFreshProcessHistory(entries[:1], crossed); err == nil {
				t.Fatal("crossed old Computer identity admitted")
			}
		})
	}
}

func TestFreshProcessHistoryRefusesUnsupportedOrExcessInventory(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	for _, entries := range [][]settledBytes{
		make([]settledBytes, 2),
		{{key: "unknown", raw: []byte(`{"schemaVersion":99,"kind":"workspace_connector_process","record":{}}`)}},
	} {
		if _, err := qualifyFreshProcessHistory(entries, selection); err == nil {
			t.Fatal("unsupported history escaped complete inventory qualification", err)
		}
	}
}
