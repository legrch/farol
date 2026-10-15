package modelpolicy_test

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	infra "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

var _ port.TaskModelPolicyDecoder = infra.JSONDecoder{}
var _ port.TaskModelPolicyDigester = infra.SHA256Digester{}

// Static fixtures derive from owner-config/contract.ts and the independent Chat
// golden vector. They prove local policy compatibility, not live execution.
const policy = `{"defaultHarness":"browser","harnesses":{"future":{"defaultModel":"small","models":{"small":{"model":"fixture/future"}}},"browser":{"defaultModel":"small","models":{"wide":{"model":"fixture/wide","defaultEffort":"high"},"small":{"model":"fixture/small","defaultEffort":"medium"},"plain":{"model":"fixture/no-effort"}}}}}`
const reordered = ` { "harnesses": { "browser": { "models": { "plain": {"model":"fixture/no-effort"}, "small":{"defaultEffort":"medium","model":"fixture/small"},"wide":{"defaultEffort":"high","model":"fixture/wide"}}, "defaultModel":"small"}, "future":{"models":{"small":{"model":"fixture/future"}},"defaultModel":"small"}}, "defaultHarness":"browser"} `
const canonical = `["farol-task-policy/1","browser",[["browser","small",[["plain","fixture/no-effort",null],["small","fixture/small","medium"],["wide","fixture/wide","high"]]],["future","small",[["small","fixture/future",null]]]]]`
const goldenSHA256 = "5d867c69e7c53e6d7990743608cf091b905492879ff70b818c6c055fa32784be"

type captureDigest struct{ bytes []byte }

func (d *captureDigest) Digest(raw []byte) (string, error) {
	d.bytes = append([]byte(nil), raw...)
	return (infra.SHA256Digester{}).Digest(raw)
}

func service() *app.Service {
	return app.New(infra.JSONDecoder{}, infra.SHA256Digester{}, []string{"browser"})
}

func TestOwnerConfigSourceVectors(t *testing.T) {
	// Verbatim values from tests/fixtures/task-policy.ts; no TS runtime is used.
	const owner = `{"defaultHarness":"codex","harnesses":{"codex":{"defaultModel":"luna","models":{"luna":{"model":"gpt-6-luna","defaultEffort":"medium"},"sol":{"model":"gpt-6-sol","defaultEffort":"high"},"simple":{"model":"fixture-no-effort"}}}}}`
	s := app.New(infra.JSONDecoder{}, infra.SHA256Digester{}, []string{"codex"})
	for _, tc := range []struct{ request, alias, model, effort string }{
		{`{}`, "luna", "gpt-6-luna", "medium"},
		{`{"model":"sol","effort":"xhigh"}`, "sol", "gpt-6-sol", "xhigh"},
		{`{"model":"sol"}`, "sol", "gpt-6-sol", "high"},
		{`{"model":"simple"}`, "simple", "fixture-no-effort", ""},
	} {
		r := s.Resolve([]byte(owner), []byte(tc.request))
		if r.Status != app.Ready || r.Selection.Harness != "codex" || r.Selection.ModelAlias != tc.alias || r.Selection.Model != tc.model || (r.Selection.Effort == nil) != (tc.effort == "") {
			t.Fatal(r)
		}
		if tc.effort != "" && *r.Selection.Effort != tc.effort {
			t.Fatal(r)
		}
	}
	for _, tc := range []struct {
		request string
		want    app.Status
	}{
		{`{"harness":"unknown"}`, app.HarnessMissing},
		{`{"model":"unknown"}`, app.ModelMissing},
		{`{"effort":""}`, app.SelectionInvalid},
		{`{"harness":"constructor"}`, app.HarnessMissing},
		{`{"model":"constructor"}`, app.ModelMissing},
	} {
		if r := s.Resolve([]byte(owner), []byte(tc.request)); r.Status != tc.want {
			t.Fatal(r)
		}
	}
	if r := s.Resolve(nil, []byte(`{}`)); r.Status != app.ConfigMissing {
		t.Fatal(r)
	}
	const controlled = `{"defaultHarness":"browser","harnesses":{"browser":{"defaultModel":"chatgpt","models":{"chatgpt":{"model":"controlled-model","defaultEffort":"low"}}}}}`
	const identity = `["farol-task-policy/1","browser",[["browser","chatgpt",[["chatgpt","controlled-model","low"]]]]]`
	d := &captureDigest{}
	r := app.New(infra.JSONDecoder{}, d, []string{"browser"}).Resolve([]byte(controlled), []byte(`{}`))
	if r.Status != app.Ready || string(d.bytes) != identity || r.ConfigSHA256 != "5bf5b497b199cfac19cccadec8ca426f7da9cbbe97b96eeec15364b138809e3e" {
		t.Fatalf("controlled source vector: %+v, %s", r, d.bytes)
	}
}

