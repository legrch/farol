package failure

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// kinded is a module-owned failure type that classifies itself additively.
type kinded struct{ kind Kind }

func (k *kinded) Error() string { return "kinded" }
func (k *kinded) Kind() Kind {
	if k == nil {
		return Unknown
	}
	return k.kind
}

// plain is an unclassified leaf without Unwrap.
type plain struct{}

func (plain) Error() string { return "plain" }

// link is an unclassified single-cause wrapper.
type link struct{ next error }

func (l *link) Error() string { return "link" }
func (l *link) Unwrap() error { return l.next }

// many is an unclassified joined wrapper that may hold nil entries.
type many struct{ causes []error }

func (m *many) Error() string   { return "many" }
func (m *many) Unwrap() []error { return m.causes }

// chain returns n entries: n-1 links above last.
func chain(n int, last error) error {
	err := last
	for i := 1; i < n; i++ {
		err = &link{next: err}
	}
	return err
}

func cycle() error {
	l := &link{}
	l.next = l
	return l
}

func TestKindsAreExhaustive(t *testing.T) {
	seen := 0
	for k := Kind(0); k < kinds; k++ {
		switch k {
		case Unknown, Unavailable, Refused, Failed:
			seen++
		default:
			t.Fatalf("kind %d has no case", k)
		}
	}
	if seen != 4 {
		t.Fatalf("kinds = %d, want 4", seen)
	}
	if Unknown != 0 {
		t.Fatalf("the zero kind must be Unknown")
	}
	if !(Unavailable < Refused && Refused < Failed) {
		t.Fatalf("severity order changed")
	}
}

func TestNewAndWrap(t *testing.T) {
	cause := errors.New("private")
	tests := []struct {
		name  string
		err   *Error
		kind  Kind
		code  string
		cause error
	}{
		{"refused", New(Refused, "INPUT_INVALID"), Refused, "INPUT_INVALID", nil},
		{"unavailable", New(Unavailable, "OWNER_UNAVAILABLE"), Unavailable, "OWNER_UNAVAILABLE", nil},
		{"failed with cause", Wrap(Failed, "native", cause), Failed, "native", cause},
		{"unknown", Wrap(Unknown, "OUTCOME_UNKNOWN", cause), Unknown, "OUTCOME_UNKNOWN", cause},
		{"kind outside the set", New(kinds, "x"), Unknown, "x", nil},
		{"largest kind", New(Kind(255), "x"), Unknown, "x", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err.Kind() != tt.kind || tt.err.Code() != tt.code || tt.err.Error() != tt.code || tt.err.Unwrap() != tt.cause {
				t.Fatalf("got kind %d code %q text %q cause %v", tt.err.Kind(), tt.err.Code(), tt.err.Error(), tt.err.Unwrap())
			}
		})
	}
	for k := int(kinds); k < 256; k++ {
		if got := New(Kind(k), "x").Kind(); got != Unknown {
			t.Fatalf("New(%d).Kind() = %d, want Unknown", k, got)
		}
	}
}

func TestNilError(t *testing.T) {
	var e *Error
	if e.Kind() != Unknown || e.Code() != "" || e.Error() != "" || e.Unwrap() != nil {
		t.Fatalf("nil *Error must be an empty Unknown")
	}
}

func TestStandardLibraryInterop(t *testing.T) {
	cause := errors.New("private")
	err := fmt.Errorf("context: %w", Wrap(Refused, "STATE_REFUSED", cause))
	var target *Error
	if !errors.As(err, &target) || target.Code() != "STATE_REFUSED" {
		t.Fatalf("errors.As lost the failure")
	}
	var classified Classified
	if !errors.As(err, &classified) || classified.Kind() != Refused {
		t.Fatalf("errors.As lost the classification")
	}
	if !errors.Is(err, cause) {
		t.Fatalf("errors.Is lost the cause")
	}
}

