package modelselection_test

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/modelselection"
)

// All routes are synthetic. These tests prove configured/resolved values only,
// never admission, public-control observations, entitlement or provider work.
func pointer(s string) *string { return &s }

type digester struct {
	calls int
	bytes []byte
	err   error
	value *string
}

func (d *digester) Digest(input []byte) (string, error) {
	d.calls++
	d.bytes = append([]byte(nil), input...)
	if d.err != nil {
		return "", d.err
	}
	if d.value != nil {
		return *d.value, nil
	}
	return fmt.Sprintf("%x", sha256.Sum256(input)), nil
}

func policy() port.ModelPolicy {
	return port.ModelPolicy{DefaultHarness: "browser", Harnesses: map[string]port.ModelHarnessPolicy{
		"future": {DefaultModel: "small", Models: map[string]port.ConfiguredModel{"small": {Model: "fixture/future"}}},
		"browser": {DefaultModel: "small", Models: map[string]port.ConfiguredModel{
			"wide":  {Model: "fixture/wide", DefaultEffort: pointer("high")},
			"small": {Model: "fixture/small", DefaultEffort: pointer("medium")},
			"plain": {Model: "fixture/no-effort"},
		}},
	}}
}

func profiles() []port.BrowserModelProfile {
	return []port.BrowserModelProfile{
		{ID: "fixture-small-route", Executor: "browser", RuntimeModel: "fixture/small", ModelID: "fixture-small-control", DefaultEffort: "route-medium", Efforts: []port.BrowserModelEffort{{Requested: "medium", Resolved: "route-medium"}, {Requested: "xhigh", Resolved: "route-extra"}}, Required: port.RequiredControls{Model: true, Effort: true}},
		{ID: "fixture-wide-route", Executor: "browser", RuntimeModel: "fixture/wide", ModelID: "fixture-wide-control", Mode: "pro", Efforts: []port.BrowserModelEffort{{Requested: "high", Resolved: "route-high"}, {Requested: "max", Resolved: "route-max"}, {Requested: "Ultra", Resolved: "route-max"}}, Required: port.RequiredControls{Model: true, Effort: true, Mode: true}},
		{ID: "fixture-plain-route", Executor: "browser", RuntimeModel: "fixture/no-effort", ModelID: "fixture-plain-control", DefaultEffort: "route-default", Efforts: []port.BrowserModelEffort{{Requested: "fixture-default", Resolved: "route-default"}}, Required: port.RequiredControls{Model: true}},
	}
}

func resolve(t *testing.T, p port.ModelPolicy, request port.ModelRequest, rows []port.BrowserModelProfile) (*port.ModelSelectionCapture, *digester) {
	t.Helper()
	d := &digester{}
	c, err := modelselection.Resolve(d, p, request, rows, "fixture-account")
	if err != nil || c == nil {
		t.Fatalf("Resolve = %v, %v", c, err)
	}
	if d.calls != 1 || !c.Selection.Valid() || !c.Resolution.Valid(c.Selection) || !c.Required.Valid(c.Selection) {
		t.Fatalf("invalid capture or digest count: %+v, %d", c, d.calls)
	}
	if c.Selection.Provider != "farol" || c.Selection.Alias != "chatgpt" || c.Selection.AccountID != "fixture-account" || c.Selection.ToolsEnabled || c.Selection.ConnectorID != "" || c.Selection.ConnectorGrantID != "" {
		t.Fatalf("unexpected public route/grants: %+v", c.Selection)
	}
	return c, d
}

