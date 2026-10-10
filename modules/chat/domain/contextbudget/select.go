package contextbudget

import (
	"encoding/json"
	"unicode/utf8"
)

// Select measures each canonical event, including IDs/tool metadata and JSON
// escaping. Policy.Reserve must cover the consumer envelope and provider overhead.
// Estimated tokens are explicitly an injected estimate, never upstream usage.
func Select(s Source, ref SourceRef, p Policy, e Estimator) (Window, error) {
	groups, unknowns, err := group(s)
	if err != nil {
		return Window{}, err
	}
	if !p.Valid() || e == nil || !ref.Valid() || ref.Binding != s.Binding || ref.Revision != s.Revision || ref.FirstSequence != s.Events[0].Sequence || ref.LastSequence != s.Events[len(s.Events)-1].Sequence || ref.FirstEventID != s.Events[0].ID || ref.LastEventID != s.Events[len(s.Events)-1].ID {
		return Window{}, Invalid
	}
	costs := make([]Metrics, len(groups))
	chosen := make([]bool, len(groups))
	total := Metrics{}
	for i, g := range groups {
		for _, v := range s.Events[g.start:g.end] {
			raw, err := json.Marshal(v)
			if err != nil {
				return Window{}, Invalid
			}
			m, err := measure(raw, e)
			if err != nil {
				return Window{}, err
			}
			costs[i] = add(costs[i], m)
		}
		if g.required {
			chosen[i] = true
			total = add(total, costs[i])
		}
	}
	if !p.Fits(total) {
		return Window{}, RequiredTooLarge
	}
	// Keep a contiguous recent suffix of optional exchanges. Older required
	// UNKNOWN exchanges are also retained at their exact original positions.
	for i := len(groups) - 1; i >= 0; i-- {
		if chosen[i] {
			continue
		}
		next := add(total, costs[i])
		if !p.Fits(next) {
			break
		}
		chosen[i] = true
		total = next
	}
	out := Window{Source: ref, Events: []Event{}, Unresolved: unknowns, Usage: total}
	for i, g := range groups {
		if chosen[i] {
			out.Events = append(out.Events, s.Events[g.start:g.end]...)
		} else {
			out.OmittedEvents += g.end - g.start
		}
	}
	return out, nil
}

// WithSummary only adds labelled data. It never removes selected originals or
// edits mandatory instructions, unknown references, account binding or grants.
func WithSummary(w Window, s Summary, p Policy, e Estimator) (Window, error) {
	if e == nil || !p.Valid() || !w.Source.Valid() || !p.Fits(w.Usage) || w.Summary != nil || s.Source != w.Source || s.Trust != Untrusted || !ID(s.PromptVersion) || len(s.Text) == 0 || len(s.Text) > MaxEventBytes || !utf8.ValidString(s.Text) {
		return Window{}, Invalid
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return Window{}, Invalid
	}
	m, err := measure(raw, e)
	if err != nil {
		return Window{}, err
	}
	usage := add(w.Usage, m)
	if !p.Fits(usage) {
		return Window{}, RequiredTooLarge
	}
	copy := s
	w.Summary = &copy
	w.Usage = usage
	return w, nil
}

// Recover reselects from the original source rather than trusting imported
// checkpoint events, summary, usage numbers or any purported permission fields.
func Recover(c Checkpoint, s Source, ref SourceRef, p Policy, e Estimator) (Window, error) {
	if c.Version != 1 || !ID(c.ID) || !ID(c.OperationID) || c.Window.Source != ref {
		return Window{}, Stale
	}
	w, err := Select(s, ref, p, e)
	if err != nil {
		return Window{}, err
	}
	// Exact deterministic selection and unresolved references must survive import.
	a, _ := json.Marshal(w)
	b, _ := json.Marshal(Window{Source: c.Window.Source, Events: c.Window.Events, Unresolved: c.Window.Unresolved, Usage: c.Window.Usage, OmittedEvents: c.Window.OmittedEvents})
	if c.Window.Summary != nil {
		with, err := WithSummary(w, *c.Window.Summary, p, e)
		if err != nil {
			return Window{}, err
		}
		without := c.Window
		without.Summary = nil
		without.Usage = w.Usage
		b, _ = json.Marshal(without)
		if string(a) != string(b) {
			return Window{}, Stale
		}
		return with, nil
	}
	if string(a) != string(b) {
		return Window{}, Stale
	}
	return w, nil
}
