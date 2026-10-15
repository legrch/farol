package currentsource_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/currentsource"
	"github.com/legrch/farol/modules/task/app/services/modelpolicy"
	contract "github.com/legrch/farol/modules/task/contracts/currentsource"
	decoder "github.com/legrch/farol/modules/task/infra/currentsettings"
	policy "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

const now int64 = 1791108000000
const workspaceID = "10000000-0000-4000-8000-000000000001"
const projectID = "10000000-0000-4000-8000-000000000002"
const threadID = "10000000-0000-4000-8000-000000000004"

func sha(s string) string { return strings.Repeat(s, 64) }

type resolver struct{ owner *modelpolicy.Service }

func (r resolver) ResolveTaskSourceModel(ctx context.Context, raw []byte) (port.TaskSourceModelResolution, error) {
	out := r.owner.Resolve(raw, []byte(`{"harness":"codex"}`))
	result := port.TaskSourceModelResolution{Status: string(out.Status)}
	if out.Selection != nil {
		result.Selection = &port.TaskSourceModelSelection{Harness: out.Selection.Harness, ModelAlias: out.Selection.ModelAlias, Model: out.Selection.Model, Effort: out.Selection.Effort, ConfigSHA256: out.ConfigSHA256}
	}
	return result, nil
}
func modelResolver() resolver {
	return resolver{modelpolicy.New(policy.JSONDecoder{}, policy.SHA256Digester{}, []string{"codex"})}
}
func service() *app.Service { return app.New(decoder.JSONDecoder{}, modelResolver()) }
func fixture(t *testing.T) map[string]any {
	t.Helper()
	d := json.NewDecoder(strings.NewReader(fixtureJSON))
	d.UseNumber()
	var o map[string]any
	if err := d.Decode(&o); err != nil {
		t.Fatal(err)
	}
	return o
}
func at(v any, path string) map[string]any {
	for _, key := range strings.Split(path, ".") {
		if key == "0" {
			v = v.([]any)[0]
		} else {
			v = v.(map[string]any)[key]
		}
	}
	return v.(map[string]any)
}
func set(v map[string]any, path string, value any) {
	i := strings.LastIndexByte(path, '.')
	if i < 0 {
		v[path] = value
		return
	}
	at(v, path[:i])[path[i+1:]] = value
}
func raw(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func resolve(t *testing.T, f map[string]any, clock int64) *app.Result {
	t.Helper()
	input := raw(t, f)
	copy := append([]byte(nil), input...)
	out, e := service().Resolve(context.Background(), input, clock)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(input, copy) {
		t.Fatal("mutated input")
	}
	return out
}
func absent(t *testing.T, o *app.Result) {
	t.Helper()
	if o.Status != app.Absent || o.Source != nil || o.Read != nil {
		t.Fatalf("want absent: %+v", o)
	}
}
func positive(t *testing.T, o *app.Result) {
	t.Helper()
	if o.Status != app.Available || o.Source == nil {
		t.Fatalf("want available: %+v", o)
	}
}

func TestEntireSourceShapeAndIndependentContract(t *testing.T) {
	f := fixture(t)
	set(f, "nativeHosts.route.observeThreadId", threadID)
	set(f, "nativeHosts.route.observeTurnId", "turn-exact")
	out := resolve(t, f, now)
	positive(t, out)
	model, e := modelResolver().ResolveTaskSourceModel(context.Background(), raw(t, f["tasks"]))
	if e != nil {
		t.Fatal(e)
	}
	want := &app.Result{Status: app.Available, Read: &app.ReadReference{ThreadID: threadID, TurnID: "turn-exact"}, Source: &app.CodexSource{
		ProjectID: projectID, WorkspaceID: workspaceID, Project: app.Root{Path: "/fixture/project", Device: "1", Inode: "100", GitCommonDirectory: "/fixture/project/.git"},
		Writer:     app.Root{Path: "/fixture/writer", Device: "18446744073709551615", Inode: "9007199254740993", GitCommonDirectory: "/fixture/project/.git"},
		ModelAlias: "preferred", Model: "fixture-model-v4", Effort: model.Selection.Effort, ConfigDigest: model.Selection.ConfigSHA256,
		ExecutablePath: "/fixture/bin/codex", ExecutableSHA256: sha("a"), Protocol: "codex-app-server/v2", BaseSchemaSHA256: sha("b"), HandoffSchemaSHA256: sha("c"),
		Followup:   &app.Followup{Kind: "codex-followup-schema/v1", Protocol: "codex-app-server/v2", BaseSchemaSHA256: sha("c"), SchemaSHA256: sha("d")},
		SocketPath: "/fixture/proxy.sock", ExpectedCodexHome: "/fixture/codex-home", Sandbox: "workspace-write", ApprovalPolicy: "on-request", GrantedAt: "2026-10-04T09:50:00.000Z", ExpiresAt: "2026-10-04T10:50:00.000Z",
		HostGeneration: "7", ComputerGeneration: "11", GrantHostGeneration: "7", GrantComputerGeneration: "11", VerifiedWorkspaceID: workspaceID, VerifiedComputerGeneration: "11", Access: "write", ProjectBoundCreateStatus: true}}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("source mismatch\n%s\nwant\n%s", raw(t, out), raw(t, want))
	}
	c, e := contract.New(service()).Resolve(context.Background(), contract.Request{Settings: raw(t, f), NowMillis: now})
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(raw(t, c), raw(t, want)) {
		t.Fatalf("contract mapping: %s", raw(t, c))
	}
}