func TestResolverSemanticVectors(t *testing.T) {
	// Semantic equivalents of src/pkg/owner-config/contract.ts resolver vectors:
	// configured defaults, explicit overrides, absent effort, future executors.
	for _, tc := range []struct {
		name                           string
		request                        port.ModelRequest
		alias, model, effort, mode     string
		requestedEffort, requestedMode string
	}{
		{name: "configured defaults", alias: "small", model: "fixture-small-control", effort: "route-medium"},
		{name: "explicit override", request: port.ModelRequest{Harness: pointer("browser"), Effort: pointer("xhigh")}, alias: "small", model: "fixture-small-control", effort: "route-extra", requestedEffort: "xhigh"},
		{name: "model default", request: port.ModelRequest{Model: pointer("wide")}, alias: "wide", model: "fixture-wide-control", effort: "route-high", mode: "pro"},
		{name: "explicit mode", request: port.ModelRequest{Model: pointer("wide"), RequestedMode: pointer("pro"), Effort: pointer("max")}, alias: "wide", model: "fixture-wide-control", effort: "route-max", mode: "pro", requestedEffort: "max", requestedMode: "pro"},
		{name: "route specific legacy translation", request: port.ModelRequest{Model: pointer("wide"), Effort: pointer("Ultra")}, alias: "wide", model: "fixture-wide-control", effort: "route-max", mode: "pro", requestedEffort: "Ultra"},
		{name: "omitted configuration effort", request: port.ModelRequest{Model: pointer("plain")}, alias: "plain", model: "fixture-plain-control", effort: "route-default"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := resolve(t, policy(), tc.request, profiles())
			if c.Selection.ModelID != tc.model || c.Selection.Effort != tc.effort || c.Selection.Mode != tc.mode || c.Resolution.RequestedAlias != tc.alias || c.Resolution.RequestedExecutor != "browser" || c.Resolution.RequestedEffort != tc.requestedEffort || c.Resolution.RequestedMode != tc.requestedMode || c.Resolution.Resolved != c.Selection {
				t.Fatalf("unexpected resolution: %+v", c)
			}
		})
	}
	// An explicit effort overrides even a configured default this route rejects.
	p := policy()
	m := p.Harnesses["browser"].Models["small"]
	m.DefaultEffort = pointer("unsupported-default")
	p.Harnesses["browser"].Models["small"] = m
	resolve(t, p, port.ModelRequest{Effort: pointer("xhigh")}, profiles())
	// A stored unsupported executor may be bypassed only by an explicit request.
	p.DefaultHarness = "future"
	resolve(t, p, port.ModelRequest{Harness: pointer("browser"), Effort: pointer("xhigh")}, profiles())
	// Future route efforts are accepted as declared data, without a vendor enum.
	rows := profiles()
	rows[0].Mode, rows[0].Required.Mode = "standard", true
	rows[0].Efforts = append(rows[0].Efforts, port.BrowserModelEffort{Requested: "future-effort", Resolved: "future-route"})
	c, _ := resolve(t, policy(), port.ModelRequest{Effort: pointer("future-effort"), RequestedMode: pointer("standard")}, rows)
	if c.Selection.Effort != "future-route" || c.Resolution.RequestedMode != "standard" {
		t.Fatal("declared future effort or standard mode lost")
	}
}

