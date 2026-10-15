package currentsettings

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
)

const minimal = `{"status":"parsed","tasks":null,"nativeHosts":{"generation":"0","route":null,"host":null},"computer":{"computerId":"computer","generation":"9007199254740991","workspaces":[]},"setup":{"verified":null,"reachable":"unknown","outcomeUnknown":false}}`

func withTasks(s string) []byte {
	return []byte(strings.Replace(minimal, `"tasks":null`, `"tasks":`+s, 1))
}
func TestStrictBoundary(t *testing.T) {
	for name, raw := range map[string][]byte{
		"empty": nil, "null": []byte(`null`), "array": []byte(`[]`), "missing": []byte(`{"status":"parsed"}`),
		"unknown":           []byte(`{"status":"settings-invalid","tasks":null}`),
		"duplicate":         []byte(`{"status":"settings-invalid","status":"settings-invalid"}`),
		"escaped duplicate": []byte(`{"status":"settings-invalid","sta\u0074us":"settings-invalid"}`),
		"nested duplicate":  withTasks(`{"a":1,"a":2}`),
		"trailing":          append([]byte(minimal), []byte(` null`)...),
		"invalid UTF8":      withTasks("\"" + string([]byte{0xff}) + "\""),
		"high surrogate":    withTasks(`"\ud800"`), "low surrogate": withTasks(`"\udfff"`),
		"unpaired nested key": withTasks(`{"\ud800":1}`), "unpaired separated": withTasks(`"\ud800x\udfff"`),
		"numeric generation":  []byte(strings.Replace(minimal, `"generation":"0"`, `"generation":0`, 1)),
		"unsafe generation":   []byte(strings.Replace(minimal, `"generation":"0"`, `"generation":"9007199254740992"`, 1)),
		"negative generation": []byte(strings.Replace(minimal, `"generation":"0"`, `"generation":"-1"`, 1)),
		"leading zero":        []byte(strings.Replace(minimal, `"generation":"0"`, `"generation":"00"`, 1)),
		"fraction generation": []byte(strings.Replace(minimal, `"generation":"0"`, `"generation":"0.1"`, 1)),
		"unknown native":      []byte(strings.Replace(minimal, `"route":null`, `"route":null,"extra":true`, 1)),
		"wrong route":         []byte(strings.Replace(minimal, `"route":null`, `"route":{}`, 1)),
		"wrong host":          []byte(strings.Replace(minimal, `"host":null`, `"host":false`, 1)),
		"wrong workspace":     []byte(strings.Replace(minimal, `"workspaces":[]`, `"workspaces":[{}]`, 1)),
		"wrong reachable":     []byte(strings.Replace(minimal, `"reachable":"unknown"`, `"reachable":"ready"`, 1)),
		"wrong verified":      []byte(strings.Replace(minimal, `"verified":null`, `"verified":{}`, 1)),
		"wrong unknown flag":  []byte(strings.Replace(minimal, `"outcomeUnknown":false`, `"outcomeUnknown":"false"`, 1)),
	} {
		t.Run(name, func(t *testing.T) {
			if f, err := (JSONDecoder{}).Decode(raw); err == nil || f.Status != "" {
				t.Fatalf("malformed boundary accepted: %s", name)
			}
		})
	}
	for _, input := range [][]byte{[]byte(minimal), []byte(`{"status":"settings-invalid"}`), withTasks(`"\ud83d\ude00"`), withTasks(`{"arbitrary-invalid-policy":[1,1.5,1e100000,true,null]}`)} {
		if _, err := (JSONDecoder{}).Decode(input); err != nil {
			t.Fatalf("valid transport rejected: %v", err)
		}
	}
}
func TestExactBounds(t *testing.T) {
	for _, tc := range []struct {
		name  string
		raw   []byte
		valid bool
	}{
		{"byte limit", append([]byte(minimal), bytes.Repeat([]byte(" "), maxBytes-len(minimal))...), true},
		{"byte overflow", append([]byte(minimal), bytes.Repeat([]byte(" "), maxBytes-len(minimal)+1)...), false},
		{"depth limit", withTasks(strings.Repeat("[", 127) + "null" + strings.Repeat("]", 127)), true},
		{"depth overflow", withTasks(strings.Repeat("[", 128) + "null" + strings.Repeat("]", 128)), false},
		// Minimal has 15 decoded values; replacing null with an array adds one
		// value per element and retains the original tasks root value.
		{"node limit", withTasks("[" + strings.Repeat("0,", maxNodes-16) + "0]"), true},
		{"node overflow", withTasks("[" + strings.Repeat("0,", maxNodes-15) + "0]"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := (JSONDecoder{}).Decode(tc.raw)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}
func TestTypedRelevantShapes(t *testing.T) {
	validRoute := map[string]any{"transport": "codex-shared-proxy/v1", "harness": "codex", "socketPath": "/s", "expectedCodexHome": "/h", "workspaceId": "w", "projectId": "p", "projectRoot": "/r", "projectIdentity": map[string]any{"device": "18446744073709551615", "inode": "9007199254740993"}, "gitCommonDirectory": "/g", "execution": map[string]any{"sandbox": "read-only", "approvalPolicy": "on-request"}, "computerGeneration": json.Number("1"), "hostGeneration": json.Number("1"), "approvedAt": "time", "expiresAt": json.Number("1")}
	if !route(validRoute) {
		t.Fatal("valid route")
	}
	for key, bad := range map[string]any{"execution": nil, "projectIdentity": map[string]any{"device": json.Number("1"), "inode": "2"}, "hostGeneration": json.Number("9007199254740992"), "expiresAt": json.Number("0"), "observeTurnId": "turn", "workspaceId": false, "unexpected": true} {
		candidate := map[string]any{}
		for k, v := range validRoute {
			candidate[k] = v
		}
		candidate[key] = bad
		if route(candidate) {
			t.Errorf("malformed %s", key)
		}
	}
	if identity(map[string]any{"device": "1", "inode": "123456789012345678901"}, false) {
		t.Fatal("overlong identity")
	}
	if source(map[string]any{"hostGeneration": json.Number("1"), "localVerification": nil, "evidence": nil}) {
		t.Fatal("malformed provenance")
	}
}
func TestLosslessNumbers(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{"9007199254740993", "9007199254740993e0"}, {"18446744073709551615", "18446744073709551615e0"},
		{"1.0", "1e0"}, {"1e0", "1e0"}, {"-0", "0e0"}, {"0.0100", "1e-2"}, {"123e100000", "123e100000"},
	} {
		if got := number(json.Number(tc.raw)); got != port.TaskSettingsNumber(tc.want) {
			t.Fatalf("%s => %s", tc.raw, got)
		}
		encoded, err := json.Marshal(number(json.Number(tc.raw)))
		if err != nil || string(encoded) != tc.want {
			t.Fatalf("lossless numeric encoding: %s, %v", encoded, err)
		}
	}
}