func TestOriginalRefusalVectors(t *testing.T) {
	type change struct {
		name, path string
		value      any
	}
	cases := []change{
		{"missing policy", "tasks", nil}, {"invalid policy", "tasks", map[string]any{"defaultHarness": "missing"}},
		{"missing route", "nativeHosts.route", nil}, {"missing host", "nativeHosts.host", nil},
		{"missing record", "nativeHosts.host.taskSource", nil}, {"missing local", "nativeHosts.host.localVerification", nil},
		{"missing identity", "computer.workspaces.0.rootIdentity", nil}, {"missing git", "computer.workspaces.0.gitMetadata", nil},
		{"missing verified", "setup.verified", nil}, {"missing workspace", "computer.workspaces", []any{}},
		{"host generation", "nativeHosts.route.hostGeneration", json.Number("8")}, {"computer generation", "nativeHosts.route.computerGeneration", json.Number("12")},
		{"record generation", "nativeHosts.host.taskSource.hostGeneration", json.Number("8")},
		{"unsafe generation", "nativeHosts.generation", "9007199254740992"}, {"zero generation", "nativeHosts.generation", "0"},
		{"unsafe verified generation", "setup.verified.configRevision", json.Number("9007199254740992")},
		{"wrong verified generation", "setup.verified.configRevision", json.Number("12")}, {"wrong verified workspace", "setup.verified.workspaceId", projectID},
		{"crossed git", "computer.workspaces.0.gitMetadata.commonDirectory", "/fixture/other/.git"},
		{"write with read", "computer.workspaces.0.access", "read"}, {"exclusions", "computer.workspaces.0.excludedPaths", []string{"/fixture/writer/private"}},
		{"restricted git", "computer.workspaces.0.gitHistoryApproved", false}, {"absent git approval", "computer.workspaces.0.gitHistoryApproved", nil},
		{"local executable", "nativeHosts.host.localVerification.executableSha256", sha("f")}, {"local schema", "nativeHosts.host.localVerification.schemaSha256", sha("f")},
		{"record executable", "nativeHosts.host.taskSource.localVerification.executableSha256", sha("f")}, {"record schema", "nativeHosts.host.taskSource.localVerification.schemaSha256", sha("f")},
		{"record build", "nativeHosts.host.taskSource.localVerification.buildId", sha("f")}, {"record timestamp", "nativeHosts.host.taskSource.localVerification.verifiedAt", "2026-10-04T09:50:00.000Z"},
		{"host path", "nativeHosts.host.executablePath", "/fixture/other-codex"},
		{"handoff version", "nativeHosts.host.taskSource.evidence.handoff.contract.version", "1.2.4"},
		{"handoff digest collision", "nativeHosts.host.taskSource.evidence.handoff.contract.schemaSha256", sha("b")},
		{"followup base", "nativeHosts.host.taskSource.evidence.followup.contract.baseSchemaSha256", sha("b")},
		{"followup handoff collision", "nativeHosts.host.taskSource.evidence.followup.contract.schemaSha256", sha("c")},
		{"followup host collision", "nativeHosts.host.taskSource.evidence.followup.contract.schemaSha256", sha("b")},
		{"future grant", "nativeHosts.route.approvedAt", "2026-10-04T10:00:00.001Z"},
		{"expired grant", "nativeHosts.route.expiresAt", json.Number("1791108000000")},
		{"zero grant", "nativeHosts.route.expiresAt", json.Number("1791107400000")},
		{"over 12h", "nativeHosts.route.approvedAt", "2026-10-03T22:00:00.000Z"},
		{"unrepresentable expiry", "nativeHosts.route.expiresAt", json.Number("8640000000000001")},
		{"noncanonical timestamp", "nativeHosts.route.approvedAt", "2026-10-04T09:50:00Z"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t)
			set(f, tc.path, tc.value)
			o, e := service().Resolve(context.Background(), raw(t, f), now)
			if e == nil {
				absent(t, o)
			} else if failure, ok := e.(*app.Failure); !ok || failure.Code != app.Invalid {
				t.Fatal(e)
			}
		})
	}
	t.Run("duplicate workspace", func(t *testing.T) {
		f := fixture(t)
		w := f["computer"].(map[string]any)["workspaces"].([]any)
		set(f, "computer.workspaces", append(w, w[0]))
		absent(t, resolve(t, f, now))
	})
	t.Run("missing codex no fallback", func(t *testing.T) {
		f := fixture(t)
		delete(at(f, "tasks.harnesses"), "codex")
		absent(t, resolve(t, f, now))
	})
	for _, key := range []string{"executablePath", "executableSha256", "baseSchemaSha256"} {
		t.Run("outer "+key, func(t *testing.T) {
			f := fixture(t)
			value := sha("f")
			if key == "executablePath" {
				value = "/foreign"
			}
			set(f, "nativeHosts.host.taskSource.evidence.handoff."+key, value)
			set(f, "nativeHosts.host.taskSource.evidence.followup."+key, value)
			absent(t, resolve(t, f, now))
		})
	}
	for _, path := range []string{"nativeHosts.host.executablePath", "nativeHosts.route.socketPath", "nativeHosts.route.expectedCodexHome", "nativeHosts.route.projectRoot", "nativeHosts.route.gitCommonDirectory", "computer.workspaces.0.root", "computer.workspaces.0.gitMetadata.commonDirectory", "computer.workspaces.0.gitMetadata.gitDirectory"} {
		t.Run("root "+path, func(t *testing.T) { f := fixture(t); set(f, path, "/"); absent(t, resolve(t, f, now)) })
	}
}

