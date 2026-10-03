package port

import (
	"strings"
	"unicode/utf8"
)

type FactSource string

const (
	FactUnknown       FactSource = "unknown"
	FactPublicControl FactSource = "public-control"
)

// Value is independently mapped canonical control identity; Literal is actual public text.
// Policy account/alias/grant references are never public-control facts.
type ControlFact struct {
	Value, Literal string
	Source         FactSource
}
type SelectionFacts struct {
	Model, Effort, Mode, Connector ControlFact
	ObservedAtMillis               uint64
}
type RequiredControls struct{ Model, Effort, Mode, Connector bool }

func (r RequiredControls) Valid(s Selection) bool {
	return r.Model && (!r.Mode || s.Mode != "") && (s.Mode == "" || r.Mode) && r.Connector == s.ToolsEnabled
}
func (f ControlFact) Known() bool { return f.Source == FactPublicControl }
func (f ControlFact) Valid() bool {
	if f.Source == "" || f.Source == FactUnknown {
		return f.Value == "" && f.Literal == ""
	}
	if f.Source != FactPublicControl || !conversationID(f.Value) || len(f.Literal) < 1 || len(f.Literal) > 256 || !utf8.ValidString(f.Literal) || strings.TrimSpace(f.Literal) == "" {
		return false
	}
	for _, c := range f.Literal {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}
func (f SelectionFacts) Matches(s Selection, r RequiredControls) bool {
	if !r.Valid(s) || f.ObservedAtMillis == 0 {
		return false
	}
	if f.Mode.Known() && f.Mode.Value != "standard" && f.Mode.Value != "pro" {
		return false
	}
	for index, x := range []struct {
		fact     ControlFact
		required bool
		expected string
	}{{f.Model, true, s.ModelID}, {f.Effort, r.Effort, s.Effort}, {f.Mode, r.Mode, s.Mode}, {f.Connector, r.Connector, s.ConnectorID}} {
		if !x.fact.Valid() || (x.required && !x.fact.Known()) || (x.fact.Known() && ((x.expected != "" && x.fact.Value != x.expected) || (x.expected == "" && index != 2))) {
			return false
		}
	}
	return true
}
func (f SelectionFacts) Projection() SelectionFacts {
	for _, x := range []*ControlFact{&f.Model, &f.Effort, &f.Mode, &f.Connector} {
		if x.Source == "" {
			x.Source = FactUnknown
		}
	}
	return f
}
