package currentsettings_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/currentsettings"
	"github.com/legrch/farol/modules/task/app/services/modelpolicy"
	native "github.com/legrch/farol/modules/task/infra/currentsettings"
	policy "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

// Synthetic saved values prove CPU-only comparison, never host, catalogue,
// account, provider, permission or publication readiness.
const fixtureJSON = `{
 "status":"parsed",
 "tasks":{"defaultHarness":"other","harnesses":{
   "other":{"defaultModel":"other","models":{"other":{"model":"unimplemented-model"}}},
   "codex":{"defaultModel":"preferred","models":{"preferred":{"model":"fixture-model-v4","defaultEffort":"high"},"spare":{"model":"fixture-spare"}}}}},
 "nativeHosts":{"generation":"7","route":{
   "transport":"codex-shared-proxy/v1","harness":"codex","workspaceId":"writer","projectId":"project",
   "socketPath":"/fixture/proxy.sock","expectedCodexHome":"/fixture/codex-home","projectRoot":"/fixture/project",
   "projectIdentity":{"device":"1","inode":"100"},"gitCommonDirectory":"/fixture/project/.git",
   "execution":{"sandbox":"workspace-write","approvalPolicy":"on-request"},"hostGeneration":7,"computerGeneration":11,
   "approvedAt":"2026-10-04T09:50:00.000Z","expiresAt":1791109800000},
   "host":{"executablePath":"/fixture/bin/codex","executableSha256":"aaa","version":"1.2.3","protocol":"codex-app-server/v2",
   "schemaSha256":"bbb","verifiedAt":"2026-10-04T09:00:00.000Z","liveVerification":null,"agentVerification":null,
   "localVerification":{"executableSha256":"aaa","schemaSha256":"bbb","buildId":"eee","verifiedAt":"2026-10-04T09:00:00.000Z"},
   "taskSource":{"hostGeneration":7,
     "localVerification":{"executableSha256":"aaa","schemaSha256":"bbb","buildId":"eee","verifiedAt":"2026-10-04T09:00:00.000Z"},
     "evidence":{"handoff":{"executablePath":"/fixture/bin/codex","executableSha256":"aaa","baseSchemaSha256":"bbb","status":"supported",
       "contract":{"version":"1.2.3","protocol":"codex-app-server/v2","schemaSha256":"ccc","projectBoundCreateStatus":true}},
     "followup":{"executablePath":"/fixture/bin/codex","executableSha256":"aaa","baseSchemaSha256":"bbb","status":"supported",
       "contract":{"kind":"codex-followup-schema/v1","protocol":"codex-app-server/v2","baseSchemaSha256":"ccc","schemaSha256":"ddd"}}}}}},
 "computer":{"computerId":"computer","generation":"11","workspaces":[{
   "workspaceId":"writer","root":"/fixture/writer","access":"write","excludedPaths":[],"gitHistoryApproved":true,
   "rootIdentity":{"device":"18446744073709551615","inode":"9007199254740993"},
   "gitMetadata":{"gitDirectory":"/fixture/project/.git/worktrees/writer","commonDirectory":"/fixture/project/.git"}}]},
 "setup":{"verified":{"profile":"distinct-profile","configRevision":11,"workspaceId":"writer","runtimeGeneration":"desktop-runtime",
   "buildId":"fff","protocol":"desktop-computer-fixture","verifiedAt":"2026-10-04T09:00:00.000Z"},"reachable":"reachable","outcomeUnknown":false}}
`

type identityPolicy struct{ service *modelpolicy.Service }

