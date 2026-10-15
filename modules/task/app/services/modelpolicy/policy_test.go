package modelpolicy

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
)

// Synthetic configured values prove policy only, never native harness support,
// catalogue availability, entitlement, permission or provider execution.
func ptr(s string) *string { return &s }
func fixture() *port.TaskModelPolicy {
	return &port.TaskModelPolicy{DefaultHarness: "codex", Harnesses: map[string]port.TaskModelHarness{
		"codex": {DefaultModel: "small", Models: map[string]port.TaskModel{
			"small":       {Model: "fixture/small", DefaultEffort: ptr("medium")},
			"plain":       {Model: "fixture/plain"},
			"constructor": {Model: "fixture/own"},
		}},
		"future": {DefaultModel: "small", Models: map[string]port.TaskModel{"small": {Model: "fixture/future"}}},
	}}
}

type decoder struct {
	p                         *port.TaskModelPolicy
	r                         port.TaskModelPolicyRequest
	policyErr, requestErr     error
	policyCalls, requestCalls int
}

func (d *decoder) DecodePolicy([]byte) (*port.TaskModelPolicy, error) {
	d.policyCalls++
	return d.p, d.policyErr
}
func (d *decoder) DecodeSelection([]byte) (port.TaskModelPolicyRequest, error) {
	d.requestCalls++
	return d.r, d.requestErr
}

type digester struct {
	value string
	err   error
	input []byte
	calls int
}

func (d *digester) Digest(raw []byte) (string, error) {
	d.calls++
	d.input = append([]byte(nil), raw...)
	return d.value, d.err
}
func goodDigest() *digester { return &digester{value: strings.Repeat("a", 64)} }

func TestStatusOrdering(t *testing.T) {
	for _, tc := range []struct {
		name     string
		edit     func(*decoder)
		want     Status
		requests int
	}{
		{"absent before invalid request", func(d *decoder) { d.p = nil; d.requestErr = errors.New("bad request") }, ConfigMissing, 0},
		{"invalid policy before request", func(d *decoder) { d.policyErr = errors.New("bad policy"); d.requestErr = errors.New("bad request") }, ConfigInvalid, 0},
		{"invalid policy value before request", func(d *decoder) { d.p.DefaultHarness = "missing" }, ConfigInvalid, 0},
		{"invalid request before harness", func(d *decoder) { d.requestErr = errors.New("bad request"); d.r.Harness = ptr("absent") }, SelectionInvalid, 1},
		{"invalid request value before harness", func(d *decoder) { d.r.Harness = ptr("absent"); d.r.Effort = ptr("") }, SelectionInvalid, 1},
		{"missing harness before unsupported", func(d *decoder) { d.r.Harness = ptr("absent"); d.r.Model = ptr("absent") }, HarnessMissing, 1},
		{"unsupported harness before missing model", func(d *decoder) { d.r.Harness = ptr("future"); d.r.Model = ptr("absent") }, HarnessUnsupported, 1},
		{"unsupported default", func(d *decoder) { d.p.DefaultHarness = "future" }, HarnessUnsupported, 1},
		{"missing model", func(d *decoder) { d.r.Model = ptr("absent") }, ModelMissing, 1},
		{"prototype-looking missing own model", func(d *decoder) { d.r.Model = ptr("tostring") }, ModelMissing, 1},
		{"ready", func(*decoder) {}, Ready, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &decoder{p: fixture()}
			tc.edit(d)
			digest := goodDigest()
			got := New(d, digest, []string{"codex"}).Resolve(nil, nil)
			if got.Status != tc.want || d.requestCalls != tc.requests || d.policyCalls != 1 {
				t.Fatalf("got %+v; decoder calls %d/%d", got, d.policyCalls, d.requestCalls)
			}
			if tc.want != Ready && (digest.calls != 0 || got.Selection != nil || got.ConfigSHA256 != "") {
				t.Fatal("refusal carried selection or digested")
			}
			if tc.want == Ready && digest.calls != 1 {
				t.Fatal("ready did not digest exactly once")
			}
		})
	}
}

