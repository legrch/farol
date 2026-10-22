package helperinput_test

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	app "github.com/legrch/farol/modules/release/app/services/helperinput"
	native "github.com/legrch/farol/modules/release/infra/native/helperinput"
)

// These disposable values follow installed-update-helper.ts's producer shape.
// They supply parsing evidence only, with no native observation or admission.
func fixture(closed bool) map[string]any {
	r := map[string]any{
		"schema": "farol.installed-update/1", "action": "apply", "home": "/Users/fixture",
		"operationId": strings.Repeat("a", 32),
		"source":      map[string]any{"digest": strings.Repeat("1", 64), "version": "0.2.4", "buildId": strings.Repeat("2", 64)},
		"target":      map[string]any{"digest": strings.Repeat("3", 64), "version": "0.2.5", "buildId": strings.Repeat("4", 64)},
		"drain":       map[string]any{"status": "reconciled", "acceptedSource": strings.Repeat("2", 64), "acceptedTarget": strings.Repeat("4", 64)},
		"pid":         42, "processStart": "Mon Oct 12 12:00:00 2026", "waitSeconds": 30, "relaunch": true,
	}
	if closed {
		r["installLocation"] = "shared"
		r["predecessor"] = map[string]any{
			"kind": "confirmed_closed", "startedAt": "2026-10-12T12:00:00Z", "lastQuitSha256": strings.Repeat("b", 64),
			"stateIdentity": map[string]any{"device": "0", "inode": "123"},
		}
		r["leaseIdentity"] = map[string]any{"device": "1", "inode": "456"}
	}
	return r
}

func marshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func parse(t *testing.T, raw []byte, want string) port.HelperRequest {
	t.Helper()
	r, err := app.New(native.JSONDecoder{}).Parse(context.Background(), raw)
	if want == "" {
		if err != nil {
			t.Fatalf("unexpected refusal: %v", err)
		}
		return r
	}
	var failure *app.Failure
	if !errors.As(err, &failure) || failure.Code != want || err.Error() != want || r != (port.HelperRequest{}) {
		t.Fatalf("result/error = %+v / %v, want zero / %s", r, err, want)
	}
	return r
}

func TestProducerShapedRequests(t *testing.T) {
	for _, action := range []string{"apply", "recover", "rollback"} {
		for _, location := range []string{"", "legacy", "shared"} {
			for _, closed := range []bool{false, true} {
				for _, relaunch := range []bool{false, true} {
					t.Run(action+"/"+location+"/"+boolName(closed)+"/"+boolName(relaunch), func(t *testing.T) {
						r := fixture(closed)
						r["action"], r["relaunch"] = action, relaunch
						delete(r, "installLocation")
						if location != "" {
							r["installLocation"] = location
						}
						want := ""
						if closed && (action == "recover" || (action == "rollback" && relaunch)) {
							want = "input"
						}
						got := parse(t, append(marshal(t, r), '\n'), want)
						if want == "" && (got.Action != action || got.PID != 42 || got.Relaunch != relaunch || (got.Predecessor != nil) != closed || (got.InstallLocation != nil) != (location != "")) {
							t.Fatalf("incorrect mapping: %+v", got)
						}
					})
				}
			}
		}
	}
}

