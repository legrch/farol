package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

const modelPolicyFixture = `{"defaultHarness":"codex","harnesses":{"codex":{"defaultModel":"small","models":{"small":{"model":"fixture-model","defaultEffort":"high"}}}}}`

func TestTaskModelPolicyUsesCompiledGoOwnerWithoutTaskActivation(t *testing.T) {
	method := taskModelPolicyMethods()["task.model.resolve"]
	raw := []byte(`{"revision":"9007199254740991","config":` + modelPolicyFixture + `,"selection":{}}`)
	out, err := method.Handle(context.Background(), desktop.Request{RequestID: "policy", Body: raw})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("TaskModelPolicyResponse", out.Data) != nil {
		t.Fatalf("missing Go policy response: %#v %v", out, err)
	}
	var response wire.TaskModelPolicyResponse
	if json.Unmarshal(out.Data, &response) != nil || response.Status != "ready" || response.Revision != "9007199254740991" || response.Selection == nil || response.Selection.Model != "fixture-model" || response.ConfigSha256 == nil {
		t.Fatalf("wrong policy binding: %#v", response)
	}
	if len(taskModelPolicyMethods()) != 1 {
		t.Fatal("pure policy composition must not activate Task/provider lifecycle")
	}
}

func TestTaskModelPolicyRequestBoundaries(t *testing.T) {
	method := taskModelPolicyMethods()["task.model.resolve"]
	for _, raw := range []string{
		`{}`, `{"revision":"01","config":null,"selection":{}}`,
		`{"revision":"1","config":null,"selection":{},"supportedHarnesses":["other"]}`,
		`{"revision":"1","config":null,"selection":{},"revision":"2"}`,
		`{"revision":"1","config":{"defaultHarness":"codex","defaultHarness":"other"},"selection":{}}`,
	} {
		out, err := method.Handle(context.Background(), desktop.Request{Body: []byte(raw)})
		if err != nil || out == nil || out.Status != "refused" {
			t.Fatalf("invalid boundary accepted: %s %#v %v", raw, out, err)
		}
	}
	raw := []byte(`{"revision":"1","config":null,"selection":{}}`)
	out, err := method.Handle(context.Background(), desktop.Request{OperationID: "effect", Body: raw})
	if err != nil || out == nil || out.Status != "refused" {
		t.Fatal("effect ID accepted on read-only policy")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err = method.Handle(ctx, desktop.Request{Body: raw})
	if err != nil || out == nil || out.Status != "unavailable" {
		t.Fatal("cancelled context disclosed policy")
	}
}
