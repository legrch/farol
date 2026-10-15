package modelpolicy_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	contract "github.com/legrch/farol/modules/task/contracts/modelpolicy"
	native "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

const catalogueConfig = `{"defaultHarness":"codex","harnesses":{"codex":{"defaultModel":"z","models":{"z":{"model":"present","defaultEffort":"high"},"a":{"model":"missing"},"b":{"model":"present"}}}}}`
const catalogueReady = `{"status":"ready","source":"model/list","scope":"fixture","observedAt":0,"models":[{"id":"one","model":"present","displayName":"First","hidden":true,"supportedEfforts":[]},{"id":"two","model":"present","displayName":"Second","hidden":false,"supportedEfforts":["high"]}]}`

func newCatalogue() *contract.CatalogueContract {
	return contract.NewCatalogue(app.New(native.JSONDecoder{}, native.SHA256Digester{}, []string{"codex"}), native.JSONDecoder{})
}
func describe(t *testing.T, config, catalogue string) *contract.CatalogueResponse {
	t.Helper()
	out, err := newCatalogue().Describe(context.Background(), contract.CatalogueRequest{Config: []byte(config), Catalogue: []byte(catalogue), Harness: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestCatalogueProjectionAndWire(t *testing.T) {
	out := describe(t, catalogueConfig, catalogueReady)
	if out.ConfigError != nil || len(out.Configured) != 3 {
		t.Fatalf("unexpected view %+v", out)
	}
	for i, want := range []struct {
		alias, available string
		effort           bool
	}{{"z", "yes", false}, {"a", "no", false}, {"b", "yes", true}} {
		row := out.Configured[i]
		if row.Alias != want.alias || row.Available != want.available || row.EffortAvailable == nil || *row.EffortAvailable != want.effort {
			t.Fatalf("row %+v", row)
		}
	}
	if !out.Catalogue.Models[0].Hidden || out.Catalogue.Models[1].ID != "two" {
		t.Fatal("observations changed")
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"harness":"codex","catalogue":` + catalogueReady + `,"configError":null,"configured":[{"alias":"z","model":"present","defaultEffort":"high","available":"yes","effortAvailable":false},{"alias":"a","model":"missing","available":"no","effortAvailable":false},{"alias":"b","model":"present","available":"yes","effortAvailable":true}]}`
	if string(raw) != want {
		t.Fatalf("wire:\n%s\nwant:\n%s", raw, want)
	}
	unavailable := describe(t, catalogueConfig, `{"status":"unavailable","code":"FIXTURE_OFFLINE"}`)
	for _, row := range unavailable.Configured {
		if row.Available != "unknown" || row.EffortAvailable != nil {
			t.Fatalf("unavailable row %+v", row)
		}
	}
	raw, _ = json.Marshal(unavailable)
	if !strings.Contains(string(raw), `"catalogue":{"status":"unavailable","code":"FIXTURE_OFFLINE"}`) {
		t.Fatalf("unavailable wire %s", raw)
	}
}
func TestCatalogueConfigurationValidationAndOrder(t *testing.T) {
	invalid := []string{"", `null`, `{}`, strings.Replace(catalogueConfig, `"model":"present"`, `"model":"invalid space"`, 1), strings.Replace(catalogueConfig, `"harnesses":{`, `"harnesses":{"other":{"defaultModel":"x","models":{"x":{"model":"invalid space"}}},`, 1)}
	for _, config := range invalid {
		out := describe(t, config, catalogueReady)
		if out.ConfigError == nil || *out.ConfigError != "TASK_MODEL_CONFIG_UNAVAILABLE" || len(out.Configured) != 0 || out.Catalogue.Models[0].ID != "one" {
			t.Fatalf("invalid config view %+v", out)
		}
		raw, _ := json.Marshal(out)
		if !strings.Contains(string(raw), `"configured":[]`) {
			t.Fatalf("nil array: %s", raw)
		}
	}
	other := strings.ReplaceAll(catalogueConfig, "codex", "other")
	out := describe(t, other, catalogueReady)
	if out.ConfigError == nil {
		t.Fatal("missing harness accepted")
	}
	aliases := make([]string, 64)
	for i := range aliases {
		aliases[i] = fmt.Sprintf(`"alias-%02d":{"model":"present"}`, 63-i)
	}
	config := `{"defaultHarness":"codex","harnesses":{"codex":{"defaultModel":"alias-63","models":{` + strings.Join(aliases, ",") + `}}}}`
	out = describe(t, config, catalogueReady)
	if len(out.Configured) != 64 {
		t.Fatal("wrong count")
	}
	for i, row := range out.Configured {
		if row.Alias != fmt.Sprintf("alias-%02d", 63-i) {
			t.Fatalf("source ordering lost: %v", out.Configured)
		}
	}
}
func TestCatalogueEmptyAndEffortCases(t *testing.T) {
	empty := `{"status":"ready","source":"model/list","scope":"fixture","observedAt":0,"models":[]}`
	out := describe(t, catalogueConfig, empty)
	for _, row := range out.Configured {
		if row.Available != "no" || row.EffortAvailable == nil || *row.EffortAvailable {
			t.Fatalf("empty row %+v", row)
		}
	}
	config := strings.Replace(catalogueConfig, `"defaultEffort":"high"`, `"defaultEffort":"low"`, 1)
	runtime := strings.Replace(catalogueReady, `"supportedEfforts":[]`, `"supportedEfforts":["low"],"defaultEffort":"high"`, 1)
	out = describe(t, config, runtime)
	if !*out.Configured[0].EffortAvailable {
		t.Fatal("supported configured effort rejected")
	}
	raw, _ := json.Marshal(describe(t, "null", empty))
	if !strings.Contains(string(raw), `"models":[]`) {
		t.Fatalf("empty models %s", raw)
	}
}

type cancellingCatalogue struct {
	native.JSONDecoder
	cancel context.CancelFunc
}

func (d cancellingCatalogue) DecodeCatalogue(raw []byte) (port.TaskRuntimeCatalogue, error) {
	out, err := d.JSONDecoder.DecodeCatalogue(raw)
	d.cancel()
	return out, err
}
func TestCatalogueCancellationAndFailures(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := contract.CatalogueRequest{Config: []byte(catalogueConfig), Catalogue: []byte(catalogueReady), Harness: "codex"}
	ctxAfter, cancelAfter := context.WithCancel(context.Background())
	after := contract.NewCatalogue(app.New(native.JSONDecoder{}, nil, nil), cancellingCatalogue{cancel: cancelAfter})
	for _, tt := range []struct {
		contract *contract.CatalogueContract
		ctx      context.Context
	}{{nil, context.Background()}, {newCatalogue(), nil}, {newCatalogue(), ctx}, {after, ctxAfter}, {contract.NewCatalogue(nil, native.JSONDecoder{}), context.Background()}, {contract.NewCatalogue(app.New(native.JSONDecoder{}, nil, nil), nil), context.Background()}} {
		if out, err := tt.contract.Describe(tt.ctx, request); out != nil || err == nil || err.Error() != "TASK_MODEL_CATALOGUE_UNAVAILABLE" {
			t.Fatalf("unexpected %v %v", out, err)
		}
	}
	for _, bad := range []contract.CatalogueRequest{{Harness: "Bad", Catalogue: request.Catalogue}, {Harness: "codex", Catalogue: []byte(`null`)}} {
		if out, err := newCatalogue().Describe(context.Background(), bad); out != nil || err == nil || err.Error() != "TASK_MODEL_CATALOGUE_INVALID" {
			t.Fatalf("unexpected invalid %v %v", out, err)
		}
	}
}
func TestCatalogueDoesNotChangeResolution(t *testing.T) {
	service := app.New(native.JSONDecoder{}, native.SHA256Digester{}, []string{"codex"})
	before := service.Resolve([]byte(catalogueConfig), []byte(`{}`))
	if _, err := service.Describe([]byte(catalogueConfig), "codex", []byte(catalogueReady), native.JSONDecoder{}); err != nil {
		t.Fatal(err)
	}
	after := service.Resolve([]byte(catalogueConfig), []byte(`{}`))
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if string(a) != string(b) || after.Status != app.Ready {
		t.Fatalf("resolution changed %s %s", a, b)
	}
}