func TestSelectionValues(t *testing.T) {
	for _, tc := range []struct {
		name         string
		request      port.TaskModelPolicyRequest
		alias, model string
		effort       *string
	}{
		{"default", port.TaskModelPolicyRequest{}, "small", "fixture/small", ptr("medium")},
		{"explicit effort", port.TaskModelPolicyRequest{Effort: ptr("Future_9-X")}, "small", "fixture/small", ptr("Future_9-X")},
		{"absent effort", port.TaskModelPolicyRequest{Model: ptr("plain")}, "plain", "fixture/plain", nil},
		{"own constructor", port.TaskModelPolicyRequest{Model: ptr("constructor")}, "constructor", "fixture/own", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &decoder{p: fixture(), r: tc.request}
			r := New(d, goodDigest(), []string{"codex"}).Resolve(nil, nil)
			if r.Status != Ready || r.Selection.Harness != "codex" || r.Selection.ModelAlias != tc.alias || r.Selection.Model != tc.model || (r.Selection.Effort == nil) != (tc.effort == nil) {
				t.Fatalf("got %+v", r)
			}
			if tc.effort != nil && *r.Selection.Effort != *tc.effort {
				t.Fatal("effort changed")
			}
		})
	}
	// An explicit supported choice can bypass an unsupported configured default.
	d := &decoder{p: fixture(), r: port.TaskModelPolicyRequest{Harness: ptr("codex")}}
	d.p.DefaultHarness = "future"
	if got := New(d, goodDigest(), []string{"codex"}).Resolve(nil, nil); got.Status != Ready {
		t.Fatal(got)
	}
}

func TestPolicyValidation(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*port.TaskModelPolicy)
	}{
		{"empty default", func(p *port.TaskModelPolicy) { p.DefaultHarness = "" }},
		{"missing harness default", func(p *port.TaskModelPolicy) { p.DefaultHarness = "absent" }},
		{"zero harnesses", func(p *port.TaskModelPolicy) { p.Harnesses = nil }},
		{"too many harnesses", func(p *port.TaskModelPolicy) {
			for i := range 17 {
				p.Harnesses[fmt.Sprintf("h%d", i)] = p.Harnesses["codex"]
			}
		}},
		{"invalid harness key", func(p *port.TaskModelPolicy) { p.Harnesses["Bad"] = p.Harnesses["codex"] }},
		{"zero models", func(p *port.TaskModelPolicy) { p.Harnesses["codex"] = port.TaskModelHarness{DefaultModel: "small"} }},
		{"too many models", func(p *port.TaskModelPolicy) {
			for i := range 65 {
				p.Harnesses["codex"].Models[fmt.Sprintf("m%d", i)] = port.TaskModel{Model: "fixture/m"}
			}
		}},
		{"missing model default", func(p *port.TaskModelPolicy) {
			h := p.Harnesses["codex"]
			h.DefaultModel = "absent"
			p.Harnesses["codex"] = h
		}},
		{"invalid model key", func(p *port.TaskModelPolicy) {
			p.Harnesses["codex"].Models["bad..name"] = port.TaskModel{Model: "fixture/m"}
		}},
		{"invalid unselected model", func(p *port.TaskModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.TaskModel{Model: "bad model"}
		}},
		{"empty optional effort", func(p *port.TaskModelPolicy) {
			p.Harnesses["future"].Models["small"] = port.TaskModel{Model: "fixture/m", DefaultEffort: ptr("")}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := fixture()
			tc.edit(p)
			if r := New(&decoder{p: p}, goodDigest(), []string{"codex"}).Resolve(nil, nil); r.Status != ConfigInvalid {
				t.Fatal(r)
			}
		})
	}
}

func TestExactASCIILimits(t *testing.T) {
	for _, tc := range []struct {
		name      string
		valid     func(string) bool
		good, bad []string
	}{
		{"label", taskName, []string{"a", "a0", "a-b_c.d", "constructor", "tostring", "hasownproperty", strings.Repeat("a", 80)}, []string{"", "A", "0a", "_a", "a_", "a..b", "a--b", "a._b", "é", strings.Repeat("a", 81)}},
		{"effort", effortName, []string{"A_-9", strings.Repeat("A", 40)}, []string{"", "a.b", "é", strings.Repeat("a", 41)}},
		{"model", runtimeModel, []string{"A_-.//9", strings.Repeat("A", 120)}, []string{"", "a b", "a:b", "é", strings.Repeat("a", 121)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, value := range tc.good {
				if !tc.valid(value) {
					t.Errorf("rejected %q", value)
				}
			}
			for _, value := range tc.bad {
				if tc.valid(value) {
					t.Errorf("accepted %q", value)
				}
			}
		})
	}
	// Both exact count limits are allowed, independently of the raw JSON limit.
	p := fixture()
	p.Harnesses = map[string]port.TaskModelHarness{}
	for i := range 16 {
		h := port.TaskModelHarness{DefaultModel: "m0", Models: map[string]port.TaskModel{}}
		for j := range 64 {
			h.Models[fmt.Sprintf("m%d", j)] = port.TaskModel{Model: "fixture/m"}
		}
		p.Harnesses[fmt.Sprintf("h%d", i)] = h
	}
	p.DefaultHarness = "h0"
	if !validPolicy(*p) {
		t.Fatal("exact counts rejected")
	}
}

