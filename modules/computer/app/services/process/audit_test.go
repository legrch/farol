package process

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProjectTerminalAuditPreservesFactsWithoutOutput(t *testing.T) {
	result, _, _, _, _ := retainedFixture([]byte("private-stdout"), []byte("private-stderr"))
	audit, ok := ProjectTerminalAudit(result)
	if !ok || audit.OperationID != result.Intent.OperationID || audit.BuildID != result.Scope.Host.BuildID || audit.RuntimeID != result.Scope.Host.RuntimeID || audit.ExitCode == nil || *audit.ExitCode != 4 || !audit.RootWaited || !audit.OutputDrained || !audit.TimedOut || !audit.AuthorityLost {
		t.Fatal("terminal facts not preserved")
	}
	*audit.ExitCode = 7
	if *result.Observation.ExitCode != 4 {
		t.Fatal("projection retained mutable exit pointer")
	}
	bytes, err := json.Marshal(audit)
	if err != nil || strings.Contains(string(bytes), "private-") || strings.Contains(string(bytes), "/workspace/") {
		t.Fatal("audit projection disclosed source data", err)
	}
}

func TestProjectTerminalAuditRefusesUnconfirmedResult(t *testing.T) {
	result, _, _, _, _ := retainedFixture(nil, nil)
	result.Observation.Waited = false
	if _, ok := ProjectTerminalAudit(result); ok {
		t.Fatal("unconfirmed terminal result projected")
	}
}

func TestProjectTerminalAuditKeepsUnverifiedCleanupAndSignal(t *testing.T) {
	result, _, _, _, _ := retainedFixture(nil, nil)
	result.Observation.ExitCode = nil
	result.Observation.ExitSignal = 9
	result.Observation.Supervisor = SupervisorExited
	result.Observation.GroupCleanup = CleanupUnverified
	result.Observation.DescendantCleanup = CleanupUnverified
	audit, ok := ProjectTerminalAudit(result)
	if !ok || audit.ExitCode != nil || audit.ExitSignal != 9 || audit.GroupCleanup != CleanupUnverified || audit.DescendantCleanup != CleanupUnverified {
		t.Fatal("signal or cleanup facts were promoted or lost")
	}
}