func boolName(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func at(root map[string]any, path []string) map[string]any {
	for _, key := range path {
		root = root[key].(map[string]any)
	}
	return root
}

func TestClosedObjectKeysAndNulls(t *testing.T) {
	paths := [][]string{nil, {"source"}, {"target"}, {"drain"}, {"predecessor"}, {"predecessor", "stateIdentity"}, {"leaseIdentity"}}
	for _, path := range paths {
		t.Run(strings.Join(path, "/"), func(t *testing.T) {
			original := at(fixture(true), path)
			for key := range original {
				t.Run(key, func(t *testing.T) {
					for _, mutation := range []string{"missing", "null", "array", "wrong type"} {
						// Optional top-level members may be absent individually;
						// their pair constraint is app policy, tested separately.
						if mutation == "missing" && len(path) == 0 && (key == "installLocation" || key == "predecessor" || key == "leaseIdentity") {
							continue
						}
						t.Run(mutation, func(t *testing.T) {
							r := fixture(true)
							obj := at(r, path)
							switch mutation {
							case "missing":
								delete(obj, key)
							case "null":
								obj[key] = nil
							case "array":
								obj[key] = []any{}
							case "wrong type":
								obj[key] = true
								if key == "relaunch" {
									obj[key] = "false"
								}
							}
							raw := marshal(t, r)
							if _, err := (native.JSONDecoder{}).Decode(raw); err == nil {
								t.Fatalf("structural decoder accepted %s %s", key, mutation)
							}
							parse(t, raw, "input")
						})
					}
				})
			}
			r := fixture(true)
			at(r, path)["unknown"] = false
			parse(t, marshal(t, r), "input")
		})
	}
}

func TestDuplicateDecodedKeysAtEveryObject(t *testing.T) {
	for _, path := range [][]string{nil, {"source"}, {"target"}, {"drain"}, {"predecessor"}, {"predecessor", "stateIdentity"}, {"leaseIdentity"}} {
		root := fixture(true)
		obj := at(root, path)
		for key := range obj {
			for _, escaped := range []bool{false, true} {
				t.Run(strings.Join(path, "/")+"/"+key+"/"+boolName(escaped), func(t *testing.T) {
					raw, objectRaw := marshal(t, root), marshal(t, obj)
					needle := []byte(`"` + key + `":`)
					duplicate := key
					if escaped {
						duplicate = `\u00` + hexByte(key[0]) + key[1:]
					}
					// The later valid value must never hide an earlier null,
					// whether the duplicate spelling is literal or escaped.
					insertion := []byte(`"` + duplicate + `":null,` + string(needle))
					changed := bytes.Replace(objectRaw, needle, insertion, 1)
					parse(t, bytes.Replace(raw, objectRaw, changed, 1), "input")
				})
			}
		}
	}
}

func hexByte(b byte) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[b>>4], digits[b&15]})
}

func TestRawEncodingAndNumberHardening(t *testing.T) {
	valid := marshal(t, fixture(false))
	cases := map[string][]byte{
		"empty": nil, "whitespace": []byte(" \t\r\n"), "null": []byte("null"), "array": []byte("[]"), "scalar": []byte("true"),
		"trailing object": append(bytes.Clone(valid), []byte(" {}")...),
		"trailing junk":   append(bytes.Clone(valid), 'x'),
		"truncated":       bytes.TrimSuffix(valid, []byte("}")),
		"invalid UTF8":    bytes.Replace(valid, []byte("0.2.4"), []byte{0xff}, 1),
		"BOM":             append([]byte{0xef, 0xbb, 0xbf}, valid...),
		"deep unknown":    bytes.Replace(valid, []byte(`"action":`), []byte(`"extra":`+strings.Repeat("[", 1000)+`0`+strings.Repeat("]", 1000)+`,"action":`), 1),
	}
	for _, spelling := range []string{"true", "false", "null", `"42"`, "42.0", "4.2e1", "42e0", "-2.0", "1e1000", "9223372036854775808", "-9223372036854775809", "01", "+2", "NaN", "Infinity"} {
		cases["PID "+spelling] = bytes.Replace(valid, []byte(`"pid":42`), []byte(`"pid":`+spelling), 1)
		cases["wait "+spelling] = bytes.Replace(valid, []byte(`"waitSeconds":30`), []byte(`"waitSeconds":`+spelling), 1)
	}
	for _, spelling := range []string{`"\ud800"`, `"\udfff"`, `"\ud800x"`, `"\ud800\u0041"`, `"\udc00\ud800"`, `"\ud800\ud800"`, `"\uZZZZ"`, `"\q"`, `"\u123"`, "\"literal\nnewline\""} {
		cases["Unicode "+spelling] = bytes.Replace(valid, []byte(`"0.2.4"`), []byte(spelling), 1)
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) { parse(t, raw, "input") })
	}
	for _, spelling := range []string{`"\ud83d\ude00"`, `"😀"`, `"�"`, `"\uFFFD"`, `"a\"b"`, `"a\\ud800"`, `"a\/b"`, `"\u0000"`} {
		t.Run("valid escape "+spelling, func(t *testing.T) {
			parse(t, bytes.Replace(valid, []byte(`"0.2.4"`), []byte(spelling), 1), "")
		})
	}
}

