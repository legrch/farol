package mutation

import (
	"bytes"
	"errors"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func TestFreshProcessHistorySeparatesReservationExitAndCleanup(t *testing.T) {
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	for _, kind := range []string{"read-reservation", "write-reservation", "clean-terminal", "unconfirmed-terminal", "read-unconfirmed-terminal"} {
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
			err = qualifyFreshProcessHistory(entries, selection)
			blocked := kind == "write-reservation" || kind == "unconfirmed-terminal"
			if blocked && !errors.Is(err, ErrFreshProcessScopeUnavailable) || !blocked && err != nil {
				t.Fatal("cwd or root exit supplied missing original scope/cleanup authority", err)
			}
			if !bytes.Equal(entries[0].raw, raw) {
				t.Fatal("retained operation was changed")
			}
			if len(chunks) > 0 {
				entries[1].raw[len(entries[1].raw)/2] ^= 1
				if err := qualifyFreshProcessHistory(entries, selection); err == nil || errors.Is(err, ErrFreshProcessScopeUnavailable) {
					t.Fatal("corrupt output was hidden by a valid terminal")
				}
			}
			crossed := selection
			crossed.ComputerID = "other"
			if err := qualifyFreshProcessHistory(entries[:1], crossed); err == nil || errors.Is(err, ErrFreshProcessScopeUnavailable) {
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
		if err := qualifyFreshProcessHistory(entries, selection); err == nil || errors.Is(err, ErrFreshProcessScopeUnavailable) {
			t.Fatal("unsupported history escaped complete inventory qualification", err)
		}
	}
}
