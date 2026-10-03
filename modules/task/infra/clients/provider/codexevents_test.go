package provider

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/legrch/farol/modules/task/domain"
	"strings"
	"testing"
)

func eventSelection() CodexEventSelection {
	return CodexEventSelection{Binding: task.Binding{Provider: task.Codex, ProfileID: "profile", HostID: "host", ProjectID: "project", WorkspaceID: "writer", Project: task.Root{Path: "/project", Device: "1", Inode: "1", GitCommonDirectory: "/git"}, Writer: task.Root{Path: "/writer", Device: "1", Inode: "2", GitCommonDirectory: "/git"}, ModelAlias: "selected", Model: "model", ConfigDigest: "digest"}, RunID: "run", DispatchID: "dispatch", StreamID: "stream", Generation: 1, Reference: task.Reference{ThreadID: "thread", TurnID: "turn"}}
}
func TestCodexFactsDistinguishRuntimeReceiptsClaimsAndPlan(t *testing.T) {
	var events []task.ExecutionEvent
	mapper, err := NewCodexEvents(eventSelection(), func(context.Context, task.Binding) error { return nil }, func(_ context.Context, e task.ExecutionEvent) error { events = append(events, e); return nil }, func() uint64 { return 100 })
	if err != nil {
		t.Fatal(err)
	}
	frames := []string{
		`{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}`,
		`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"command","type":"commandExecution","status":"completed","exitCode":0,"command":"PRIVATE_COMMAND","aggregatedOutput":"PRIVATE_OUTPUT"}}}`,
		`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"claim","type":"agentMessage","text":"Tests passed PRIVATE_TRANSCRIPT"}}}`,
		`{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","explanation":"PRIVATE_EXPLANATION","plan":[{"step":"PRIVATE_STEP","status":"completed"},{"step":"remaining","status":"pending"}]}}`,
		`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"reason","type":"reasoning","text":"HIDDEN_REASONING"}}}`,
		`{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed","items":[]}}}`,
	}
	for n, raw := range frames {
		if err := mapper.Record(context.Background(), uint64(n+1), []byte(raw)); err != nil {
			t.Fatal(err)
		}
	}
	if len(events) != 5 || events[1].Source != task.ToolReceiptEvidence || !events[1].HasExitCode || events[2].Source != task.AdvisoryEvidence || events[3].Kind != task.CheckpointReady || events[3].CompletedSteps != 1 || events[4].Kind != task.ProviderTerminal {
		t.Fatal(events)
	}
	bytes, _ := json.Marshal(events)
	for _, private := range []string{"PRIVATE_COMMAND", "PRIVATE_OUTPUT", "PRIVATE_TRANSCRIPT", "PRIVATE_EXPLANATION", "PRIVATE_STEP", "HIDDEN_REASONING"} {
		if strings.Contains(string(bytes), private) {
			t.Fatal("retained private body", private)
		}
	}
}
func TestSelectedCodexEventRejectsForeignMalformedAndDeniedInput(t *testing.T) {
	for _, raw := range []string{
		`{"method":"turn/started","params":{"threadId":"other","turn":{"id":"turn"}}}`,
		`{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"other"}}}`,
		`{"method":"turn/started","method":"turn/completed","params":{}}`,
		`{"id":1,"method":"item/commandExecution/requestApproval","params":{}}`,
		`{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","plan":null}}`,
		`{"method":"turn/plan/updated","params":{"threadId":"thread","turnId":"turn","plan": null }}`,
		`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"PRIVATE BODY","type":"agentMessage"}}}`,
		`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"command","type":"commandExecution","status":"completed","exitCode":-1}}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			mapper, _ := NewCodexEvents(eventSelection(), func(context.Context, task.Binding) error { return nil }, func(context.Context, task.ExecutionEvent) error { t.Fatal("bad input reached journal"); return nil }, func() uint64 { return 100 })
			if err := mapper.Record(context.Background(), 1, []byte(raw)); err == nil {
				t.Fatal("invalid event accepted")
			}
		})
	}
	mapper, _ := NewCodexEvents(eventSelection(), func(context.Context, task.Binding) error { return task.ErrIdentity }, func(context.Context, task.ExecutionEvent) error { t.Fatal("revoked event recorded"); return nil }, func() uint64 { return 100 })
	if err := mapper.Record(context.Background(), 1, []byte(`{}`)); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
}

func TestNullCommandExitNeverBecomesZeroReceipt(t *testing.T) {
	var captured task.ExecutionEvent
	mapper, _ := NewCodexEvents(eventSelection(), func(context.Context, task.Binding) error { return nil }, func(_ context.Context, e task.ExecutionEvent) error { captured = e; return nil }, func() uint64 { return 100 })
	err := mapper.Record(context.Background(), 1, []byte(`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"command","type":"commandExecution","status":"completed","exitCode": null }}}`))
	if err != nil || captured.HasExitCode || captured.Source != task.RuntimeEvidence {
		t.Fatal("null promoted to receipt", captured, err)
	}
}

func TestContradictoryToolCompletionKeepsIdentityAndConflicts(t *testing.T) {
	var log task.EventLog
	mapper, _ := NewCodexEvents(eventSelection(), func(context.Context, task.Binding) error { return nil }, func(_ context.Context, e task.ExecutionEvent) error {
		var err error
		log, err = log.Append(e, task.Codex)
		return err
	}, func() uint64 { return 100 })
	for n, code := range []string{"0", "1"} {
		raw := `{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"command","type":"commandExecution","status":"completed","exitCode":` + code + `}}}`
		err := mapper.Record(context.Background(), uint64(n+1), []byte(raw))
		if n == 0 && err != nil || n == 1 && !errors.Is(err, task.ErrConflict) {
			t.Fatal("contradiction became another event", log, err)
		}
	}
	if len(log.Events) != 1 || log.Events[0].ExitCode != 0 {
		t.Fatal("first receipt overwritten", log)
	}
}