func TestCanonicalTaskPolicyIdentity(t *testing.T) {
	// Independent JSON.stringify + SHA-256 vector, using the exact TS array shape.
	const canonical = `["farol-task-policy/1","browser",[["browser","small",[["plain","fixture/no-effort",null],["small","fixture/small","medium"],["wide","fixture/wide","high"]]],["future","small",[["small","fixture/future",null]]]]]`
	const digest = "5d867c69e7c53e6d7990743608cf091b905492879ff70b818c6c055fa32784be"
	first, d := resolve(t, policy(), port.ModelRequest{}, profiles())
	if string(d.bytes) != canonical || first.Resolution.ConfigSHA256 != digest || first.Resolution.TranslationID != "fixture-small-route" {
		t.Fatalf("canonical mismatch: %s, %+v", d.bytes, first.Resolution)
	}
	p := policy()
	h := p.Harnesses["browser"]
	h.Models = map[string]port.ConfiguredModel{"plain": h.Models["plain"], "small": h.Models["small"], "wide": h.Models["wide"]}
	p.Harnesses = map[string]port.ModelHarnessPolicy{"browser": h, "future": p.Harnesses["future"]}
	reordered, d := resolve(t, p, port.ModelRequest{}, profiles())
	if reordered.Resolution.ConfigSHA256 != digest || string(d.bytes) != canonical {
		t.Fatal("map order changed policy identity")
	}
	// Request/account/profile identity are deliberately outside the policy hash.
	other, _ := resolve(t, p, port.ModelRequest{Model: pointer("wide"), Effort: pointer("max")}, profiles())
	if other.Resolution.ConfigSHA256 != digest {
		t.Fatal("request changed configuration identity")
	}
	for _, tc := range []struct {
		name string
		edit func(port.ModelPolicy)
	}{
		{"unselected runtime ID", func(p port.ModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.ConfiguredModel{Model: "fixture/changed"}
		}},
		{"unselected effort", func(p port.ModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.ConfiguredModel{Model: "fixture/future", DefaultEffort: pointer("next")}
		}},
		{"harness default", func(p port.ModelPolicy) {
			h := p.Harnesses["browser"]
			h.DefaultModel = "plain"
			p.Harnesses["browser"] = h
		}},
		{"additional alias", func(p port.ModelPolicy) {
			p.Harnesses["future"].Models["extra"] = port.ConfiguredModel{Model: "fixture/extra"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := policy()
			tc.edit(p)
			changed, _ := resolve(t, p, port.ModelRequest{}, profiles())
			if changed.Resolution.ConfigSHA256 == digest {
				t.Fatal("policy edit did not change digest")
			}
		})
	}
}

func TestCapturePinnedAcrossSettingsAndProfileEdits(t *testing.T) {
	p, rows := policy(), profiles()
	request := port.ModelRequest{Model: pointer("small"), Effort: pointer("xhigh")}
	first, _ := resolve(t, p, request, rows)
	saved := *first
	*request.Model, *request.Effort = "plain", "fixture-default"
	*p.Harnesses["browser"].Models["small"].DefaultEffort = "unsupported"
	rows[0].ModelID, rows[0].ID = "changed-control", "changed-translation"
	rows[0].Efforts[1].Resolved = "changed-effort"
	h := p.Harnesses["browser"]
	h.DefaultModel = "plain"
	p.Harnesses["browser"] = h
	second, _ := resolve(t, p, port.ModelRequest{}, rows)
	if *first != saved || first.Selection == second.Selection || first.Resolution.ConfigSHA256 == second.Resolution.ConfigSHA256 {
		t.Fatalf("capture was re-resolved or mutated: %+v, %+v", first, second)
	}
	// Mutating a returned value also cannot affect another call or the input.
	second.Selection.Effort = "caller-edit"
	third, _ := resolve(t, p, port.ModelRequest{}, rows)
	if third.Selection.Effort != "route-default" || *first != saved {
		t.Fatal("return values share mutable selection state")
	}
}

func TestRefusalsDoNotDigest(t *testing.T) {
	for _, tc := range []struct {
		name    string
		request port.ModelRequest
		edit    func(*port.ModelPolicy, *[]port.BrowserModelProfile)
		account string
		want    modelselection.Code
	}{
		{name: "unknown harness", request: port.ModelRequest{Harness: pointer("absent")}, want: modelselection.HarnessMissing},
		{name: "inherited TS name is missing", request: port.ModelRequest{Model: pointer("constructor")}, want: modelselection.ModelMissing},
		{name: "unsupported executor", request: port.ModelRequest{Harness: pointer("future")}, want: modelselection.HarnessUnsupported},
		{name: "unsupported default executor", edit: func(p *port.ModelPolicy, _ *[]port.BrowserModelProfile) { p.DefaultHarness = "future" }, want: modelselection.HarnessUnsupported},
		{name: "missing model", request: port.ModelRequest{Model: pointer("absent")}, want: modelselection.ModelMissing},
		{name: "no runtime mapping", edit: func(p *port.ModelPolicy, _ *[]port.BrowserModelProfile) {
			p.Harnesses["browser"].Models["small"] = port.ConfiguredModel{Model: "fixture/unmapped"}
		}, want: modelselection.ProfileUnsupported},
		{name: "no implicit legacy cast", request: port.ModelRequest{Effort: pointer("Ultra")}, want: modelselection.EffortUnsupported},
		{name: "case sensitive efforts", request: port.ModelRequest{Effort: pointer("XHIGH")}, want: modelselection.EffortUnsupported},
		{name: "unknown effort", request: port.ModelRequest{Effort: pointer("future")}, want: modelselection.EffortUnsupported},
		{name: "unsupported configured effort", edit: func(p *port.ModelPolicy, _ *[]port.BrowserModelProfile) {
			*p.Harnesses["browser"].Models["small"].DefaultEffort = "future"
		}, want: modelselection.EffortUnsupported},
		{name: "no declared route default", request: port.ModelRequest{Model: pointer("plain")}, edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[2].DefaultEffort = "" }, want: modelselection.EffortUnsupported},
		{name: "requested mode mismatch", request: port.ModelRequest{RequestedMode: pointer("pro")}, want: modelselection.ModeMismatch},
		{name: "mode cannot disambiguate", request: port.ModelRequest{RequestedMode: pointer("pro")}, edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) {
			p := (*r)[0]
			p.ID = "other-route"
			p.Mode = "pro"
			p.Required.Mode = true
			*r = append(*r, p)
		}, want: modelselection.ProfileAmbiguous},
		{name: "duplicate profile ID unrelated row", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[2].ID = (*r)[0].ID }, want: modelselection.ProfileAmbiguous},
		{name: "duplicate runtime mapping", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) {
			p := (*r)[0]
			p.ID = "other-route"
			*r = append(*r, p)
		}, want: modelselection.ProfileAmbiguous},
		{name: "connector required", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].Required.Connector = true }, want: modelselection.ProfileUnsupported},
		{name: "bad unrelated profile", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[2].RuntimeModel = "bad value" }, want: modelselection.ProfileInvalid},
		{name: "no model control", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].Required.Model = false }, want: modelselection.ProfileInvalid},
		{name: "mode control mismatch", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[1].Required.Mode = false }, want: modelselection.ProfileInvalid},
		{name: "malformed profile mode", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].Mode = "unknown" }, want: modelselection.ProfileInvalid},
		{name: "unlisted profile default", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].DefaultEffort = "medium" }, want: modelselection.ProfileInvalid},
		{name: "no effort pairs", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].Efforts = nil }, want: modelselection.ProfileInvalid},
		{name: "ambiguous effort pair", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) {
			(*r)[0].Efforts = append((*r)[0].Efforts, port.BrowserModelEffort{Requested: "medium", Resolved: "different"})
		}, want: modelselection.ProfileInvalid},
		{name: "malformed resolved effort", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].Efforts[0].Resolved = "bad value" }, want: modelselection.ProfileInvalid},
		{name: "malformed requested effort", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].Efforts[0].Requested = "bad.value" }, want: modelselection.ProfileInvalid},
		{name: "bad profile ID", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].ID = "bad id" }, want: modelselection.ProfileInvalid},
		{name: "bad browser ID", edit: func(_ *port.ModelPolicy, r *[]port.BrowserModelProfile) { (*r)[0].ModelID = string([]byte{0xff}) }, want: modelselection.ProfileInvalid},
		{name: "bad account", account: "bad account", want: modelselection.RequestInvalid},
		{name: "long account", account: strings.Repeat("a", 121), want: modelselection.RequestInvalid},
		{name: "invalid UTF8 account", account: string([]byte{0xff}), want: modelselection.RequestInvalid},
		{name: "empty explicit harness", request: port.ModelRequest{Harness: pointer("")}, want: modelselection.RequestInvalid},
		{name: "empty explicit model", request: port.ModelRequest{Model: pointer("")}, want: modelselection.RequestInvalid},
		{name: "empty explicit effort", request: port.ModelRequest{Effort: pointer("")}, want: modelselection.RequestInvalid},
		{name: "empty explicit mode", request: port.ModelRequest{RequestedMode: pointer("")}, want: modelselection.RequestInvalid},
		{name: "unknown mode", request: port.ModelRequest{RequestedMode: pointer("future")}, want: modelselection.RequestInvalid},
		{name: "overlong request effort", request: port.ModelRequest{Effort: pointer(strings.Repeat("e", 41))}, want: modelselection.RequestInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, rows, d := policy(), profiles(), &digester{}
			if tc.edit != nil {
				tc.edit(&p, &rows)
			}
			account := tc.account
			if account == "" {
				account = "fixture-account"
			}
			got, err := modelselection.Resolve(d, p, tc.request, rows, account)
			if got != nil || err != tc.want || d.calls != 0 {
				t.Fatalf("Resolve = %+v, %v, calls=%d; want nil, %v, 0", got, err, d.calls, tc.want)
			}
		})
	}
	got, err := modelselection.Resolve(&digester{}, policy(), port.ModelRequest{}, profiles(), "")
	if got != nil || err != modelselection.RequestInvalid {
		t.Fatal("empty account accepted")
	}
}

