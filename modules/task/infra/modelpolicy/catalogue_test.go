package modelpolicy

import (
	"encoding/json"
	"strings"
	"testing"
)

const readyCatalogue = `{"status":"ready","source":"model/list","scope":"test","observedAt":0,"models":[{"id":"id","model":"gpt-5","displayName":"Name","hidden":false,"supportedEfforts":["high"],"defaultEffort":"high"}]}`

func TestCatalogueStrictBoundary(t *testing.T) {
	cases := map[string]string{
		"empty": "", "null": "null", "array": "[]", "trailing": readyCatalogue + ` {}`,
		"unknown":           strings.Replace(readyCatalogue, `"scope":`, `"extra":true,"scope":`, 1),
		"duplicate":         strings.Replace(readyCatalogue, `"scope":`, `"scope":"old","scope":`, 1),
		"escaped duplicate": strings.Replace(readyCatalogue, `"scope":`, `"sc\u006fpe":"old","scope":`, 1),
		"missing source":    strings.Replace(readyCatalogue, `"source":"model/list",`, ``, 1),
		"wrong source":      strings.Replace(readyCatalogue, `model/list`, `other`, 1),
		"null models":       strings.Replace(readyCatalogue, `[{"id"`, `null,"unexpected":[{"id"`, 1),
		"missing models":    `{"status":"ready","source":"model/list","scope":"test","observedAt":0}`,
		"missing hidden":    strings.Replace(readyCatalogue, `"hidden":false,`, ``, 1),
		"null hidden":       strings.Replace(readyCatalogue, `"hidden":false`, `"hidden":null`, 1),
		"missing efforts":   strings.Replace(readyCatalogue, `"supportedEfforts":["high"],`, ``, 1),
		"null efforts":      strings.Replace(readyCatalogue, `["high"]`, `null`, 1),
		"null optional":     strings.Replace(readyCatalogue, `"defaultEffort":"high"`, `"defaultEffort":null`, 1),
		"invalid effort":    strings.Replace(readyCatalogue, `["high"]`, `["has space"]`, 1),
		"runtime ascii":     strings.Replace(readyCatalogue, `gpt-5`, `gépt`, 1),
		"fraction":          strings.Replace(readyCatalogue, `"observedAt":0`, `"observedAt":0.5`, 1),
		"negative":          strings.Replace(readyCatalogue, `"observedAt":0`, `"observedAt":-1`, 1),
		"unsafe":            strings.Replace(readyCatalogue, `"observedAt":0`, `"observedAt":9007199254740992`, 1),
		"overflow":          strings.Replace(readyCatalogue, `"observedAt":0`, `"observedAt":1e999`, 1),
		"string time":       strings.Replace(readyCatalogue, `"observedAt":0`, `"observedAt":"0"`, 1),
		"high surrogate":    strings.Replace(readyCatalogue, `"Name"`, `"\ud800"`, 1),
		"low surrogate":     strings.Replace(readyCatalogue, `"Name"`, `"\udc00"`, 1),
		"utf8":              strings.Replace(readyCatalogue, `Name`, string([]byte{0xff}), 1),
		"missing code":      `{"status":"unavailable"}`, "null code": `{"status":"unavailable","code":null}`,
		"empty code": `{"status":"unavailable","code":""}`, "unknown unavailable": `{"status":"unavailable","code":"x","models":[]}`,
		"nested duplicate": strings.Replace(readyCatalogue, `"hidden":false`, `"hidden":true,"hidden":false`, 1),
		"models null":      `{"status":"ready","source":"model/list","scope":"x","observedAt":0,"models":null}`,
		"oversize wire":    strings.Repeat(" ", 1<<20) + readyCatalogue,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := (JSONDecoder{}).DecodeCatalogue([]byte(raw)); err == nil {
				t.Fatal("accepted invalid catalogue")
			}
		})
	}
	for _, raw := range []string{readyCatalogue, `{"status":"unavailable","code":"CODE"}`, `{"status":"ready","source":"model/list","scope":"x","observedAt":9007199254740991,"models":[]}`, strings.Replace(readyCatalogue, `"Name"`, `"\ud83d\ude80"`, 1), strings.Replace(readyCatalogue, `"observedAt":0`, `"observedAt":1e0`, 1)} {
		if _, err := (JSONDecoder{}).DecodeCatalogue([]byte(raw)); err != nil {
			t.Fatalf("rejected valid catalogue %s: %v", raw, err)
		}
	}
}

