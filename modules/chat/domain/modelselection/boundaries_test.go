package modelselection

import (
	"math/rand"
	"testing"
)

func TestCapturedSelectionSurvivesRequestAndCatalogueMutation(t *testing.T) {
	s := fixture()
	request := Request{Preferences: []Preference{{"text", "careful"}, {"vision", "adaptive"}}, Requirements: Requirements{Text: true}}
	resolved, err := Resolve(s, s.Scope, 150, request)
	if err != nil {
		t.Fatal(err)
	}
	pin, capabilities := resolved.Pin(), resolved.Capabilities()
	request.Preferences[0] = Preference{"vision", "adaptive"}
	request.Requirements.Tools = true
	s.Entries[0].Efforts[1] = "adaptive"
	s.Entries[0].Slug = "replacement"
	s.Entries[0].Capabilities.Text = No
	if resolved.Pin() != pin || resolved.Capabilities() != capabilities {
		t.Fatal("caller mutation retargeted a captured selection")
	}
	if err := RecheckBeforeStart(resolved, fixture(), pinScope(pin), 151); err != nil {
		t.Fatalf("captured requirements changed with the request: %v", err)
	}
}

func pinScope(p Pin) Scope { return Scope{Route: p.Route, AccountID: p.AccountID} }

func TestRevocationReconnectNeverReplacesCapturedBinding(t *testing.T) {
	s := fixture()
	resolved, err := Resolve(s, s.Scope, 150, Request{Slug: "text", Effort: "careful", Requirements: Requirements{Text: true}})
	if err != nil {
		t.Fatal(err)
	}
	original := resolved.Pin()
	revoked := CloneSnapshot(s)
	revoked.Entries = revoked.Entries[1:]
	requireCode(t, RecheckBeforeStart(resolved, revoked, revoked.Scope, 151), Unavailable)
	views := Project(revoked, revoked.Scope, 151, &resolved)
	if last := views[len(views)-1]; last.State != Revoked || !last.Selected || last.Discovered {
		t.Fatalf("revoked binding projection = %+v", last)
	}
	reconnected := CloneSnapshot(s)
	reconnected.Epoch++
	reconnected.Revision = "reconnected"
	requireCode(t, RecheckBeforeStart(resolved, reconnected, reconnected.Scope, 151), Changed)
	newSelection, err := Resolve(reconnected, reconnected.Scope, 151, Request{Slug: "text", Effort: "careful", Requirements: Requirements{Text: true}})
	if err != nil || newSelection.Pin() == original {
		t.Fatalf("reconnect did not create an independent selection: %+v, %v", newSelection.Pin(), err)
	}
	otherAccount := reconnected.Scope
	otherAccount.AccountID = "other-account"
	if Project(reconnected, otherAccount, 151, &resolved) != nil {
		t.Fatal("revoked account binding appeared in another account")
	}
	if resolved.Pin() != original {
		t.Fatal("revocation or reconnect replaced the running binding")
	}
}

func TestExplicitChoiceRejectionsDoNotUseEligiblePreferences(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Snapshot, *Request)
		code   ErrorCode
	}{
		{"absent", func(s *Snapshot, r *Request) { r.Slug = "absent" }, Unavailable},
		{"hidden", func(s *Snapshot, r *Request) { s.Entries[0].Hidden = true }, Unavailable},
		{"archived", func(s *Snapshot, r *Request) { s.Entries[0].Archived = true }, Unavailable},
		{"effort refused", func(s *Snapshot, r *Request) { r.Effort = "unadvertised" }, Unsupported},
		{"capability refused", func(s *Snapshot, r *Request) { r.Requirements.Image = true }, Unsupported},
		{"unknown capability", func(s *Snapshot, r *Request) { s.Entries[0].Capabilities.Text = Unknown }, Unsupported},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fixture()
			r := Request{Slug: "text", Effort: "careful", Preferences: []Preference{{"vision", "adaptive"}}, Requirements: Requirements{Text: true}}
			tc.change(&s, &r)
			resolved, err := Resolve(s, s.Scope, 150, r)
			requireCode(t, err, tc.code)
			if resolved != (Resolved{}) {
				t.Fatalf("rejected choice produced a fallback binding: %+v", resolved.Pin())
			}
		})
	}
}

func TestPreferenceOrderIsIndependentOfCatalogueOrder(t *testing.T) {
	rng := rand.New(rand.NewSource(71))
	for i := 0; i < 256; i++ {
		s := fixture()
		prefs := []Preference{{"absent", ""}, {"text", "careful"}, {"vision", "adaptive"}}
		rng.Shuffle(len(s.Entries), func(i, j int) { s.Entries[i], s.Entries[j] = s.Entries[j], s.Entries[i] })
		rng.Shuffle(len(prefs), func(i, j int) { prefs[i], prefs[j] = prefs[j], prefs[i] })
		want := ""
		for _, p := range prefs {
			if p.Slug != "absent" {
				want = p.Slug
				break
			}
		}
		resolved, err := Resolve(s, s.Scope, 150, Request{Preferences: prefs, Requirements: Requirements{Text: true}})
		if err != nil || resolved.Pin().Model != want {
			t.Fatalf("iteration %d: preference order %v selected %+v: %v", i, prefs, resolved.Pin(), err)
		}
	}
}

func TestCompatibilityTruthTablePreservesUnknowns(t *testing.T) {
	states := []Knowledge{No, Unknown, Yes}
	for _, text := range states {
		for _, image := range states {
			for _, tools := range states {
				c := Capabilities{Text: text, Image: image, Tools: tools}
				for mask := 0; mask < 8; mask++ {
					r := Requirements{Text: mask&1 != 0, Image: mask&2 != 0, Tools: mask&4 != 0}
					want := Yes
					for index, value := range []Knowledge{text, image, tools} {
						if mask&(1<<index) == 0 {
							continue
						}
						if value == No {
							want = No
							break
						}
						if value == Unknown {
							want = Unknown
						}
					}
					if got := Compatible(c, r); got != want {
						t.Fatalf("capabilities %+v requirements %+v = %q, want %q", c, r, got, want)
					}
				}
			}
		}
	}
}
