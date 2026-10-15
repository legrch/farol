package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

const catalogueFixture = `{"status":"ready","source":"model/list","scope":"fixture-account","observedAt":1,"models":[{"id":"fixture","model":"fixture-model","displayName":"Fixture","hidden":true,"supportedEfforts":["high"]}]}`

func TestTaskModelCatalogueUsesTaskGoOwnerWithoutLifecycle(t *testing.T) {
	methods := taskModelCatalogueMethods()
	method := methods["task.models.describe"]
	if len(methods) != 1 || !method.Concurrent {
		t.Fatal("catalogue read must not activate Task lifecycle")
	}
	raw := []byte(`{"revision":"7","config":` + modelPolicyFixture + `,"harness":"codex","catalogue":` + catalogueFixture + `}`)
	out, err := method.Handle(context.Background(), desktop.Request{Body: raw})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("TaskModelCatalogueResponse", out.Data) != nil {
		t.Fatalf("Go catalogue unavailable: %#v %v", out, err)
	}
	var response wire.TaskModelCatalogueResponse
	if json.Unmarshal(out.Data, &response) != nil || response.Revision != "7" {
		t.Fatal("wrong revision")
	}
	var view struct {
		Harness     string  `json:"harness"`
		ConfigError *string `json:"configError"`
		Configured  []struct {
			Alias           string `json:"alias"`
			Available       string `json:"available"`
			EffortAvailable *bool  `json:"effortAvailable"`
		} `json:"configured"`
	}
	if json.Unmarshal(response.View, &view) != nil || view.Harness != "codex" || view.ConfigError != nil || len(view.Configured) != 1 || view.Configured[0].Alias != "small" || view.Configured[0].Available != "yes" || view.Configured[0].EffortAvailable == nil || !*view.Configured[0].EffortAvailable {
		t.Fatalf("wrong Task-owned availability: %s", response.View)
	}
}

func TestTaskModelCatalogueIngressAndCancellation(t *testing.T) {
	method := taskModelCatalogueMethods()["task.models.describe"]
	for _, raw := range []string{
		`{}`, `{"revision":"01","config":null,"harness":"codex","catalogue":{}}`,
		`{"revision":"1","config":null,"harness":"codex","catalogue":{},"grant":true}`,
		`{"revision":"1","revision":"2","config":null,"harness":"codex","catalogue":{}}`,
		`{"revision":"1","config":{"x":1,"x":2},"harness":"codex","catalogue":{}}`,
	} {
		out, err := method.Handle(context.Background(), desktop.Request{Body: []byte(raw)})
		if err != nil || out == nil || out.Status != "refused" {
			t.Fatalf("invalid ingress accepted: %s %#v %v", raw, out, err)
		}
	}
	raw := []byte(`{"revision":"1","config":null,"harness":"codex","catalogue":` + catalogueFixture + `}`)
	out, err := method.Handle(context.Background(), desktop.Request{OperationID: "effect", Body: raw})
	if err != nil || out == nil || out.Status != "refused" {
		t.Fatal("catalogue accepted effect identity")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err = method.Handle(ctx, desktop.Request{Body: raw})
	if err != nil || out == nil || out.Status != "unavailable" {
		t.Fatal("canceled read disclosed catalogue")
	}
}
