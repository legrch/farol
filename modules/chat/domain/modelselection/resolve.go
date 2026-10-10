package modelselection

type Requirements struct{ Text, Image, Tools bool }
type Preference struct{ Slug, Effort string }
type Request struct {
	Slug, Effort string
	Preferences  []Preference
	Requirements Requirements
}

// Pin is an immutable binding when returned by value. It contains no catalogue slices.
type Pin struct {
	Route                                       Route
	AccountID                                   string
	Epoch                                       uint64
	Revision, Model, Effort, CapabilityRevision string
}
type Resolved struct {
	pin          Pin
	capabilities Capabilities
	requirements Requirements
	valid        bool
}

func (r Resolved) Pin() Pin                   { return r.pin }
func (r Resolved) Capabilities() Capabilities { return r.capabilities }

func usable(s Snapshot, current Scope, now uint64) error {
	if err := ValidateSnapshot(s); err != nil {
		return err
	}
	if s.Scope != current {
		return deny(WrongScope, "catalogue belongs to another account or route")
	}
	if now < s.ObservedAtMillis || now >= s.ExpiresAtMillis {
		return deny(Stale, "catalogue is outside its validity interval")
	}
	if !s.Complete {
		return deny(Partial, "incomplete catalogue cannot authorize a new selection")
	}
	return nil
}

func Compatible(c Capabilities, r Requirements) Knowledge {
	values := []struct {
		needed bool
		value  Knowledge
	}{{r.Text, c.Text}, {r.Image, c.Image}, {r.Tools, c.Tools}}
	unknown := false
	for _, v := range values {
		if v.needed {
			if v.value == No {
				return No
			}
			if v.value != Yes {
				unknown = true
			}
		}
	}
	if unknown {
		return Unknown
	}
	return Yes
}

func choose(s Snapshot, p Preference, r Requirements) (Resolved, error) {
	for _, e := range s.Entries {
		if e.Slug != p.Slug {
			continue
		}
		if e.Hidden || e.Archived {
			return Resolved{}, deny(Unavailable, "selected model is hidden or archived")
		}
		if Compatible(e.Capabilities, r) != Yes {
			return Resolved{}, deny(Unsupported, "capability evidence cannot satisfy "+describeRequirements(r))
		}
		effort := p.Effort
		if effort == "" {
			effort = e.DefaultEffort
		}
		if effort != "" {
			found := false
			for _, v := range e.Efforts {
				found = found || v == effort
			}
			if !found {
				return Resolved{}, deny(Unsupported, "selected effort is not advertised")
			}
		} else if len(e.Efforts) > 0 {
			return Resolved{}, deny(Unsupported, "effort must be explicit when no default is advertised")
		}
		return Resolved{pin: Pin{Route: s.Scope.Route, AccountID: s.Scope.AccountID, Epoch: s.Epoch, Revision: s.Revision, Model: e.Slug, Effort: effort, CapabilityRevision: e.Capabilities.Revision}, capabilities: e.Capabilities, requirements: r, valid: true}, nil
	}
	return Resolved{}, deny(Unavailable, "selected model is absent from catalogue")
}

// Resolve applies preferences only before dispatch. Explicit choice never falls back.
// The caller preserves Resolved for the entire operation after dispatch or refusal.
func Resolve(s Snapshot, current Scope, now uint64, request Request) (Resolved, error) {
	if err := usable(s, current, now); err != nil {
		return Resolved{}, err
	}
	if len(request.Preferences) > 128 || (request.Slug != "" && !validString(request.Slug, 256)) || (request.Effort != "" && !validString(request.Effort, 64)) || (request.Slug == "" && request.Effort != "") {
		return Resolved{}, deny(Invalid, "invalid selection request")
	}
	if request.Slug != "" {
		return choose(s, Preference{request.Slug, request.Effort}, request.Requirements)
	}
	for _, p := range request.Preferences {
		if !validString(p.Slug, 256) || (p.Effort != "" && !validString(p.Effort, 64)) {
			return Resolved{}, deny(Invalid, "invalid model preference")
		}
	}
	for _, p := range request.Preferences {
		if selected, err := choose(s, p, request.Requirements); err == nil {
			return selected, nil
		}
	}
	return Resolved{}, deny(Unsupported, "no supplied preference satisfies the requested model, effort and capabilities")
}

// RecheckBeforeStart checks the exact captured binding before first dispatch only.
// It does not update a running binding or authorize retry after an unknown outcome.
func RecheckBeforeStart(r Resolved, s Snapshot, current Scope, now uint64) error {
	if !r.valid {
		return deny(Invalid, "empty resolved binding")
	}
	if err := usable(s, current, now); err != nil {
		return err
	}
	if r.pin.Route != current.Route || r.pin.AccountID != current.AccountID {
		return deny(WrongScope, "resolved binding belongs to another account or route")
	}
	latest, err := choose(s, Preference{r.pin.Model, r.pin.Effort}, r.requirements)
	if err != nil {
		return err
	}
	if latest.pin != r.pin || latest.capabilities != r.capabilities {
		return deny(Changed, "catalogue or capability evidence changed before dispatch")
	}
	return nil
}