func TestOptionalFieldsAndExactReadConditions(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(map[string]any)
		read bool
	}{
		{"absent", func(f map[string]any) {}, false},
		{"thread only", func(f map[string]any) { set(f, "nativeHosts.route.observeThreadId", threadID) }, false},
		{"exact", func(f map[string]any) {
			set(f, "nativeHosts.route.observeThreadId", threadID)
			set(f, "nativeHosts.route.observeTurnId", "turn-exact")
		}, true},
		{"unreachable", func(f map[string]any) {
			set(f, "nativeHosts.route.observeThreadId", threadID)
			set(f, "nativeHosts.route.observeTurnId", "turn-exact")
			set(f, "setup.reachable", "unreachable")
		}, false},
		{"unknown outcome", func(f map[string]any) {
			set(f, "nativeHosts.route.observeThreadId", threadID)
			set(f, "nativeHosts.route.observeTurnId", "turn-exact")
			set(f, "setup.outcomeUnknown", true)
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t)
			tc.edit(f)
			o := resolve(t, f, now)
			positive(t, o)
			if (o.Read != nil) != tc.read {
				t.Fatal(o.Read)
			}
		})
	}
	f := fixture(t)
	delete(at(f, "tasks.harnesses.codex.models.preferred"), "defaultEffort")
	o := resolve(t, f, now)
	positive(t, o)
	if o.Source.Effort != nil || bytes.Contains(raw(t, o), []byte(`"effort"`)) {
		t.Fatal("invented effort")
	}
	f = fixture(t)
	w := at(f, "nativeHosts.host.taskSource.evidence.followup")
	delete(w, "contract")
	w["status"] = "unavailable"
	w["code"] = "CODEX_HOST_FOLLOWUP_UNAVAILABLE"
	o = resolve(t, f, now)
	positive(t, o)
	if o.Source.Followup != nil || bytes.Contains(raw(t, o), []byte(`"followup"`)) {
		t.Fatal("invented followup")
	}
	w = at(f, "nativeHosts.host.taskSource.evidence.handoff")
	delete(w, "contract")
	w["status"] = "unavailable"
	w["code"] = "CODEX_HOST_HANDOFF_UNAVAILABLE"
	absent(t, resolve(t, f, now))
	f = fixture(t)
	set(f, "computer.workspaces.0.access", "read")
	set(f, "nativeHosts.route.execution.sandbox", "read-only")
	positive(t, resolve(t, f, now))
	for _, tc := range []struct{ thread, turn any }{{nil, "turn"}, {"not-a-thread", "turn"}, {threadID, ""}, {threadID, "latest turn"}, {threadID, "foreign/path"}, {threadID, nil}} {
		f := fixture(t)
		if tc.thread != nil {
			set(f, "nativeHosts.route.observeThreadId", tc.thread)
		}
		set(f, "nativeHosts.route.observeTurnId", tc.turn)
		o, e := service().Resolve(context.Background(), raw(t, f), now)
		if e == nil {
			absent(t, o)
		}
	}
}