func (p identityPolicy) IdentifyTaskPolicy(raw []byte) (port.TaskSettingsPolicyIdentity, error) {
	identity := p.service.Identity(raw)
	switch identity.Status {
	case modelpolicy.Ready:
		return port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyValid, SHA256: identity.ConfigSHA256}, nil
	case modelpolicy.ConfigMissing:
		return port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyMissing}, nil
	case modelpolicy.ConfigInvalid:
		return port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyInvalid}, nil
	default:
		return port.TaskSettingsPolicyIdentity{}, errors.New("unavailable")
	}
}
func service() *app.Service {
	return app.New(native.JSONDecoder{}, identityPolicy{modelpolicy.New(policy.JSONDecoder{}, policy.SHA256Digester{}, []string{"codex"})})
}
func fixture(t *testing.T) map[string]any {
	t.Helper()
	d := json.NewDecoder(strings.NewReader(fixtureJSON))
	d.UseNumber()
	var out map[string]any
	if err := d.Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
func raw(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
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
func assertCompare(t *testing.T, before, after []byte, want bool) {
	t.Helper()
	aCopy := append([]byte(nil), before...)
	bCopy := append([]byte(nil), after...)
	got, err := service().Compare(context.Background(), before, after)
	if err != nil || got != want {
		t.Fatalf("changed=%v err=%v, want %v", got, err, want)
	}
	if !bytes.Equal(before, aCopy) || !bytes.Equal(after, bCopy) {
		t.Fatal("mutated caller bytes")
	}
}

func TestEveryOriginalProjectedChange(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		value      any
	}{
		{"global task policy", "tasks.defaultHarness", "codex"},
		{"unselected alias", "tasks.harnesses.codex.models.spare.model", "changed-spare"},
		{"other harness", "tasks.harnesses.other.models.other.model", "changed-other"},
		{"host generation", "nativeHosts.generation", "8"},
		{"computer generation", "computer.generation", "12"},
		{"route optional observation", "nativeHosts.route.observeThreadId", "thread"},
		{"route exact observation turn", "nativeHosts.route.observeTurnId", "turn-exact"},
		{"route original approval", "nativeHosts.route.approvedAt", "2026-10-04T09:00:00.000Z"},
		{"route original expiry", "nativeHosts.route.expiresAt", json.Number("1791109800001")},
		{"route transport metadata", "nativeHosts.route.socketPath", "/fixture/new-proxy.sock"},
		{"selected host executable", "nativeHosts.host.executablePath", "/fixture/new-codex"},
		{"source withdrawal", "nativeHosts.host.taskSource", nil},
		{"local verification build", "nativeHosts.host.localVerification.buildId", "fff"},
		{"record source provenance", "nativeHosts.host.taskSource.localVerification.verifiedAt", "2026-10-04T09:50:00.000Z"},
		{"writer physical identity", "computer.workspaces.0.rootIdentity.inode", "9007199254740994"},
		{"linked Git directory", "computer.workspaces.0.gitMetadata.gitDirectory", "/fixture/project/.git/worktrees/other"},
		{"writer access", "computer.workspaces.0.access", "read"},
		{"exclusions", "computer.workspaces.0.excludedPaths", []string{"/fixture/writer/private"}},
		{"Git restriction", "computer.workspaces.0.gitHistoryApproved", false},
		{"missing selected workspace", "computer.workspaces", []any{}},
		{"setup profile provenance", "setup.verified.profile", "changed-profile"},
		{"setup runtime provenance", "setup.verified.runtimeGeneration", "changed-runtime"},
		{"setup protocol provenance", "setup.verified.protocol", "changed-protocol"},
		{"setup build provenance", "setup.verified.buildId", "eee"},
		{"setup time provenance", "setup.verified.verifiedAt", "2026-10-04T09:50:00.000Z"},
		{"setup reachability", "setup.reachable", "unknown"},
		{"setup unknown outcome", "setup.outcomeUnknown", true},
		// Remaining selected fields guard the exact original host/projection surface.
		{"host digest", "nativeHosts.host.executableSha256", "changed"},
		{"host version", "nativeHosts.host.version", "1.2.4"},
		{"host protocol", "nativeHosts.host.protocol", "changed"},
		{"host schema", "nativeHosts.host.schemaSha256", "changed"},
		{"missing route", "nativeHosts.route", nil},
		{"missing host", "nativeHosts.host", nil},
		{"missing local verification", "nativeHosts.host.localVerification", nil},
		{"missing root identity", "computer.workspaces.0.rootIdentity", nil},
		{"missing Git metadata", "computer.workspaces.0.gitMetadata", nil},
		{"missing Git approval", "computer.workspaces.0.gitHistoryApproved", nil},
		{"missing setup verification", "setup.verified", nil},
		{"computer ID", "computer.computerId", "changed"},
		{"selected root", "computer.workspaces.0.root", "/changed"},
		{"route project identity", "nativeHosts.route.projectIdentity.inode", "101"},
		{"route execution", "nativeHosts.route.execution.sandbox", "read-only"},
		{"setup revision", "setup.verified.configRevision", json.Number("12")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before, after := fixture(t), fixture(t)
			if tc.name == "route exact observation turn" {
				set(after, "nativeHosts.route.observeThreadId", "thread")
			}
			set(after, tc.path, tc.value)
			assertCompare(t, raw(t, before), raw(t, after), true)
		})
	}
	t.Run("duplicate selected workspace", func(t *testing.T) {
		before, after := fixture(t), fixture(t)
		c := at(after, "computer")
		ws := c["workspaces"].([]any)
		c["workspaces"] = append(ws, ws[0])
		assertCompare(t, raw(t, before), raw(t, after), true)
	})
}