func TestWholeConfigurationBoundsAndNames(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*port.ModelPolicy)
	}{
		{"zero config", func(p *port.ModelPolicy) { *p = port.ModelPolicy{} }},
		{"missing default harness", func(p *port.ModelPolicy) { p.DefaultHarness = "absent" }},
		{"missing unrelated default model", func(p *port.ModelPolicy) {
			h := p.Harnesses["future"]
			h.DefaultModel = "absent"
			p.Harnesses["future"] = h
		}},
		{"empty unrelated models", func(p *port.ModelPolicy) { p.Harnesses["future"] = port.ModelHarnessPolicy{DefaultModel: "small"} }},
		{"invalid unrelated runtime", func(p *port.ModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.ConfiguredModel{Model: "bad model"}
		}},
		{"empty configured effort", func(p *port.ModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.ConfiguredModel{Model: "valid", DefaultEffort: pointer("")}
		}},
		{"long runtime", func(p *port.ModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.ConfiguredModel{Model: strings.Repeat("m", 121)}
		}},
		{"long configured effort", func(p *port.ModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.ConfiguredModel{Model: "valid", DefaultEffort: pointer(strings.Repeat("e", 41))}
		}},
		{"too many harnesses", func(p *port.ModelPolicy) {
			for n := range 17 {
				p.Harnesses[fmt.Sprintf("h%d", n)] = p.Harnesses["future"]
			}
		}},
		{"too many models", func(p *port.ModelPolicy) {
			for n := range 65 {
				p.Harnesses["future"].Models[fmt.Sprintf("m%d", n)] = port.ConfiguredModel{Model: "valid"}
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, d := policy(), &digester{}
			tc.edit(&p)
			got, err := modelselection.Resolve(d, p, port.ModelRequest{}, profiles(), "fixture-account")
			if got != nil || err != modelselection.ConfigInvalid || d.calls != 0 {
				t.Fatalf("invalid config accepted: %v, %v, %d", got, err, d.calls)
			}
		})
	}
	for _, name := range []string{"", "Upper", "1start", "a--b", "a..b", "a_-b", "a/ b", "a-", "é", "a\x7f", string([]byte{0xff}), strings.Repeat("a", 81)} {
		t.Run("name:"+fmt.Sprintf("%q", name), func(t *testing.T) {
			p, d := policy(), &digester{}
			p.Harnesses[name] = p.Harnesses["future"]
			got, err := modelselection.Resolve(d, p, port.ModelRequest{}, profiles(), "fixture-account")
			if got != nil || err != modelselection.ConfigInvalid || d.calls != 0 {
				t.Fatal("bad harness name accepted")
			}
			p = policy()
			p.Harnesses["future"].Models[name] = port.ConfiguredModel{Model: "valid"}
			got, err = modelselection.Resolve(d, p, port.ModelRequest{}, profiles(), "fixture-account")
			if got != nil || err != modelselection.ConfigInvalid || d.calls != 0 {
				t.Fatal("bad alias accepted")
			}
			got, err = modelselection.Resolve(d, policy(), port.ModelRequest{Harness: pointer(name)}, profiles(), "fixture-account")
			if got != nil || err != modelselection.RequestInvalid || d.calls != 0 {
				t.Fatal("bad requested harness accepted")
			}
		})
	}
	// Exact maximums and the complete permitted ASCII alphabets are accepted.
	p := policy()
	for n := range 14 {
		p.Harnesses[fmt.Sprintf("h%d", n)] = p.Harnesses["future"]
	}
	for n := range 62 {
		p.Harnesses["browser"].Models[fmt.Sprintf("m%d", n)] = port.ConfiguredModel{Model: strings.Repeat("M", 120), DefaultEffort: pointer(strings.Repeat("E", 40))}
	}
	delete(p.Harnesses["browser"].Models, "m61") // three existing + 61 = 64
	p.Harnesses["future"].Models[strings.Repeat("a", 80)] = port.ConfiguredModel{Model: "AZaz09_./-", DefaultEffort: pointer("AZaz09_-")}
	p.Harnesses["future"].Models["a0-b1_c2.d3"] = port.ConfiguredModel{Model: "valid"}
	resolve(t, p, port.ModelRequest{}, profiles())
}

