package modelselection

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

func fixture() Snapshot {
	return Snapshot{Scope: Scope{Route: Route{"openai", PlanInference, Plan}, AccountID: "account-a"}, Epoch: 1, Revision: "r1", ObservedAtMillis: 100, ExpiresAtMillis: 200, Source: SIWC, Complete: true, Entries: []Entry{
		{Slug: "text", DisplayName: "Text", Efforts: []string{"balanced", "careful"}, DefaultEffort: "balanced", Capabilities: Capabilities{Text: Yes, Image: No, Tools: No, Revision: "product-v1", Provenance: "product-test-matrix"}},
		{Slug: "vision", DisplayName: "Vision", Efforts: []string{"adaptive"}, DefaultEffort: "adaptive", Capabilities: Capabilities{Text: Yes, Image: Yes, Tools: Unknown, Revision: "product-v1", Provenance: "product-test-matrix"}},
	}}
}
func requireCode(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	var policy *PolicyError
	if !errors.As(err, &policy) || policy.Code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}
func TestDeterministicPreferenceAndExplicitRefusal(t *testing.T) {
	s := fixture()
	r, err := Resolve(s, s.Scope, 150, Request{Preferences: []Preference{{"text", "careful"}, {"vision", "adaptive"}}, Requirements: Requirements{Text: true, Image: true}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Pin().Model != "vision" || r.Pin().Effort != "adaptive" {
		t.Fatalf("wrong preference binding: %+v", r.Pin())
	}
	_, err = Resolve(s, s.Scope, 150, Request{Slug: "text", Effort: "careful", Preferences: []Preference{{"vision", "adaptive"}}, Requirements: Requirements{Image: true}})
	requireCode(t, err, Unsupported)
	_, err = Resolve(s, s.Scope, 150, Request{Slug: "missing", Preferences: []Preference{{"vision", "adaptive"}}})
	requireCode(t, err, Unavailable)
}
func TestPolicyNegativeBoundaries(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Snapshot, *Scope, *uint64, *Request)
		code   ErrorCode
	}{
		{"account switch", func(s *Snapshot, c *Scope, n *uint64, r *Request) { c.AccountID = "account-b" }, WrongScope},
		{"expired", func(s *Snapshot, c *Scope, n *uint64, r *Request) { *n = 200 }, Stale},
		{"future", func(s *Snapshot, c *Scope, n *uint64, r *Request) { *n = 99 }, Stale},
		{"partial list", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Complete = false }, Partial},
		{"disappearing model", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Entries = s.Entries[1:] }, Unavailable},
		{"duplicate slug", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Entries = append(s.Entries, s.Entries[0]) }, Invalid},
		{"invalid effort", func(s *Snapshot, c *Scope, n *uint64, r *Request) { r.Effort = "max" }, Unsupported},
		{"archived default", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Entries[0].Archived = true }, Unavailable},
		{"hidden explicit", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Entries[0].Hidden = true }, Unavailable},
		{"text only image requirement", func(s *Snapshot, c *Scope, n *uint64, r *Request) { r.Requirements.Image = true }, Unsupported},
		{"unknown tools requirement", func(s *Snapshot, c *Scope, n *uint64, r *Request) {
			r.Slug = "vision"
			r.Effort = "adaptive"
			r.Requirements.Tools = true
		}, Unsupported},
		{"plan api mismatch", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Scope.Route.Billing = API; *c = s.Scope }, Invalid},
		{"catalogue is not capability evidence", func(s *Snapshot, c *Scope, n *uint64, r *Request) {
			s.Entries[0].Capabilities.Provenance = string(SIWC)
		}, Invalid},
		{"undeclared default", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Entries[0].DefaultEffort = "high" }, Invalid},
		{"duplicate effort", func(s *Snapshot, c *Scope, n *uint64, r *Request) {
			s.Entries[0].Efforts = append(s.Entries[0].Efforts, "careful")
		}, Invalid},
		{"empty capability state", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Entries[0].Capabilities.Text = "" }, Invalid},
		{"effort without explicit model", func(s *Snapshot, c *Scope, n *uint64, r *Request) { r.Slug = "" }, Invalid},
		{"wrong source", func(s *Snapshot, c *Scope, n *uint64, r *Request) { s.Source = AppServer }, Invalid},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := fixture()
			current := s.Scope
			now := uint64(150)
			r := Request{Slug: "text", Effort: "careful", Requirements: Requirements{Text: true}}
			tc.mutate(&s, &current, &now, &r)
			_, err := Resolve(s, current, now, r)
			requireCode(t, err, tc.code)
		})
	}
}
func TestRecheckDoesNotRetargetRunningBinding(t *testing.T) {
	s := fixture()
	r, err := Resolve(s, s.Scope, 150, Request{Slug: "text", Effort: "careful", Requirements: Requirements{Text: true}})
	if err != nil {
		t.Fatal(err)
	}
	original := r.Pin()
	if err := RecheckBeforeStart(r, s, s.Scope, 151); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*Snapshot)
		code   ErrorCode
	}{
		{"capability revision", func(s *Snapshot) { s.Entries[0].Capabilities.Revision = "product-v2" }, Changed},
		{"capability value", func(s *Snapshot) { s.Entries[0].Capabilities.Image = Yes }, Changed},
		{"catalogue epoch", func(s *Snapshot) { s.Epoch++ }, Changed},
		{"catalogue revision", func(s *Snapshot) { s.Revision = "r2" }, Changed},
		{"effort removed", func(s *Snapshot) { s.Entries[0].Efforts = []string{"balanced"} }, Unsupported},
		{"account", func(s *Snapshot) { s.Scope.AccountID = "account-b" }, WrongScope},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := CloneSnapshot(s)
			tc.change(&next)
			requireCode(t, RecheckBeforeStart(r, next, next.Scope, 151), tc.code)
			if r.Pin() != original {
				t.Fatal("running binding mutated")
			}
		})
	}
	pinCopy := r.Pin()
	pinCopy.Model = "other"
	if r.Pin() != original {
		t.Fatal("Pin exposed mutable storage")
	}
	if err := RecheckBeforeStart(Resolved{}, s, s.Scope, 151); err == nil {
		t.Fatal("empty binding authorized")
	}
}
func TestSnapshotCloneAndIndependentResolution(t *testing.T) {
	s := fixture()
	copy := CloneSnapshot(s)
	copy.Entries[0].Efforts[0] = "mutated"
	if s.Entries[0].Efforts[0] != "balanced" {
		t.Fatal("clone shared effort storage")
	}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Go(func() {
			r, err := Resolve(s, s.Scope, 150, Request{Slug: "text", Effort: "careful"})
			if err != nil {
				t.Error(err)
			}
			if r.Pin().AccountID != "account-a" {
				t.Error("scope leaked")
			}
		})
	}
	wg.Wait()
}
func TestAvailabilityNeverGrantsEntitlement(t *testing.T) {
	s := fixture()
	r, err := Resolve(s, s.Scope, 150, Request{Slug: "text", Effort: "careful"})
	if err != nil {
		t.Fatal(err)
	}
	views := ProjectForRequirements(s, s.Scope, 150, &r, Requirements{Image: true})
	if views[0].State != UnsupportedModel || !views[0].Selected {
		t.Fatalf("wrong unsupported selected projection: %+v", views[0])
	}
	for _, v := range views {
		if v.Entitlement != EntitlementUntested {
			t.Fatal("catalogue claimed entitlement")
		}
	}
	stale := Project(s, s.Scope, 200, &r)
	if stale[0].State != TemporarilyUnavailable {
		t.Fatal("stale entry advertised available")
	}
	partial := CloneSnapshot(s)
	partial.Complete = false
	partial.Entries = partial.Entries[1:]
	if got := Project(partial, partial.Scope, 150, &r); got[len(got)-1].State != TemporarilyUnavailable {
		t.Fatal("partial omission claimed revocation")
	}
	s.Entries = s.Entries[1:]
	views = Project(s, s.Scope, 150, &r)
	if views[len(views)-1].State != Revoked || views[len(views)-1].Discovered {
		t.Fatal("missing selected model not marked revoked")
	}
	other := s.Scope
	other.AccountID = "account-b"
	if Project(s, other, 150, &r) != nil {
		t.Fatal("cross-account catalogue leaked")
	}
}
func TestNonUniversalEffortAndUnknownCatalogue(t *testing.T) {
	s := fixture()
	s.Entries[0].DefaultEffort = ""
	_, err := Resolve(s, s.Scope, 150, Request{Slug: "text"})
	requireCode(t, err, Unsupported)
	s.Entries[0].Efforts = nil
	s.Entries[0].Capabilities = Capabilities{Text: Unknown, Image: Unknown, Tools: Unknown}
	_, err = Resolve(s, s.Scope, 150, Request{Slug: "text", Requirements: Requirements{Text: true}})
	requireCode(t, err, Unsupported)
	r, err := Resolve(s, s.Scope, 150, Request{Slug: "text"})
	if err != nil || r.Pin().Effort != "" {
		t.Fatalf("effortless catalogue: %+v %v", r.Pin(), err)
	}
}