func TestCanonicalIdentityGolden(t *testing.T) {
	for _, raw := range []string{policy, reordered} {
		d := &captureDigest{}
		s := app.New(infra.JSONDecoder{}, d, []string{"browser"})
		for _, request := range []string{`{}`, `{"model":"wide","effort":"max"}`, `{"model":"plain"}`} {
			r := s.Resolve([]byte(raw), []byte(request))
			if r.Status != app.Ready || r.ConfigSHA256 != goldenSHA256 || string(d.bytes) != canonical {
				t.Fatalf("golden mismatch: %+v, %s", r, d.bytes)
			}
		}
	}
	for _, replacement := range []struct{ from, to string }{
		{"fixture/future", "fixture/changed"},
		{`"model":"fixture/future"`, `"model":"fixture/future","defaultEffort":"future"`},
		{`"defaultHarness":"browser"`, `"defaultHarness":"future"`},
		{`"wide":{"model":"fixture/wide","defaultEffort":"high"}`, `"wide":{"model":"fixture/wide","defaultEffort":"high"},"extra":{"model":"fixture/extra"}`},
		{`"defaultModel":"small","models":{"wide"`, `"defaultModel":"plain","models":{"wide"`},
	} {
		r := service().Resolve([]byte(strings.Replace(policy, replacement.from, replacement.to, 1)), []byte(`{"harness":"browser"}`))
		if r.Status != app.Ready || r.ConfigSHA256 == goldenSHA256 {
			t.Fatalf("policy edit lost: %+v", r)
		}
	}
}