func TestRawBounds(t *testing.T) {
	raw := marshal(t, fixture(true))
	max := append(bytes.Clone(raw), bytes.Repeat([]byte(" "), 8192-len(raw))...)
	parse(t, max, "")
	for _, oversized := range [][]byte{append(bytes.Clone(max), ' '), bytes.Repeat([]byte("x"), 8193)} {
		if _, err := (native.JSONDecoder{}).Decode(oversized); err == nil {
			t.Fatal("decoder accepted oversized input")
		}
		parse(t, oversized, "input")
	}
}

func TestStructuralBeforeSemanticAndSemanticOrder(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(map[string]any)
		want string
	}{
		{"acceptance before PID", func(r map[string]any) { r["pid"] = 1; at(r, []string{"drain"})["status"] = "no" }, "acceptance"},
		{"structural integer before acceptance", func(r map[string]any) { r["pid"] = 42.5; at(r, []string{"drain"})["status"] = "no" }, "input"},
		{"structural relaunch before acceptance", func(r map[string]any) { r["relaunch"] = nil; at(r, []string{"drain"})["status"] = "no" }, "input"},
		{"proof before acceptance", func(r map[string]any) { delete(r, "leaseIdentity"); at(r, []string{"drain"})["status"] = "no" }, "input"},
		{"lease alone", func(r map[string]any) { delete(r, "predecessor") }, "input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := fixture(true)
			tc.edit(r)
			parse(t, marshal(t, r), tc.want)
		})
	}
}

func TestConcurrentIndependentDecode(t *testing.T) {
	raw := marshal(t, fixture(true))
	s := app.New(native.JSONDecoder{})
	var wg sync.WaitGroup
	for range 24 {
		wg.Go(func() {
			r, err := s.Parse(context.Background(), raw)
			if err != nil || r.Predecessor == nil || *r.InstallLocation != "shared" {
				t.Errorf("decode failed: %v", err)
				return
			}
			*r.InstallLocation = "changed"
			r.Predecessor.StateIdentity.Inode = "changed"
			r.LeaseIdentity.Device = "changed"
		})
	}
	wg.Wait()
}

func TestDecoderOwnsOnlyStructure(t *testing.T) {
	r := fixture(true)
	r["schema"], r["action"], r["home"], r["operationId"] = "other", "other", "relative", "short"
	r["pid"], r["waitSeconds"], r["installLocation"] = -1, 121, "other"
	at(r, []string{"source"})["version"] = ""
	at(r, []string{"predecessor"})["kind"] = "other"
	got, err := (native.JSONDecoder{}).Decode(marshal(t, r))
	if err != nil || got.Schema != "other" || got.PID != -1 || got.WaitSeconds != 121 || *got.InstallLocation != "other" || got.Predecessor.Kind != "other" {
		t.Fatalf("decoder imposed app semantics or mapped incorrectly: %+v / %v", got, err)
	}
}

//go:embed testdata/old-parser.json
var oldParserVectors []byte

func TestStaticOldParserOracle(t *testing.T) {
	// Python ran only during fixture preparation. Neither this test nor the
	// decoder launches it. The fixture states every deliberate refusal delta.
	var corpus struct {
		SourceSHA256 string `json:"sourceSHA256"`
		Vectors      []struct {
			Name, RawBase64, Previous, Expected, Classification string
		}
	}
	if err := json.Unmarshal(oldParserVectors, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.SourceSHA256 != "9bd3bf1e06984deeae37cdc61c30063d01b466d26a518952c599fba9c1142c02" || len(corpus.Vectors) != 48 {
		t.Fatal("unexpected oracle provenance or vector count")
	}
	for _, vector := range corpus.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			if (vector.Previous == vector.Expected) != (vector.Classification == "parity") {
				t.Fatal("unclassified oracle difference")
			}
			raw, err := base64.StdEncoding.DecodeString(vector.RawBase64)
			if err != nil {
				t.Fatal(err)
			}
			code := vector.Expected
			if code == "accepted" {
				code = ""
			}
			parse(t, raw, code)
		})
	}
}

func FuzzDecode(f *testing.F) {
	// No effects or subprocesses: fuzzing exercises only the bounded decoder.
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"schema":"\ud800"}`))
	valid, err := json.Marshal(fixture(true))
	if err != nil {
		f.Fatal(err)
	}
	f.Add(valid)
	f.Fuzz(func(t *testing.T, raw []byte) {
		r, err := (native.JSONDecoder{}).Decode(raw)
		if err != nil && (err.Error() != "input" || r != (port.HelperRequest{})) {
			t.Fatal("decoder disclosed input or returned a partial result")
		}
	})
}