func TestGrantClockAndDateEdges(t *testing.T) {
	for _, tc := range []struct {
		clock     int64
		available bool
	}{{1791107399999, false}, {1791107400000, true}, {1791110999999, true}, {1791111000000, false}, {-9007199254740991, false}, {9007199254740991, false}} {
		o := resolve(t, fixture(t), tc.clock)
		if tc.available {
			positive(t, o)
		} else {
			absent(t, o)
		}
	}
	f := fixture(t)
	set(f, "nativeHosts.route.approvedAt", "2026-10-03T22:50:00.000Z")
	positive(t, resolve(t, f, now))
	set(f, "nativeHosts.route.approvedAt", "2026-10-03T22:49:59.999Z")
	absent(t, resolve(t, f, now))
	for _, s := range []string{"0000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", "+010000-02-29T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "-271821-04-20T00:00:00.000Z"} {
		t.Run(s, func(t *testing.T) {
			f := fixture(t)
			set(f, "nativeHosts.host.localVerification.verifiedAt", s)
			set(f, "nativeHosts.host.taskSource.localVerification.verifiedAt", s)
			set(f, "nativeHosts.host.verifiedAt", s)
			set(f, "setup.verified.verifiedAt", s)
			positive(t, resolve(t, f, now))
		})
	}
	for _, s := range []string{"1900-02-29T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "+002026-10-04T09:00:00.000Z", "-000000-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.001Z", "-271821-04-19T23:59:59.999Z", "2026-10-04T09:00:00.00Z"} {
		t.Run("bad "+s, func(t *testing.T) {
			f := fixture(t)
			set(f, "nativeHosts.host.localVerification.verifiedAt", s)
			set(f, "nativeHosts.host.taskSource.localVerification.verifiedAt", s)
			absent(t, resolve(t, f, now))
		})
	}
	for _, tc := range []struct {
		grant         string
		expiry, clock int64
	}{{"0000-01-01T00:00:00.000Z", 1, 0}, {"+010000-01-01T00:00:00.000Z", 253402300801000, 253402300800000}, {"9999-12-31T23:59:59.999Z", 253402300800000, 253402300799999}} {
		f := fixture(t)
		set(f, "nativeHosts.route.approvedAt", tc.grant)
		set(f, "nativeHosts.route.expiresAt", json.Number(strconvInt(tc.expiry)))
		absent(t, resolve(t, f, tc.clock))
	}
}
func strconvInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