func TestDecoderMissingAndRequestObjects(t *testing.T) {
	d := infra.JSONDecoder{}
	for _, raw := range [][]byte{nil, {}, []byte("null"), []byte(" \nnull\t ")} {
		p, err := d.DecodePolicy(raw)
		if err != nil || p != nil {
			t.Fatalf("missing = %+v, %v", p, err)
		}
	}
	for _, raw := range []string{"", " ", "null", "[]", "true", "1", `"object"`} {
		if _, err := d.DecodeSelection([]byte(raw)); err == nil {
			t.Errorf("accepted request %q", raw)
		}
	}
	if _, err := d.DecodeSelection([]byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DecodePolicy([]byte(" ")); err == nil {
		t.Fatal("whitespace is malformed, not missing")
	}
}

func TestStrictSelectionJSON(t *testing.T) {
	for _, raw := range []string{
		`{"unknown":"x"}`, `{"Harness":"browser"}`, `{"harness":null}`, `{"model":null}`, `{"effort":null}`,
		`{"effort":1}`, `{"effort":true}`, `{"model":{}}`, `{"model":[]}`,
		`{"effort":"low","effort":"high"}`, `{"effort":"low","\u0065ffort":"high"}`,
		`{"effort":"\ud800"}`, `{"effort":"\udc00"}`, `{"effort":"\ud800x"}`, `{"effort":"\ud800\u0041"}`,
		"{\"effort\":\"\xff\"}", `{`, `{} {}`, `{"effort":"low",}`,
	} {
		t.Run(fmt.Sprintf("%q", raw), func(t *testing.T) {
			if _, err := (infra.JSONDecoder{}).DecodeSelection([]byte(raw)); err == nil {
				t.Fatal("invalid request decoded")
			}
			if r := service().Resolve([]byte(policy), []byte(raw)); r.Status != app.SelectionInvalid {
				t.Fatal(r)
			}
		})
	}
	// Well-formed surrogate pairs decode faithfully, then fail ASCII policy.
	request, err := (infra.JSONDecoder{}).DecodeSelection([]byte(`{"effort":"\ud83d\ude00"}`))
	if err != nil || request.Effort == nil || *request.Effort != "😀" {
		t.Fatalf("paired Unicode: %+v, %v", request, err)
	}
	if r := service().Resolve([]byte(policy), []byte(`{"effort":"\ud83d\ude00"}`)); r.Status != app.SelectionInvalid {
		t.Fatal(r)
	}
	// Escaped backslashes are literal characters, not malformed Unicode escapes.
	if _, err := (infra.JSONDecoder{}).DecodeSelection([]byte(`{"effort":"\\ud800"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestStrictPolicyJSON(t *testing.T) {
	for _, raw := range []string{
		`{}`, `[]`, `0`, `false`, `"policy"`, `{`, `null {}`,
		strings.Replace(policy, `"defaultHarness":"browser"`, `"defaultHarness":"browser","extra":"x"`, 1),
		strings.Replace(policy, `"defaultModel":"small"`, `"defaultModel":"small","extra":"x"`, 1),
		strings.Replace(policy, `"model":"fixture/future"`, `"model":"fixture/future","extra":"x"`, 1),
		strings.Replace(policy, `"defaultHarness":"browser"`, `"DefaultHarness":"browser"`, 1),
		strings.Replace(policy, `"defaultHarness":"browser"`, `"defaultHarness":"browser","defaultHarness":"browser"`, 1),
		strings.Replace(policy, `"models":{"small":{"model":"fixture/future"}}`, `"models":{"small":{"model":"fixture/future"},"small":{"model":"fixture/other"}}`, 1),
		strings.Replace(policy, `"defaultModel":"small"`, `"defaultModel":"small","defaultModel":"small"`, 1),
		strings.Replace(policy, `"model":"fixture/future"`, `"model":"fixture/future","model":"fixture/other"`, 1),
		strings.Replace(policy, `"model":"fixture/future"`, `"model":null`, 1),
		strings.Replace(policy, `"model":"fixture/future"`, `"model":42`, 1),
		strings.Replace(policy, `"model":"fixture/future"`, `"model":"\ud800"`, 1),
		strings.Replace(policy, `"defaultEffort":"high"`, `"defaultEffort":null`, 1),
		strings.Replace(policy, `"defaultEffort":"high"`, `"defaultEffort":false`, 1),
		strings.Replace(policy, `"harnesses":{`, `"harnesses":null,"extra":{`, 1),
		`{"defaultHarness":"browser","harnesses":{"browser":{"defaultModel":"small","models":{"small":{"model":{"deep":{"too":{"far":"x"}}}}}}}}`,
	} {
		t.Run(fmt.Sprintf("%q", raw), func(t *testing.T) {
			if _, err := (infra.JSONDecoder{}).DecodePolicy([]byte(raw)); err == nil {
				t.Fatal("invalid policy decoded")
			}
			if r := service().Resolve([]byte(raw), []byte(`{}`)); r.Status != app.ConfigInvalid {
				t.Fatal(r)
			}
		})
	}
}

func TestWireSemanticRefusals(t *testing.T) {
	for _, raw := range []string{
		strings.Replace(policy, `"defaultHarness":"browser"`, `"defaultHarness":"missing"`, 1),
		strings.Replace(policy, `"defaultEffort":"high"`, `"defaultEffort":""`, 1),
		strings.Replace(policy, `"model":"fixture/future"`, `"model":""`, 1),
		strings.Replace(policy, `"defaultModel":"small"`, `"defaultModel":"missing"`, 1),
		strings.Replace(policy, `"future":{`, `"Bad":{`, 1),
		strings.Replace(policy, `"small":{"model":"fixture/future"}`, `"__proto__":{"model":"fixture/future"}`, 1),
	} {
		if r := service().Resolve([]byte(raw), []byte(`{}`)); r.Status != app.ConfigInvalid {
			t.Fatalf("accepted %s: %+v", raw, r)
		}
	}
	for _, raw := range []string{`{"harness":""}`, `{"model":""}`, `{"effort":""}`, `{"model":"toString"}`, `{"model":"__proto__"}`} {
		if r := service().Resolve([]byte(policy), []byte(raw)); r.Status != app.SelectionInvalid {
			t.Fatal(r)
		}
	}
	for _, name := range []string{"constructor", "tostring", "hasownproperty"} {
		own := fmt.Sprintf(`{"defaultHarness":%q,"harnesses":{%q:{"defaultModel":%q,"models":{%q:{"model":"fixture/own"}}}}}`, name, name, name, name)
		s := app.New(infra.JSONDecoder{}, infra.SHA256Digester{}, []string{name})
		if r := s.Resolve([]byte(own), []byte(`{}`)); r.Status != app.Ready || r.Selection.Harness != name || r.Selection.ModelAlias != name {
			t.Fatal(r)
		}
		if r := service().Resolve([]byte(policy), []byte(fmt.Sprintf(`{"harness":%q}`, name))); r.Status != app.HarnessMissing {
			t.Fatal(r)
		}
	}
}

func TestWirePolicyCounts(t *testing.T) {
	for _, tc := range []struct {
		harnesses, models int
		want              app.Status
	}{
		{1, 1, app.Ready}, {16, 64, app.Ready},
		{0, 1, app.ConfigInvalid}, {17, 1, app.ConfigInvalid},
		{1, 0, app.ConfigInvalid}, {1, 65, app.ConfigInvalid},
	} {
		models := make([]string, tc.models)
		for i := range models {
			models[i] = fmt.Sprintf(`"m%d":{"model":"fixture/m"}`, i)
		}
		harnesses := make([]string, tc.harnesses)
		for i := range harnesses {
			harnesses[i] = fmt.Sprintf(`"h%d":{"defaultModel":"m0","models":{%s}}`, i, strings.Join(models, ","))
		}
		raw := fmt.Sprintf(`{"defaultHarness":"h0","harnesses":{%s}}`, strings.Join(harnesses, ","))
		s := app.New(infra.JSONDecoder{}, infra.SHA256Digester{}, []string{"h0"})
		if r := s.Resolve([]byte(raw), []byte(`{}`)); r.Status != tc.want {
			t.Fatalf("counts %d/%d: %+v", tc.harnesses, tc.models, r)
		}
	}
}

func TestRawWhitespaceBounds(t *testing.T) {
	s := service()
	exactPolicy := policy + strings.Repeat(" ", app.MaxPolicyBytes-len(policy))
	exactRequest := `{}` + strings.Repeat(" ", app.MaxSelectionBytes-2)
	if r := s.Resolve([]byte(exactPolicy), []byte(exactRequest)); r.Status != app.Ready {
		t.Fatal(r)
	}
	if r := s.Resolve([]byte(exactPolicy+" "), []byte(`{}`)); r.Status != app.ConfigInvalid {
		t.Fatal(r)
	}
	if r := s.Resolve([]byte(policy), []byte(exactRequest+" ")); r.Status != app.SelectionInvalid {
		t.Fatal(r)
	}
	if _, err := (infra.JSONDecoder{}).DecodePolicy([]byte(exactPolicy + " ")); err == nil {
		t.Fatal("decoder policy bound bypassed")
	}
	if _, err := (infra.JSONDecoder{}).DecodeSelection([]byte(exactRequest + " ")); err == nil {
		t.Fatal("decoder request bound bypassed")
	}
}

func TestNativeAdaptersConcurrentAndIndependent(t *testing.T) {
	s := service()
	config := []byte(policy)
	request := []byte(`{"effort":"future"}`)
	first := s.Resolve(config, request)
	for i := range config {
		config[i] = ' '
	}
	for i := range request {
		request[i] = ' '
	}
	if first.Status != app.Ready || *first.Selection.Effort != "future" || first.ConfigSHA256 != goldenSHA256 {
		t.Fatal(first)
	}
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			for range 20 {
				r := s.Resolve([]byte(policy), []byte(`{}`))
				if r.Status != app.Ready || r.ConfigSHA256 != goldenSHA256 || *r.Selection.Effort != "medium" {
					t.Error(r)
					return
				}
				*r.Selection.Effort = "caller"
				r.Selection.Model = "caller"
			}
		})
	}
	wg.Wait()
}