func TestOf(t *testing.T) {
	refused, failed, unavailable, unknown := New(Refused, "r"), New(Failed, "f"), New(Unavailable, "u"), New(Unknown, "x")
	tests := []struct {
		name string
		err  error
		want Kind
	}{
		{"nil", nil, Unknown},
		{"unclassified", errors.New("x"), Unknown},
		{"cancellation is not a refusal", context.Canceled, Unknown},
		{"refused", refused, Refused},
		{"unavailable", unavailable, Unavailable},
		{"failed", failed, Failed},
		{"unknown", unknown, Unknown},
		{"wrapping preserves the kind", fmt.Errorf("a: %w", fmt.Errorf("b: %w", refused)), Refused},
		{"classified node answers for its causes", Wrap(Refused, "r", errors.New("syscall")), Refused},
		{"nested unknown dominates", Wrap(Refused, "r", fmt.Errorf("x: %w", unknown)), Unknown},
		{"unknown beside a refusal", errors.Join(refused, unknown), Unknown},
		{"unclassified branch beside a refusal", errors.Join(refused, errors.New("x")), Unknown},
		{"most severe outermost kind", errors.Join(refused, failed, unavailable), Failed},
		{"refused over unavailable", errors.Join(unavailable, refused), Refused},
		{"outer kind answers for a nested kind", Wrap(Refused, "r", failed), Refused},
		{"nil entries are no branch", &many{causes: []error{nil, refused, nil}}, Refused},
		{"only nil entries", &many{causes: []error{nil, nil}}, Unknown},
		{"wrapper of nil", &link{}, Unknown},
		{"module type", fmt.Errorf("x: %w", &kinded{kind: Failed}), Failed},
		{"nil module pointer", (*kinded)(nil), Unknown},
		{"nil kernel pointer", (*Error)(nil), Unknown},
		{"kind outside the set", &kinded{kind: 9}, Unknown},
		{"cycle", cycle(), Unknown},
		{"classified cycle", func() error { l := &link{}; l.next = Wrap(Refused, "r", l); return l }(), Unknown},
		{"depth at the budget", chain(budget, &kinded{kind: Refused}), Refused},
		{"depth over the budget", chain(budget+1, &kinded{kind: Refused}), Unknown},
		{"width over the budget", &many{causes: make([]error, budget)}, Unknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Of(tt.err); got != tt.want {
				t.Fatalf("Of = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestMarked(t *testing.T) {
	unknown := New(Unknown, "x")
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"unclassified carries no mark", errors.New("x"), false},
		{"refused", New(Refused, "r"), false},
		{"failed", New(Failed, "f"), false},
		{"unknown", unknown, true},
		{"wrapped unknown", fmt.Errorf("x: %w", unknown), true},
		{"unknown below a classified node", Wrap(Refused, "r", unknown), true},
		{"unknown in a joined branch", errors.Join(errors.New("a"), New(Refused, "r"), unknown), true},
		{"nil module pointer", (*kinded)(nil), true},
		{"kind outside the set", &kinded{kind: 200}, true},
		{"cycle", cycle(), true},
		{"depth at the budget", chain(budget, plain{}), false},
		{"depth over the budget", chain(budget+1, plain{}), true},
		{"nil entries count", chain(budget, &many{causes: []error{nil}}), true},
		{"width at the budget", &many{causes: make([]error, budget-1)}, false},
		{"width over the budget", &many{causes: make([]error, budget)}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Marked(tt.err); got != tt.want {
				t.Fatalf("Marked = %v, want %v", got, tt.want)
			}
		})
	}
}

// An oversized graph is unknown whether or not the walk reaches its unknown
// entry; a found Unknown ends the walk before the budget is spent.
func TestScanStopsAtUnknown(t *testing.T) {
	err := &many{causes: append(make([]error, budget), New(Unknown, "x"))}
	if !Marked(err) || Of(err) != Unknown {
		t.Fatalf("an oversized graph must stay unknown")
	}
	if s := scan(New(Unknown, "x")); !s.unknown || s.complete {
		t.Fatalf("scan = %+v, want an early unknown", s)
	}
	if s := scan(errors.Join(New(Refused, "r"), New(Failed, "f"))); !s.complete || s.unknown || s.uncovered || s.worst != Failed {
		t.Fatalf("scan = %+v", s)
	}
}