type decodeFunc func([]byte) (port.TaskCurrentSettingsFacts, error)

func (f decodeFunc) Decode(raw []byte) (port.TaskCurrentSettingsFacts, error) { return f(raw) }

type resolveFunc func(context.Context, []byte) (port.TaskSourceModelResolution, error)

func (f resolveFunc) ResolveTaskSourceModel(ctx context.Context, raw []byte) (port.TaskSourceModelResolution, error) {
	return f(ctx, raw)
}
func facts(t *testing.T) port.TaskCurrentSettingsFacts {
	t.Helper()
	f, e := (decoder.JSONDecoder{}).Decode([]byte(fixtureJSON))
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func errorCode(t *testing.T, o *app.Result, e error, want string) {
	t.Helper()
	f, ok := e.(*app.Failure)
	if o != nil || !ok || f.Code != want {
		t.Fatalf("out=%+v error=%v want=%s", o, e, want)
	}
}

func TestPortsCancellationFailuresAndAliasing(t *testing.T) {
	ctx := context.Background()
	input := []byte(fixtureJSON)
	for _, s := range []*app.Service{nil, app.New(nil, modelResolver()), app.New(decoder.JSONDecoder{}, nil)} {
		o, e := s.Resolve(ctx, input, now)
		errorCode(t, o, e, app.Unavailable)
	}
	for _, clock := range []int64{-9007199254740992, 9007199254740992} {
		o, e := service().Resolve(ctx, input, clock)
		errorCode(t, o, e, app.Invalid)
	}
	for _, b := range [][]byte{nil, []byte(`{"status":"settings-invalid","extra":true}`), []byte(`{"status":"settings-invalid","status":"settings-invalid"}`), bytes.Repeat([]byte(" "), app.MaxSnapshotBytes+1)} {
		o, e := service().Resolve(ctx, b, now)
		errorCode(t, o, e, app.Invalid)
	}
	o, e := service().Resolve(ctx, []byte(`{"status":"settings-invalid"}`), now)
	if e != nil {
		t.Fatal(e)
	}
	absent(t, o)
	o, e = service().Resolve(nil, input, now)
	errorCode(t, o, e, app.Unavailable)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	o, e = service().Resolve(canceled, input, now)
	errorCode(t, o, e, app.Unavailable)
	for _, where := range []string{"decoder", "resolver"} {
		t.Run(where, func(t *testing.T) {
			c, cancel := context.WithCancel(ctx)
			defer cancel()
			d := decodeFunc(func(b []byte) (port.TaskCurrentSettingsFacts, error) {
				f := facts(t)
				if where == "decoder" {
					cancel()
				}
				return f, nil
			})
			r := resolveFunc(func(c context.Context, b []byte) (port.TaskSourceModelResolution, error) {
				cancel()
				return modelResolver().ResolveTaskSourceModel(c, b)
			})
			o, e := app.New(d, r).Resolve(c, input, now)
			errorCode(t, o, e, app.Unavailable)
		})
	}
	o, e = app.New(decodeFunc(func([]byte) (port.TaskCurrentSettingsFacts, error) {
		return port.TaskCurrentSettingsFacts{}, errors.New("decoder")
	}), modelResolver()).Resolve(ctx, input, now)
	errorCode(t, o, e, app.Invalid)
	for _, status := range []string{"config-missing", "config-invalid", "harness-missing", "harness-unsupported", "model-missing", "selection-invalid", "unavailable", "future", "ready"} {
		for _, withSelection := range []bool{false, true} {
			t.Run(status+map[bool]string{true: " selection", false: " empty"}[withSelection], func(t *testing.T) {
				r := resolveFunc(func(context.Context, []byte) (port.TaskSourceModelResolution, error) {
					out := port.TaskSourceModelResolution{Status: status}
					if withSelection {
						out.Selection = &port.TaskSourceModelSelection{Harness: "codex", ModelAlias: "preferred", Model: "fixture-model-v4", ConfigSHA256: sha("f")}
					}
					return out, nil
				})
				o, e := app.New(decoder.JSONDecoder{}, r).Resolve(ctx, input, now)
				if status == "ready" && withSelection {
					if e != nil {
						t.Fatal(e)
					}
					positive(t, o)
				} else if !withSelection && (status == "config-missing" || status == "config-invalid" || status == "harness-missing" || status == "harness-unsupported" || status == "model-missing") {
					if e != nil {
						t.Fatal(e)
					}
					absent(t, o)
				} else {
					errorCode(t, o, e, app.Unavailable)
				}
			})
		}
	}
	r := resolveFunc(func(context.Context, []byte) (port.TaskSourceModelResolution, error) {
		return port.TaskSourceModelResolution{}, errors.New("resolver")
	})
	o, e = app.New(decoder.JSONDecoder{}, r).Resolve(ctx, input, now)
	errorCode(t, o, e, app.Unavailable)
	// Both ports may overwrite their owned byte copies. Caller bytes and decoded
	// policy bytes must remain unchanged; result pointers must be independent.
	f := facts(t)
	snapshot := append([]byte(nil), f.Tasks...)
	effort := "high"
	d := decodeFunc(func(b []byte) (port.TaskCurrentSettingsFacts, error) { b[0] = '!'; return f, nil })
	r = resolveFunc(func(_ context.Context, b []byte) (port.TaskSourceModelResolution, error) {
		b[0] = '!'
		return port.TaskSourceModelResolution{Status: "ready", Selection: &port.TaskSourceModelSelection{Harness: "codex", ModelAlias: "preferred", Model: "fixture-model-v4", Effort: &effort, ConfigSHA256: sha("f")}}, nil
	})
	original := append([]byte(nil), input...)
	o, e = app.New(d, r).Resolve(ctx, input, now)
	if e != nil {
		t.Fatal(e)
	}
	positive(t, o)
	effort = "changed"
	f.NativeHosts.Route["projectRoot"] = "/changed"
	objFollow := f.NativeHosts.Host["taskSource"].(map[string]any)["evidence"].(map[string]any)["followup"].(map[string]any)["contract"].(map[string]any)
	objFollow["schemaSha256"] = sha("e")
	if !bytes.Equal(input, original) || !bytes.Equal(f.Tasks, snapshot) || *o.Source.Effort != "high" || o.Source.Project.Path != "/fixture/project" || o.Source.Followup.SchemaSHA256 != sha("d") {
		t.Fatal("alias or mutation")
	}
}

func TestInjectedMalformedPositiveFactsNeverPanic(t *testing.T) {
	for _, tc := range []struct {
		path, key string
		value     any
	}{
		{"route", "execution", []any{}}, {"route", "projectIdentity", map[string]any{"device": []any{}, "inode": "1"}}, {"route", "hostGeneration", port.TaskSettingsNumber("1e99999999999999999999")},
		{"route", "observeThreadId", map[string]any{}}, {"route", "approvedAt", true}, {"route", "projectId", []any{}}, {"route", "harness", map[string]any{}},
		{"host", "localVerification", []any{}}, {"host", "version", map[string]any{}}, {"host", "taskSource", map[string]any{}}, {"host", "schemaSha256", map[string]any{}},
	} {
		t.Run(tc.path+" "+tc.key, func(t *testing.T) {
			f := facts(t)
			m := f.NativeHosts.Route
			if tc.path == "host" {
				m = f.NativeHosts.Host
			}
			m[tc.key] = tc.value
			o, e := app.New(decodeFunc(func([]byte) (port.TaskCurrentSettingsFacts, error) { return f, nil }), modelResolver()).Resolve(context.Background(), []byte("x"), now)
			if e != nil {
				t.Fatal(e)
			}
			absent(t, o)
		})
	}
	for _, path := range []string{"relative", "/a//b", "/a/../b", "/a/./b", "/a/", "/a\x00b", "/"} {
		f := facts(t)
		f.NativeHosts.Route["socketPath"] = path
		o, e := app.New(decodeFunc(func([]byte) (port.TaskCurrentSettingsFacts, error) { return f, nil }), modelResolver()).Resolve(context.Background(), nil, now)
		if e != nil {
			t.Fatal(e)
		}
		absent(t, o)
	}
}

func TestConcurrentIndependentReads(t *testing.T) {
	s := service()
	input := []byte(fixtureJSON)
	var wg sync.WaitGroup
	for i := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 8 {
				out, e := s.Resolve(context.Background(), input, now)
				if e != nil || out.Source == nil || out.Source.Model != "fixture-model-v4" {
					t.Errorf("worker %d: %+v %v", i, out, e)
					return
				}
				out.Source.Followup.SchemaSHA256 = "mutated"
				*out.Source.Effort = "mutated"
			}
		}()
	}
	wg.Wait()
}