func TestSnapshotBoundsAndRouteSources(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Snapshot)
	}{
		{"invalid UTF8", func(s *Snapshot) { s.Entries[0].Slug = string([]byte{0xff}) }},
		{"slug length", func(s *Snapshot) { s.Entries[0].Slug = strings.Repeat("a", 257) }},
		{"control character", func(s *Snapshot) { s.Entries[0].DisplayName = "Text\x00" }},
		{"account length", func(s *Snapshot) { s.Scope.AccountID = strings.Repeat("a", 257) }},
		{"epoch zero", func(s *Snapshot) { s.Epoch = 0 }},
		{"invalid expiry", func(s *Snapshot) { s.ExpiresAtMillis = s.ObservedAtMillis }},
		{"entry bound", func(s *Snapshot) { s.Entries = make([]Entry, 2049) }},
		{"effort bound", func(s *Snapshot) { s.Entries[0].Efforts = make([]string, 33) }},
	} {
		t.Run(tc.name, func(t *testing.T) { s := fixture(); tc.change(&s); requireCode(t, ValidateSnapshot(s), Invalid) })
	}
	for _, tc := range []struct {
		route  Route
		source Source
	}{
		{Route{"openai", PlanInference, Plan}, SIWC},
		{Route{"codex", CodexTask, Plan}, AppServer},
		{Route{"codex", CodexTask, API}, AppServer},
		{Route{"farol", BrowserChat, Plan}, Browser},
	} {
		s := fixture()
		s.Scope.Route = tc.route
		s.Source = tc.source
		if err := ValidateSnapshot(s); err != nil {
			t.Fatalf("supported route rejected %+v: %v", tc, err)
		}
	}
}
