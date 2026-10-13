//go:build darwin

package mutation

import (
	"context"
	"errors"
	"strings"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"golang.org/x/sys/unix"
)

const beforeMachineSession = "00000000-0000-4000-8000-000000000001"
const afterMachineSession = "00000000-0000-4000-8000-000000000002"

func coldPreservedFixture(t *testing.T) (Root, SettledSelection, []ExpectedPreservedRecord, []settledBytes) {
	selection, expected, entries := preservedResultFixture(t, true)
	value := terminalValue(nil, nil)
	value.Intent.OperationID = "known-result"
	value.Intent.Seal.Write = true
	value.Observation.Supervisor = processsvc.SupervisorExited
	value.Observation.GroupCleanup = processsvc.CleanupUnverified
	value.Observation.DescendantCleanup = processsvc.CleanupUnverified
	raw, _, err := encodeProcessTerminal(value)
	if err != nil {
		t.Fatal(err)
	}
	expected, entries = expected[:5], entries[:5]
	entries[4].raw = raw
	expected[4].SHA256 = preservedDigest(raw)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	return root, selection, expected, entries
}

// Real descriptor/lock storage with a SYNTHETIC kernel transition. No reboot,
// installed recovery, live cleanup or original terminal acknowledgment is proven.
func TestPreservedColdMachineFixtureKeepsUnverifiedWriteResults(t *testing.T) {
	root, selection, expected, _ := coldPreservedFixture(t)
	snapshot := settledNativeSnapshot(t, root.Path)
	calls := 0
	result, err := inspectPreservedAfterMachineRestart(context.Background(), root, selection, expected, beforeMachineSession, func(meta PreservedInspection) error {
		calls++
		if len(meta.Retained) != 5 || meta.ReservedProcesses != 1 {
			t.Fatal("bad inventory")
		}
		return nil
	}, func() (string, error) { return afterMachineSession, nil })
	if err != nil || result == nil || calls != 1 {
		t.Fatal("synthetic exclusion refused", err)
	}
	settledNativePreserved(t, root.Path, snapshot)
	if result, err := InspectPreserved(context.Background(), root, selection, expected, func(PreservedInspection) error { t.Fatal("ordinary recovery bypassed write fence"); return nil }); err == nil || result != nil {
		t.Fatal("ordinary recovery admitted old write")
	}
}

func TestPreservedColdMachineFixtureRefusesAbsentSameOrChangingSession(t *testing.T) {
	for _, name := range []string{"same", "unavailable", "malformed", "changes-before-visitor", "changes-after-visitor"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, _ := coldPreservedFixture(t)
			snapshot := settledNativeSnapshot(t, root.Path)
			reads, calls := 0, 0
			read := func() (string, error) {
				reads++
				switch name {
				case "same":
					return beforeMachineSession, nil
				case "unavailable":
					return "", errors.New("unavailable")
				case "malformed":
					return "not-a-session", nil
				case "changes-before-visitor":
					if reads >= 3 {
						return beforeMachineSession, nil
					}
				case "changes-after-visitor":
					if reads >= 4 {
						return beforeMachineSession, nil
					}
				}
				return afterMachineSession, nil
			}
			result, err := inspectPreservedAfterMachineRestart(context.Background(), root, selection, expected, beforeMachineSession, func(PreservedInspection) error { calls++; return nil }, read)
			if err == nil || result != nil || name != "changes-after-visitor" && calls != 0 {
				t.Fatal("unverified transition accepted")
			}
			settledNativePreserved(t, root.Path, snapshot)
		})
	}
}

func TestPreservedColdMachineRealSameKernelSessionRefuses(t *testing.T) {
	current, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		t.Fatal(err)
	}
	root, selection, expected, _ := coldPreservedFixture(t)
	result, err := InspectPreservedAfterMachineRestart(context.Background(), root, selection, expected, strings.ToLower(strings.TrimSpace(current)), func(PreservedInspection) error { t.Fatal("same native kernel session admitted"); return nil })
	if err == nil || result != nil {
		t.Fatal("ordinary app restart became machine proof")
	}
}
