package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

func TestTaskCurrentSettingsComparisonWithoutTaskActivation(t *testing.T) {
	methods := taskCurrentSettingsMethods()
	method := methods["task.settings.compare"]
	body, err := json.Marshal(wire.TaskCurrentSettingsCompareRequest{BeforeRevision: "9007199254740991", CandidateRevision: "0", Before: `{"status":"settings-invalid"}`, Candidate: `{"status":"settings-invalid"}`})
	if err != nil {
		t.Fatal(err)
	}
	out, err := method.Handle(context.Background(), desktop.Request{RequestID: "compare", Body: body})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("TaskCurrentSettingsCompareResponse", out.Data) != nil {
		t.Fatalf("missing comparison: %#v %v", out, err)
	}
	var response wire.TaskCurrentSettingsCompareResponse
	if json.Unmarshal(out.Data, &response) != nil || response.Changed || response.BeforeRevision != "9007199254740991" || response.CandidateRevision != "0" || len(methods) != 1 {
		t.Fatalf("crossed comparison or unexpected activation: %#v", response)
	}
}

func TestTaskCurrentSettingsComparisonRefusesMalformedRead(t *testing.T) {
	method := taskCurrentSettingsMethods()["task.settings.compare"]
	for _, data := range []string{
		`{}`, `{"beforeRevision":"01","candidateRevision":"2","before":"{}","candidate":"{}"}`,
		`{"beforeRevision":"1","candidateRevision":"2","before":"{}","candidate":"{}","changed":false}`,
		`{"beforeRevision":"1","candidateRevision":"2","before":"{}","candidate":"{}","beforeRevision":"3"}`,
	} {
		out, err := method.Handle(context.Background(), desktop.Request{Body: []byte(data)})
		if err != nil || out == nil || out.Status != "refused" {
			t.Fatalf("malformed read accepted: %s %#v %v", data, out, err)
		}
	}
	data := []byte(`{"beforeRevision":"1","candidateRevision":"2","before":"{}","candidate":"{}"}`)
	for _, request := range []desktop.Request{{OperationID: "effect", Body: data}} {
		out, err := method.Handle(context.Background(), request)
		if err != nil || out == nil || out.Status != "refused" {
			t.Fatal("effect identifier accepted")
		}
	}
	out, err := method.Handle(context.Background(), desktop.Request{Body: data})
	if err != nil || out == nil || out.Status != "unavailable" {
		t.Fatal("malformed inner facts treated as equal")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err = method.Handle(ctx, desktop.Request{Body: data})
	if err != nil || out == nil || out.Status != "unavailable" {
		t.Fatal("canceled comparison returned a decision")
	}
}
