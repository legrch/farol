package modelselection

type AvailabilityState string

const (
	Discovered             AvailabilityState = "discovered"
	Selected               AvailabilityState = "selected"
	CompatibleModel        AvailabilityState = "compatible"
	EntitlementUntested    AvailabilityState = "entitlement-not-yet-tested"
	TemporarilyUnavailable AvailabilityState = "temporarily-unavailable"
	Revoked                AvailabilityState = "revoked"
	UnsupportedModel       AvailabilityState = "unsupported"
)

type Availability struct {
	Scope                Scope
	Epoch                uint64
	ExpiresAtMillis      uint64
	Model, DisplayName   string
	State                AvailabilityState
	Discovered, Selected bool
	Compatible           Knowledge
	Entitlement          AvailabilityState
	Capabilities         Capabilities
	Reason               string
}

// Project emits honest rendering values. Catalogue discovery never tests entitlement.
func Project(s Snapshot, current Scope, now uint64, selected *Resolved) []Availability {
	return ProjectForRequirements(s, current, now, selected, Requirements{})
}
func ProjectForRequirements(s Snapshot, current Scope, now uint64, selected *Resolved, r Requirements) []Availability {
	err := usable(s, current, now)
	// Do not expose a different account's model list under the current identity.
	if s.Scope != current || ValidateSnapshot(s) != nil {
		return nil
	}
	result := make([]Availability, 0, len(s.Entries)+1)
	found := false
	for _, e := range s.Entries {
		a := Availability{Scope: s.Scope, Epoch: s.Epoch, ExpiresAtMillis: s.ExpiresAtMillis, Model: e.Slug, DisplayName: e.DisplayName, State: Discovered, Discovered: true, Compatible: Compatible(e.Capabilities, r), Entitlement: EntitlementUntested, Capabilities: e.Capabilities, Reason: "discovered; entitlement has not been tested"}
		a.Selected = selected != nil && selected.valid && selected.pin.Route == current.Route && selected.pin.AccountID == current.AccountID && selected.pin.Model == e.Slug
		found = found || a.Selected
		switch {
		case err != nil:
			a.State = TemporarilyUnavailable
			a.Reason = err.Error()
		case e.Archived:
			a.State = Revoked
			a.Reason = "model is archived"
		case e.Hidden:
			a.State = TemporarilyUnavailable
			a.Reason = "model is hidden"
		case a.Compatible == No:
			a.State = UnsupportedModel
			a.Reason = "known capability does not meet requirements"
		case a.Compatible == Unknown:
			a.State = EntitlementUntested
			a.Reason = "capability evidence is unknown; entitlement has not been tested"
		case a.Selected:
			a.State = Selected
		default:
			a.State = CompatibleModel
		}
		result = append(result, a)
	}
	if selected != nil && selected.valid && !found && selected.pin.Route == current.Route && selected.pin.AccountID == current.AccountID {
		state := Revoked
		if err != nil {
			state = TemporarilyUnavailable
		}
		result = append(result, Availability{Scope: current, Epoch: s.Epoch, ExpiresAtMillis: s.ExpiresAtMillis, Model: selected.pin.Model, State: state, Selected: true, Compatible: Unknown, Entitlement: EntitlementUntested, Capabilities: selected.capabilities, Reason: "selected model is absent from current catalogue"})
	}
	return result
}