func TestCatalogueUTF16AndWidths(t *testing.T) {
	var value map[string]any
	if err := json.Unmarshal([]byte(readyCatalogue), &value); err != nil {
		t.Fatal(err)
	}
	model := value["models"].([]any)[0].(map[string]any)
	tests := []struct {
		field  string
		max    int
		target map[string]any
	}{{"scope", 240, value}, {"id", 160, model}, {"displayName", 240, model}}
	for _, tt := range tests {
		original := tt.target[tt.field]
		for _, s := range []string{strings.Repeat("é", tt.max), strings.Repeat("🚀", tt.max/2)} {
			tt.target[tt.field] = s
			raw, _ := json.Marshal(value)
			if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err != nil {
				t.Fatalf("%s valid UTF16 units rejected: %v", tt.field, err)
			}
			tt.target[tt.field] = s + "a"
			raw, _ = json.Marshal(value)
			if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err == nil {
				t.Fatalf("%s oversized accepted", tt.field)
			}
		}
		tt.target[tt.field] = original
	}
	for _, count := range []int{32, 33} {
		efforts := make([]string, count)
		for i := range efforts {
			efforts[i] = "high"
		}
		model["supportedEfforts"] = efforts
		raw, _ := json.Marshal(value)
		_, err := (JSONDecoder{}).DecodeCatalogue(raw)
		if (err == nil) != (count == 32) {
			t.Fatalf("effort count %d: %v", count, err)
		}
	}
	model["supportedEfforts"] = []string{}
	for _, count := range []int{2000, 2001} {
		models := make([]any, count)
		for i := range models {
			models[i] = model
		}
		value["models"] = models
		raw, _ := json.Marshal(value)
		_, err := (JSONDecoder{}).DecodeCatalogue(raw)
		if (err == nil) != (count == 2000) {
			t.Fatalf("model count %d: %v", count, err)
		}
	}
}

func TestModelOrderUsesObjectSourceOrder(t *testing.T) {
	raw := []byte(`{"defaultHarness":"codex","harnesses":{"codex":{"defaultModel":"z","models":{"z":{"model":"m"},"a":{"model":"m"},"b":{"model":"m"}}}}}`)
	order, err := (JSONDecoder{}).ModelOrder(raw, "codex")
	if err != nil || strings.Join(order, ",") != "z,a,b" {
		t.Fatalf("order %v, %v", order, err)
	}
	for _, bad := range [][]byte{nil, []byte(`null`), []byte(strings.Replace(string(raw), `"a":{"model":"m"}`, `"z":{"model":"m"}`, 1))} {
		if _, err := (JSONDecoder{}).ModelOrder(bad, "codex"); err == nil {
			t.Fatal("accepted invalid config")
		}
	}
	if _, err := (JSONDecoder{}).ModelOrder(raw, "missing"); err == nil {
		t.Fatal("accepted missing harness")
	}
}

func TestCatalogueRequiredAndUnknownFields(t *testing.T) {
	for _, field := range []string{"status", "source", "scope", "observedAt", "models"} {
		var value map[string]any
		if err := json.Unmarshal([]byte(readyCatalogue), &value); err != nil {
			t.Fatal(err)
		}
		delete(value, field)
		raw, _ := json.Marshal(value)
		if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err == nil {
			t.Fatalf("missing %s accepted", field)
		}
	}
	for _, field := range []string{"id", "model", "displayName", "hidden", "supportedEfforts"} {
		var value map[string]any
		if err := json.Unmarshal([]byte(readyCatalogue), &value); err != nil {
			t.Fatal(err)
		}
		delete(value["models"].([]any)[0].(map[string]any), field)
		raw, _ := json.Marshal(value)
		if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err == nil {
			t.Fatalf("missing model %s accepted", field)
		}
	}
	raw := strings.Replace(readyCatalogue, `"hidden":false`, `"hidden":false,"extra":true`, 1)
	if _, err := (JSONDecoder{}).DecodeCatalogue([]byte(raw)); err == nil {
		t.Fatal("unknown model field accepted")
	}
}

func TestCatalogueWireLimitAndUnavailableText(t *testing.T) {
	raw := append([]byte(strings.Repeat(" ", (1<<20)-len(readyCatalogue))), []byte(readyCatalogue)...)
	if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err != nil {
		t.Fatalf("exact limit rejected: %v", err)
	}
	if _, err := (JSONDecoder{}).DecodeCatalogue(append(raw, ' ')); err == nil {
		t.Fatal("over limit accepted")
	}
	for _, code := range []string{strings.Repeat("é", 120), strings.Repeat("🚀", 60)} {
		raw, _ := json.Marshal(map[string]any{"status": "unavailable", "code": code})
		if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err != nil {
			t.Fatalf("valid code rejected: %v", err)
		}
		raw, _ = json.Marshal(map[string]any{"status": "unavailable", "code": code + "x"})
		if _, err := (JSONDecoder{}).DecodeCatalogue(raw); err == nil {
			t.Fatal("long code accepted")
		}
	}
}
