package mutation

import (
	"bytes"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

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
		make([]settledBytes, maxPreservedRecords+1),
		{{key: "unknown", raw: []byte(`{"schemaVersion":99,"kind":"workspace_connector_process","record":{}}`)}},
	} {
		if _, err := qualifyFreshProcessHistory(entries, selection); err == nil {
			t.Fatal("unsupported history escaped complete inventory qualification", err)
		}
	}
}
