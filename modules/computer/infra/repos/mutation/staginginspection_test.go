package mutation

import (
	"bytes"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestKnownSelfTestTerminalDoesNotHideUnknownScratchCleanup(t *testing.T) {
	_, disk, creation, cleanup := cleanupFixture(t)
	unknown, err := domain.RestoreScratchCleanup(cleanup.Binding(), domain.OutcomeUnknown, &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRaw, err := encodeScratchCleanup(unknown)
	if err != nil {
		t.Fatal(err)
	}
	cleanupKey, _ := scratchCleanupKey(creation.Binding().Identity)
	disk.files[cleanupKey] = cleanupRaw
	b := domain.SelfTestBinding{Identity: creation.Binding().Identity, WorkspaceID: creation.Binding().WorkspaceID, ComputerGeneration: creation.Binding().ComputerGeneration, Version: 2}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	markerRaw, _ := encodeSelfTestMarker(marker)
	markerKey, _ := selfTestMarkerKey(b)
	disk.files[markerKey] = markerRaw
	parent, _ := domain.RestoreSelfTest(b, domain.Failed, &domain.SelfTestResult{Status: "failed", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "fail", Operation: b.Identity.OperationID}}})
	parentRaw, _ := encodeSelfTest(parent)
	parentKey, _ := selfTestKey(b.Identity)
	disk.files[parentKey] = parentRaw
	entries := make([]settledBytes, 0, len(disk.files))
	for key, raw := range disk.files {
		entries = append(entries, settledBytes{key: key, raw: bytes.Clone(raw)})
	}
	allowed, err := qualifyStagingHistory(entries, SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"})
	if err != nil || allowed {
		t.Fatal("unknown cleanup admitted", allowed, err)
	}
}

func TestStagingHistoryRequiresCompleteOldWritableCleanup(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	for _, kind := range []string{"read-reservation", "write-reservation", "clean-terminal", "clean-v6", "group-only-terminal", "unknown-terminal"} {
		t.Run(kind, func(t *testing.T) {
			value := terminalValue([]byte("retained output"), nil)
			value.Intent.Seal.Write = kind != "read-reservation"
			key, _ := recordKey(processIdentity(value.Scope, value.Intent.OperationID))
			var raw []byte
			var chunks []processOutputPublication
			var err error
			if kind == "read-reservation" || kind == "write-reservation" {
				raw, err = encodeProcess(value.Scope, value.Intent)
			} else {
				if kind == "clean-v6" {
					value.Observation.Supervisor = processsvc.SupervisorExited
				}
				if kind == "group-only-terminal" {
					value.Observation.Supervisor = processsvc.SupervisorExited
					value.Observation.DescendantCleanup = processsvc.CleanupUnverified
				}
				if kind == "unknown-terminal" {
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
			eligible, err := qualifyStagingHistory(entries, selection)
			want := kind == "read-reservation" || kind == "clean-terminal" || kind == "clean-v6"
			if err != nil || eligible != want {
				t.Fatalf("eligibility %s: %v %v", kind, eligible, err)
			}
			if !bytes.Equal(entries[0].raw, raw) {
				t.Fatal("original record changed")
			}
		})
	}
	if ok, err := qualifyStagingHistory(nil, selection); err != nil || !ok {
		t.Fatal("empty valid history", err)
	}
	if ok, err := qualifyStagingHistory([]settledBytes{{key: "bad", raw: []byte("invalid")}}, selection); err == nil || ok {
		t.Fatal("corrupt inventory accepted")
	}
}

func TestStagingHistoryMixedInventoryNeverHidesUnknown(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	entries := []settledBytes{}
	for i, confirmed := range []bool{true, false} {
		value := terminalValue(nil, nil)
		value.Intent.OperationID = []string{"first-operation", "second-operation"}[i]
		value.Intent.Seal.Write = true
		value.Observation.Supervisor = processsvc.SupervisorExited
		if !confirmed {
			value.Observation.DescendantCleanup = processsvc.CleanupUnverified
		}
		raw, chunks, err := encodeProcessTerminal(value)
		if err != nil || len(chunks) != 0 {
			t.Fatal(err)
		}
		key, err := recordKey(processIdentity(value.Scope, value.Intent.OperationID))
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, settledBytes{key, bytes.Clone(raw)})
	}
	for _, order := range [][]settledBytes{entries, {entries[1], entries[0]}} {
		if ok, err := qualifyStagingHistory(order, selection); err != nil || ok {
			t.Fatal("mixed history admitted", ok, err)
		}
	}
}