func TestNegativeEvidenceAndPolicyClasses(t *testing.T) {
	before, after := fixture(t), fixture(t)
	set(before, "nativeHosts.host.taskSource", nil)
	set(after, "nativeHosts.host.taskSource", nil)
	set(after, "nativeHosts.route.socketPath", "/changed.sock")
	assertCompare(t, raw(t, before), raw(t, after), true)
	set(after, "nativeHosts.route.socketPath", "/fixture/proxy.sock")
	set(before, "nativeHosts.route.observeThreadId", "thread")
	set(after, "nativeHosts.route.observeThreadId", "thread")
	set(before, "nativeHosts.route.observeTurnId", "turn-before")
	set(after, "nativeHosts.route.observeTurnId", "turn-after")
	assertCompare(t, raw(t, before), raw(t, after), true)
	for _, unsupported := range []bool{false, true} {
		before, after = fixture(t), fixture(t)
		if !unsupported {
			for _, f := range []map[string]any{before, after} {
				p := at(f, "tasks")
				delete(at(p, "harnesses"), "codex")
			}
		}
		set(after, "tasks.harnesses.other.models.other.model", "changed")
		p := modelpolicy.New(policy.JSONDecoder{}, policy.SHA256Digester{}, []string{"codex"})
		if unsupported {
			p = modelpolicy.New(policy.JSONDecoder{}, policy.SHA256Digester{}, nil)
		}
		got, err := app.New(native.JSONDecoder{}, identityPolicy{p}).Compare(context.Background(), raw(t, before), raw(t, after))
		if err != nil || !got {
			t.Fatalf("no-codex full policy identity lost: %v %v", got, err)
		}
	}
	before, after = fixture(t), fixture(t)
	before["tasks"] = nil
	after["tasks"] = map[string]any{"defaultHarness": "missing"}
	assertCompare(t, raw(t, before), raw(t, after), true)
	before["tasks"] = false
	after["tasks"] = []any{"different-invalid"}
	assertCompare(t, raw(t, before), raw(t, after), false)
	assertCompare(t, []byte(`{"status":"settings-invalid"}`), []byte(`{"status":"settings-invalid"}`), false)
	assertCompare(t, []byte(`{"status":"settings-invalid"}`), raw(t, fixture(t)), true)
}

func TestOrderInvarianceAndInertFacts(t *testing.T) {
	before, after := fixture(t), fixture(t)
	set(before, "computer.workspaces.0.excludedPaths", []string{"/fixture/writer/z", "/fixture/writer/a"})
	set(after, "computer.workspaces.0.excludedPaths", []string{"/fixture/writer/a", "/fixture/writer/z"})
	set(after, "nativeHosts.host.verifiedAt", "changed-inert-time")
	set(after, "nativeHosts.host.liveVerification", map[string]any{"inert": true})
	set(after, "nativeHosts.host.agentVerification", map[string]any{"inert": true})
	// UI/revision are excluded by the closed transport, not selected by the app.
	// A workspace unrelated to the saved route is inert.
	c := at(after, "computer")
	extra := at(fixture(t), "computer.workspaces.0")
	extra["workspaceId"] = "other"
	c["workspaces"] = append([]any{extra}, c["workspaces"].([]any)...)
	assertCompare(t, raw(t, before), raw(t, after), false)
	// Marshal sorts keys, while the original literal has another insertion order.
	assertCompare(t, []byte(fixtureJSON), raw(t, fixture(t)), false)
	// Duplicate match evidence is a multiset, never collapsed to unique.
	before, after = fixture(t), fixture(t)
	w1 := at(fixture(t), "computer.workspaces.0")
	w1["root"] = "/different"
	at(before, "computer")["workspaces"] = append(at(before, "computer")["workspaces"].([]any), w1)
	at(after, "computer")["workspaces"] = append([]any{w1}, at(after, "computer")["workspaces"].([]any)...)
	assertCompare(t, raw(t, before), raw(t, after), false)
}

type factsDecoder struct {
	facts  port.TaskCurrentSettingsFacts
	cancel context.CancelFunc
	calls  int
	err    error
}

func (d *factsDecoder) Decode(raw []byte) (port.TaskCurrentSettingsFacts, error) {
	d.calls++
	if len(raw) > 0 {
		raw[0] = 'x'
	}
	if d.cancel != nil {
		d.cancel()
	}
	return d.facts, d.err
}

type badDigest struct{}