func TestSharedPositiveChangesPreserveSavedSourceSemantics(t *testing.T) {
	for _, tc := range []struct {
		name, path    string
		value         any
		changesSource bool
	}{
		{"global policy", "tasks.defaultHarness", "codex", true},
		{"unselected alias", "tasks.harnesses.codex.models.spare.model", "changed-spare", true},
		{"other harness", "tasks.harnesses.other.models.other.model", "changed-other", true},
		{"thread only", "nativeHosts.route.observeThreadId", threadID, false},
		{"grant start", "nativeHosts.route.approvedAt", "2026-10-04T09:00:00.000Z", true},
		{"expiry millisecond", "nativeHosts.route.expiresAt", json.Number("1791111000001"), true},
		{"socket", "nativeHosts.route.socketPath", "/fixture/new-proxy.sock", true},
		{"writer inode", "computer.workspaces.0.rootIdentity.inode", "9007199254740994", true},
		{"linked git", "computer.workspaces.0.gitMetadata.gitDirectory", "/fixture/project/.git/worktrees/other", false},
		{"profile provenance", "setup.verified.profile", "changed-profile", false},
		{"runtime provenance", "setup.verified.runtimeGeneration", "changed-runtime", false},
		{"protocol provenance", "setup.verified.protocol", "changed-protocol", false},
		{"build provenance", "setup.verified.buildId", sha("e"), false},
		{"time provenance", "setup.verified.verifiedAt", "2026-10-04T09:50:00.000Z", false},
		{"reachability", "setup.reachable", "unknown", false},
		{"unknown outcome", "setup.outcomeUnknown", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := resolve(t, fixture(t), now)
			f := fixture(t)
			set(f, tc.path, tc.value)
			after := resolve(t, f, now)
			positive(t, after)
			if reflect.DeepEqual(before.Source, after.Source) == tc.changesSource {
				t.Fatalf("source change=%v expected=%v", !reflect.DeepEqual(before.Source, after.Source), tc.changesSource)
			}
		})
	}
	f := fixture(t)
	set(f, "nativeHosts.route.observeThreadId", threadID)
	set(f, "nativeHosts.route.observeTurnId", "first-turn")
	first := resolve(t, f, now)
	set(f, "nativeHosts.route.observeTurnId", "second-turn")
	second := resolve(t, f, now)
	if first.Read.TurnID != "first-turn" || second.Read.TurnID != "second-turn" || !reflect.DeepEqual(first.Source, second.Source) {
		t.Fatal("exact turn selection alias or baseline mismatch")
	}
}