func TestDependenciesAndDigestFailures(t *testing.T) {
	for _, svc := range []*Service{nil, New(nil, goodDigest(), nil), New(&decoder{p: fixture()}, nil, []string{"codex"})} {
		if r := svc.Resolve(nil, nil); r.Status != Unavailable || r.Selection != nil {
			t.Fatal(r)
		}
	}
	for _, value := range []string{"", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("g", 64)} {
		if r := New(&decoder{p: fixture()}, &digester{value: value}, []string{"codex"}).Resolve(nil, nil); r.Status != Unavailable {
			t.Fatal(r)
		}
	}
	if r := New(&decoder{p: fixture()}, &digester{err: errors.New("failure")}, []string{"codex"}).Resolve(nil, nil); r.Status != Unavailable {
		t.Fatal(r)
	}
	// Missing digester cannot override an earlier policy refusal.
	if r := New(&decoder{}, nil, nil).Resolve(nil, nil); r.Status != ConfigMissing {
		t.Fatal(r)
	}
}

func TestWireBoundsAndOrdering(t *testing.T) {
	d := &decoder{p: fixture()}
	s := New(d, goodDigest(), []string{"codex"})
	if r := s.Resolve(make([]byte, MaxPolicyBytes+1), nil); r.Status != ConfigInvalid || d.policyCalls != 0 {
		t.Fatal(r)
	}
	if r := s.Resolve(make([]byte, MaxPolicyBytes), make([]byte, MaxSelectionBytes+1)); r.Status != SelectionInvalid || d.policyCalls != 1 || d.requestCalls != 0 {
		t.Fatal(r)
	}
	if r := s.Resolve(nil, make([]byte, MaxSelectionBytes)); r.Status != Ready {
		t.Fatal(r)
	}
	d.p = nil
	if r := s.Resolve(nil, make([]byte, MaxSelectionBytes+1)); r.Status != ConfigMissing {
		t.Fatal(r)
	}
}

func TestIndependentInputsAndReturns(t *testing.T) {
	p := fixture()
	request := port.TaskModelPolicyRequest{Effort: ptr("explicit")}
	d := &decoder{p: p, r: request}
	supported := []string{"codex"}
	s := New(d, goodDigest(), supported)
	supported[0] = "future"
	first := s.Resolve(nil, nil)
	if first.Status != Ready {
		t.Fatal(first)
	}
	*request.Effort = "changed"
	*p.Harnesses["codex"].Models["small"].DefaultEffort = "changed"
	if *first.Selection.Effort != "explicit" {
		t.Fatal("retained request pointer")
	}
	second := s.Resolve(nil, nil)
	*second.Selection.Effort = "caller"
	second.Selection.Model = "caller"
	third := s.Resolve(nil, nil)
	if third.Selection.Model != "fixture/small" || *third.Selection.Effort != "changed" || *first.Selection.Effort != "explicit" {
		t.Fatal("shared return state")
	}
	// Without a request override, default-effort pointers are copied too.
	d.r = port.TaskModelPolicyRequest{}
	resolvedDefault := s.Resolve(nil, nil)
	*p.Harnesses["codex"].Models["small"].DefaultEffort = "later"
	if *resolvedDefault.Selection.Effort != "changed" {
		t.Fatal("retained default pointer")
	}
}

type staticDecoder struct{}

func (staticDecoder) DecodePolicy([]byte) (*port.TaskModelPolicy, error) { return fixture(), nil }
func (staticDecoder) DecodeSelection([]byte) (port.TaskModelPolicyRequest, error) {
	return port.TaskModelPolicyRequest{}, nil
}

type staticDigest struct{}

func (staticDigest) Digest([]byte) (string, error) { return strings.Repeat("a", 64), nil }

func TestConcurrentResolve(t *testing.T) {
	s := New(staticDecoder{}, staticDigest{}, []string{"codex"})
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			for range 50 {
				r := s.Resolve(nil, nil)
				if r.Status != Ready || *r.Selection.Effort != "medium" {
					t.Error(r)
					return
				}
				*r.Selection.Effort = "caller"
			}
		})
	}
	wg.Wait()
}