func (badDigest) Digest([]byte) (string, error) {
	return "", errors.New("private data must not escape")
}
func TestFailureAndNoMutation(t *testing.T) {
	f, err := (native.JSONDecoder{}).Decode([]byte(fixtureJSON))
	if err != nil {
		t.Fatal(err)
	}
	f.Computer.Workspaces[0].ExcludedPaths = []string{"z", "a"}
	d := &factsDecoder{facts: f}
	p := identityPolicy{modelpolicy.New(policy.JSONDecoder{}, policy.SHA256Digester{}, []string{"codex"})}
	before := raw(t, f.Computer.Workspaces)
	input := []byte("input")
	if changed, err := app.New(d, p).Compare(context.Background(), input, input); err != nil || changed {
		t.Fatalf("%v %v", changed, err)
	}
	if !bytes.Equal(before, raw(t, f.Computer.Workspaces)) || string(input) != "input" {
		t.Fatal("aliased decoder/input mutation")
	}
	ctx, cancel := context.WithCancel(context.Background())
	d.cancel = cancel
	d.calls = 0
	if changed, err := app.New(d, p).Compare(ctx, input, input); changed || err == nil || d.calls != 1 {
		t.Fatal("canceled decode returned comparison")
	}
	for _, svc := range []*app.Service{nil, app.New(nil, p), app.New(native.JSONDecoder{}, nil), app.New(native.JSONDecoder{}, identityPolicy{modelpolicy.New(policy.JSONDecoder{}, badDigest{}, nil)}), app.New(native.JSONDecoder{}, identityPolicy{modelpolicy.New(nil, nil, nil)})} {
		changed, err := svc.Compare(context.Background(), []byte(fixtureJSON), []byte(fixtureJSON))
		failure, ok := err.(*app.Failure)
		if changed || !ok || failure.Code != app.Unavailable || strings.Contains(err.Error(), "private") {
			t.Fatalf("unavailable: %v %v", changed, err)
		}
	}
	for _, input := range [][]byte{nil, []byte(`{}`), []byte(`{"status":"parsed"}`), bytes.Repeat([]byte(" "), app.MaxSnapshotBytes+1)} {
		changed, err := service().Compare(context.Background(), input, []byte(fixtureJSON))
		if changed || err == nil {
			t.Fatal("malformed facts compared")
		}
	}
	if _, err := service().Compare(nil, nil, nil); err == nil {
		t.Fatal("nil context")
	}
	// Decoder results are independent, including exact identities and input bytes.
	first, _ := (native.JSONDecoder{}).Decode([]byte(fixtureJSON))
	second, _ := (native.JSONDecoder{}).Decode([]byte(fixtureJSON))
	first.NativeHosts.Route["socketPath"] = "changed"
	first.Tasks[0] = 'x'
	first.Computer.Workspaces[0].RootIdentity.(map[string]any)["inode"] = "changed"
	if reflect.DeepEqual(first, second) || second.NativeHosts.Route["socketPath"] != "/fixture/proxy.sock" || second.Computer.Workspaces[0].RootIdentity.(map[string]any)["inode"] != "9007199254740993" {
		t.Fatal("decoder retained alias")
	}
}

type policyResult struct {
	identity port.TaskSettingsPolicyIdentity
	err      error
	cancel   context.CancelFunc
	calls    int
}

func (p *policyResult) IdentifyTaskPolicy(raw []byte) (port.TaskSettingsPolicyIdentity, error) {
	p.calls++
	if len(raw) > 0 {
		raw[0] = 'x'
	}
	if p.cancel != nil {
		p.cancel()
	}
	return p.identity, p.err
}
func TestIdentityPortRefusalAndCancellation(t *testing.T) {
	for _, p := range []*policyResult{
		{identity: port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyValid, SHA256: "bad"}},
		{identity: port.TaskSettingsPolicyIdentity{Kind: 99}},
		{identity: port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyMissing, SHA256: strings.Repeat("a", 64)}},
		{identity: port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyInvalid, SHA256: strings.Repeat("a", 64)}},
		{err: errors.New("private source contents")},
	} {
		changed, err := app.New(native.JSONDecoder{}, p).Compare(context.Background(), []byte(fixtureJSON), []byte(fixtureJSON))
		f, ok := err.(*app.Failure)
		if changed || !ok || f.Code != app.Unavailable || err.Error() != app.Unavailable {
			t.Fatalf("%v %v", changed, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &policyResult{identity: port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyValid, SHA256: strings.Repeat("a", 64)}, cancel: cancel}
	changed, err := app.New(native.JSONDecoder{}, p).Compare(ctx, []byte(fixtureJSON), []byte(fixtureJSON))
	if changed || err == nil || p.calls != 1 {
		t.Fatal("continued after identity cancellation")
	}
}
func TestConcurrentIndependentComparisons(t *testing.T) {
	s := service()
	before, after := []byte(fixtureJSON), raw(t, fixture(t))
	for i := range 16 {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			t.Parallel()
			changed, err := s.Compare(context.Background(), before, after)
			if err != nil || changed {
				t.Fatalf("%v %v", changed, err)
			}
		})
	}
}