func TestMalformedInjectedWitnessesAndModelBindings(t *testing.T) {
	for _, tc := range []struct {
		path  string
		value any
	}{
		{"nativeHosts.host.taskSource.evidence.handoff.contract.projectBoundCreateStatus", false},
		{"nativeHosts.host.taskSource.evidence.handoff.contract.protocol", "other"},
		{"nativeHosts.host.taskSource.evidence.followup.contract.kind", "other"},
		{"nativeHosts.host.taskSource.evidence.followup.contract.protocol", "other"},
		{"nativeHosts.host.localVerification.executableSha256", "AAA"},
		{"nativeHosts.host.localVerification.buildId", sha("A")},
		{"nativeHosts.host.version", "v1"}, {"nativeHosts.route.workspaceId", "writer"},
		{"nativeHosts.route.projectIdentity.device", "184467440737095516150"},
		{"nativeHosts.route.projectIdentity.inode", "-1"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			f := facts(t)
			root := map[string]any{"nativeHosts": map[string]any{"host": f.NativeHosts.Host, "route": f.NativeHosts.Route}}
			set(root, tc.path, tc.value)
			o, e := app.New(decodeFunc(func([]byte) (port.TaskCurrentSettingsFacts, error) { return f, nil }), modelResolver()).Resolve(context.Background(), nil, now)
			if e != nil {
				t.Fatal(e)
			}
			absent(t, o)
		})
	}
	for _, field := range []string{"harness", "alias", "model", "digest", "effort"} {
		t.Run("model "+field, func(t *testing.T) {
			r := resolveFunc(func(context.Context, []byte) (port.TaskSourceModelResolution, error) {
				s := &port.TaskSourceModelSelection{Harness: "codex", ModelAlias: "preferred", Model: "fixture-model-v4", ConfigSHA256: sha("f")}
				switch field {
				case "harness":
					s.Harness = "other"
				case "alias":
					s.ModelAlias = ""
				case "model":
					s.Model = "bad model"
				case "digest":
					s.ConfigSHA256 = "bad"
				case "effort":
					v := "bad effort"
					s.Effort = &v
				}
				return port.TaskSourceModelResolution{Status: "ready", Selection: s}, nil
			})
			o, e := app.New(decoder.JSONDecoder{}, r).Resolve(context.Background(), []byte(fixtureJSON), now)
			errorCode(t, o, e, app.Unavailable)
		})
	}
	// A model may be valid policy while failing the old final wire ID format.
	f := fixture(t)
	set(f, "tasks.harnesses.codex.models.preferred.model", "/model")
	absent(t, resolve(t, f, now))
}