func TestNoInputMutationAndOrderIndependentProfileMatching(t *testing.T) {
	p, rows := policy(), profiles()
	beforePolicy, beforeRows := policy(), profiles()
	first, _ := resolve(t, p, port.ModelRequest{}, rows)
	if !reflect.DeepEqual(p, beforePolicy) || !reflect.DeepEqual(rows, beforeRows) {
		t.Fatal("Resolve mutated inputs")
	}
	rows[0], rows[2] = rows[2], rows[0]
	second, _ := resolve(t, p, port.ModelRequest{}, rows)
	if *first != *second {
		t.Fatal("profile order affected mapping")
	}
}

func TestDigestContractFailureIsClassifiedAndOneShot(t *testing.T) {
	for _, d := range []*digester{
		{err: errors.New("private adapter diagnostic")},
		{value: pointer("")}, {value: pointer(strings.Repeat("A", 64))},
		{value: pointer(strings.Repeat("a", 63))}, {value: pointer(strings.Repeat("g", 64))},
	} {
		got, err := modelselection.Resolve(d, policy(), port.ModelRequest{}, profiles(), "fixture-account")
		if got != nil || err != modelselection.DigestUnavailable || d.calls != 1 {
			t.Fatalf("digest failure: %v, %v, %d", got, err, d.calls)
		}
	}
	got, err := modelselection.Resolve(nil, policy(), port.ModelRequest{}, profiles(), "fixture-account")
	if got != nil || err != modelselection.DigestUnavailable {
		t.Fatal("nil digest port accepted")
	}
}
