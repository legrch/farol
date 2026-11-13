// Package failure classifies what a caller may assume about the effect of a
// failed operation. Modules keep their own codes and failure types and classify
// them through Kind; each boundary adapter maps Kind to its wire outcome once.
// It holds no business vocabulary, clock, randomness or IO.
package failure

// Kind says what a caller may assume about the effect of a failed operation.
// The zero value is Unknown on purpose: an unclassified failure never looks
// like a clean refusal. The kinds after Unknown run from the least to the most
// severe; Of reports the most severe one.
type Kind uint8

const (
	// Unknown: the effect may have happened. Never retry, replay or report it
	// as a refusal.
	Unknown Kind = iota
	// Unavailable: refused before any effect because a required capability or
	// dependency is not ready.
	Unavailable
	// Refused: rejected before any effect; an unchanged repeat is refused again.
	Refused
	// Failed: attempted and failed in a known state; neither a clean refusal
	// nor uncertain. A boundary that can only tell "nothing happened" from
	// "unknown" reports it as unknown.
	Failed
	kinds // the number of kinds; not a kind
)

// Classified is satisfied additively by a module's own failure type. Kind must
// answer on a nil receiver; a nil classified pointer is Unknown.
type Classified interface {
	error
	Kind() Kind
}

// Error is a self-classified failure: a stable machine code owned by the
// module, its kind and an optional private cause.
type Error struct {
	kind  Kind
	code  string
	cause error
}

// New returns a failure of kind with code. A kind outside the closed set is
// Unknown.
func New(kind Kind, code string) *Error {
	return Wrap(kind, code, nil)
}

// Wrap is New with a private cause. The cause is visible to errors.Is,
// errors.As, Of and Marked; it never changes the error text.
func Wrap(kind Kind, code string, cause error) *Error {
	if kind >= kinds {
		kind = Unknown
	}
	return &Error{kind: kind, code: code, cause: cause}
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.code
}

// Code is the module's stable machine code.
func (e *Error) Code() string {
	if e == nil {
		return ""
	}
	return e.code
}

func (e *Error) Kind() Kind {
	if e == nil {
		return Unknown
	}
	return e.kind
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// budget bounds one walk, counting every entry including nil ones. A larger
// or cyclic graph cannot be shown free of an unknown effect.
const budget = 128

// Of classifies err for a boundary, walking Unwrap() error and
// Unwrap() []error. It is Unknown when any node is classified Unknown (or
// outside the closed set), when a branch reaches an unclassified leaf with no
// classified node above it, when no node is classified, when err is nil, or
// when the graph exceeds the budget. Otherwise it is the most severe kind among
// the outermost classified nodes; a classified node answers for its causes
// unless one of them is Unknown.
func Of(err error) Kind {
	s := scan(err)
	if s.unknown || !s.complete || s.uncovered || s.worst == Unknown {
		return Unknown
	}
	return s.worst
}

// Marked reports whether err carries an explicit Unknown classification, or is
// too large or cyclic to tell. An unclassified node carries none. Use Marked
// where the caller decides certainty from its own effect state and asks only
// whether a dependency reported an unknown effect; use Of at a boundary.
func Marked(err error) bool {
	s := scan(err)
	return s.unknown || !s.complete
}

type entry struct {
	err     error
	covered bool // a classified ancestor answers for this entry
}

type summary struct {
	worst     Kind // most severe outermost classification; Unknown when none
	unknown   bool // a node is classified Unknown
	uncovered bool // an unclassified leaf has no classified ancestor
	complete  bool // the whole graph fit the budget
}

// scan walks depth-first and stops at the first Unknown classification. It
// gives up as soon as the entries still to visit exceed the remaining budget,
// so pending never holds more entries than the budget has left.
func scan(err error) summary {
	var s summary
	pending := []entry{{err: err}}
	for remaining := budget; len(pending) > 0; {
		remaining--
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if current.err == nil {
			continue
		}
		covered := current.covered
		if c, ok := current.err.(Classified); ok {
			kind := c.Kind()
			if kind == Unknown || kind >= kinds {
				s.unknown = true
				return s
			}
			if !covered && kind > s.worst {
				s.worst = kind
			}
			covered = true
		}
		var causes []error
		switch wrapped := current.err.(type) {
		case interface{ Unwrap() []error }:
			causes = wrapped.Unwrap()
		case interface{ Unwrap() error }:
			causes = []error{wrapped.Unwrap()}
		}
		if !covered && leaf(causes) {
			s.uncovered = true
		}
		if len(pending)+len(causes) > remaining {
			return s
		}
		for _, cause := range causes {
			pending = append(pending, entry{err: cause, covered: covered})
		}
	}
	s.complete = true
	return s
}

func leaf(causes []error) bool {
	for _, cause := range causes {
		if cause != nil {
			return false
		}
	}
	return true
}