func TestMaximumSafeGenerationJoinsAndNegativeClockGrant(t *testing.T) {
	f := fixture(t)
	set(f, "nativeHosts.generation", "9007199254740991")
	set(f, "computer.generation", "9007199254740991")
	for _, p := range []string{"nativeHosts.route.hostGeneration", "nativeHosts.route.computerGeneration", "nativeHosts.host.taskSource.hostGeneration", "setup.verified.configRevision"} {
		set(f, p, json.Number("9007199254740991"))
	}
	o := resolve(t, f, now)
	positive(t, o)
	if o.Source.HostGeneration != "9007199254740991" || o.Source.ComputerGeneration != "9007199254740991" || o.Source.GrantHostGeneration != "9007199254740991" || o.Source.GrantComputerGeneration != "9007199254740991" || o.Source.VerifiedComputerGeneration != "9007199254740991" {
		t.Fatal("rounded generation")
	}
	f = fixture(t)
	set(f, "nativeHosts.route.approvedAt", "1969-12-31T23:59:59.999Z")
	set(f, "nativeHosts.route.expiresAt", json.Number("1"))
	positive(t, resolve(t, f, -1))
	positive(t, resolve(t, f, 0))
	absent(t, resolve(t, f, -2))
	absent(t, resolve(t, f, 1))
}
