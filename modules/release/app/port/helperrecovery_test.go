package port_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/pkg/kernel/domain/failure"
)

func TestHelperRecoveryFailureKind(t *testing.T) {
	tests := []struct {
		name string
		f    *port.HelperRecoveryFailure
		want failure.Kind
	}{
		{"nil", nil, failure.Unknown},
		{"uncertain", &port.HelperRecoveryFailure{Code: "native", Phase: "refused", Uncertain: true}, failure.Unknown},
		{"uncertain internal", &port.HelperRecoveryFailure{Code: "native", Phase: "refused", Internal: true, Uncertain: true}, failure.Unknown},
		{"internal", &port.HelperRecoveryFailure{Code: "native", Phase: "refused", Internal: true}, failure.Failed},
		{"refusal", &port.HelperRecoveryFailure{Code: "existing", Phase: "refused"}, failure.Refused},
		{"phase does not change the kind", &port.HelperRecoveryFailure{Code: "launch_failed", Phase: "launch_requested"}, failure.Refused},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.f.Kind(); got != tt.want {
				t.Fatalf("Kind = %d, want %d", got, tt.want)
			}
		})
	}
	var classified failure.Classified = (*port.HelperRecoveryFailure)(nil)
	if classified.Kind() != failure.Unknown {
		t.Fatalf("a nil failure must classify as Unknown")
	}
}

// legacyRejection is the retired walker from
// modules/release/infra/repos/rejection/repo.go (uncertain), kept verbatim.
func legacyRejection(err error) bool {
	pending := []error{err}
	for remaining := 128; len(pending) > 0; remaining-- {
		if remaining == 0 {
			return true
		}
		e := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if e == nil {
			continue
		}
		if f, ok := e.(*port.HelperRecoveryFailure); ok && (f == nil || f.Uncertain) {
			return true
		}
		switch w := e.(type) {
		case interface{ Unwrap() []error }:
			causes := w.Unwrap()
			if len(causes) > remaining {
				return true
			}
			pending = append(pending, causes...)
		case interface{ Unwrap() error }:
			pending = append(pending, w.Unwrap())
		}
	}
	return false
}

// legacyRecovery is the retired walker from
// modules/release/app/services/helperrecovery/service.go (dependencyUncertain),
// kept verbatim.
func legacyRecovery(err error) bool {
	pending := []error{err}
	remaining := 128
	for len(pending) > 0 {
		if remaining == 0 {
			return true
		}
		remaining--
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if current == nil {
			continue
		}
		if f, classified := current.(*port.HelperRecoveryFailure); classified {
			if f == nil || f.Uncertain {
				return true
			}
		}
		switch wrapped := current.(type) {
		case interface{ Unwrap() []error }:
			causes := wrapped.Unwrap()
			if len(causes) > remaining-len(pending) {
				return true
			}
			pending = append(pending, causes...)
		case interface{ Unwrap() error }:
			pending = append(pending, wrapped.Unwrap())
		}
	}
	return false
}

// joined keeps nil entries, which errors.Join would drop.
type joined []error

func (j joined) Error() string   { return "joined" }
func (j joined) Unwrap() []error { return j }

// link is a mutable single-cause wrapper used to close cycles.
type link struct{ next error }

func (l *link) Error() string { return "link" }
func (l *link) Unwrap() error { return l.next }

func certain(cause error) error {
	return &port.HelperRecoveryFailure{Code: "existing", Phase: "refused", Cause: cause}
}
func internal(cause error) error {
	return &port.HelperRecoveryFailure{Code: "native", Phase: "refused", Internal: true, Cause: cause}
}
func uncertain() error {
	return &port.HelperRecoveryFailure{Code: "native", Phase: "refused", Internal: true, Uncertain: true}
}

// chain returns n entries: n-1 wrappers above last, alternating wrapper types.
func chain(n int, last error) error {
	err := last
	for i := 1; i < n; i++ {
		switch i % 4 {
		case 0:
			err = fmt.Errorf("wrap: %w", err)
		case 1:
			err = certain(err)
		case 2:
			err = &link{next: err}
		default:
			err = internal(err)
		}
	}
	return err
}

func wide(n int, at int, mark error) error {
	causes := make(joined, n)
	for i := range causes {
		if i%3 == 0 {
			causes[i] = errors.New("syscall")
		}
	}
	if at >= 0 {
		causes[at] = mark
	}
	return causes
}

// graph builds a random error graph. Interior nodes are wrappers, certain
// classified failures and joins; leaves include nil entries, cancellation and,
// when mark is set, typed-nil and uncertain failures. back closes a cycle when
// it is non-nil. Unmarked graphs isolate the budget arithmetic.
func graph(r *rand.Rand, mark bool, depth int, back *link) error {
	if depth == 0 || r.IntN(5) == 0 {
		switch r.IntN(9) {
		case 0:
			return nil
		case 1:
			return context.Canceled
		case 2:
			if !mark {
				return certain(nil)
			}
			if r.IntN(4) == 0 {
				return (*port.HelperRecoveryFailure)(nil)
			}
			return uncertain()
		case 3:
			if back != nil && r.IntN(3) == 0 {
				return back
			}
			return certain(nil)
		case 4:
			return internal(nil)
		default:
			return errors.New("syscall")
		}
	}
	switch r.IntN(6) {
	case 0:
		return fmt.Errorf("wrap: %w", graph(r, mark, depth-1, back))
	case 1:
		return certain(graph(r, mark, depth-1, back))
	case 2:
		return internal(graph(r, mark, depth-1, back))
	case 3:
		l := &link{}
		if back == nil && r.IntN(4) == 0 {
			l.next = graph(r, mark, depth-1, l)
		} else {
			l.next = graph(r, mark, depth-1, back)
		}
		return l
	case 4:
		causes := make([]error, 1+r.IntN(12))
		for i := range causes {
			causes[i] = graph(r, mark, depth-1, back)
		}
		return errors.Join(causes...)
	default:
		causes := make(joined, r.IntN(40))
		for i := range causes {
			causes[i] = graph(r, mark, depth-1, back)
		}
		return causes
	}
}

// The release walkers retired into failure.Marked: every case below must give
// the same answer from both legacy walkers and the kernel.
func TestRetiredWalkerParity(t *testing.T) {
	cycle := &link{}
	cycle.next = certain(cycle)
	cases := []struct {
		name string
		err  error
	}{
		{"nil", nil},
		{"syscall", errors.New("syscall")},
		{"cancellation", context.Canceled},
		{"certain", certain(errors.New("syscall"))},
		{"internal", internal(nil)},
		{"uncertain", uncertain()},
		{"typed nil", (*port.HelperRecoveryFailure)(nil)},
		{"wrapped uncertain", fmt.Errorf("x: %w", uncertain())},
		{"uncertain below certain", certain(internal(uncertain()))},
		{"joined uncertain", errors.Join(errors.New("a"), certain(nil), uncertain())},
		{"joined nil entries", joined{nil, certain(nil), nil}},
		{"cycle", cycle},
		{"self cycle", func() error { l := &link{}; l.next = l; return l }()},
	}
	for _, n := range []int{126, 127, 128, 129, 130} {
		cases = append(cases,
			struct {
				name string
				err  error
			}{fmt.Sprintf("chain %d certain", n), chain(n, errors.New("leaf"))},
			struct {
				name string
				err  error
			}{fmt.Sprintf("chain %d uncertain leaf", n), chain(n, uncertain())},
			struct {
				name string
				err  error
			}{fmt.Sprintf("chain %d nil leaf", n), chain(n, &link{})},
		)
	}
	for _, n := range []int{125, 126, 127, 128, 129} {
		for _, at := range []int{-1, 0, n / 2, n - 1} {
			cases = append(cases, struct {
				name string
				err  error
			}{fmt.Sprintf("wide %d mark %d", n, at), wide(n, at, uncertain())})
		}
		cases = append(cases, struct {
			name string
			err  error
		}{fmt.Sprintf("nested wide %d", n), certain(fmt.Errorf("x: %w", wide(n, -1, nil)))})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, b, got := legacyRejection(c.err), legacyRecovery(c.err), failure.Marked(c.err)
			if a != b || got != a {
				t.Fatalf("rejection=%v recovery=%v kernel=%v", a, b, got)
			}
		})
	}

	r := rand.New(rand.NewPCG(20261113, 2))
	var marked, clean, over, near int
	for i := range 40000 {
		err := graph(r, i%2 == 0, 2+r.IntN(5), nil)
		a, b, got := legacyRejection(err), legacyRecovery(err), failure.Marked(err)
		if a != b || got != a {
			t.Fatalf("graph %d: rejection=%v recovery=%v kernel=%v", i, a, b, got)
		}
		n := entries(err, 1000)
		switch {
		case got:
			marked++
		case n > 96:
			near++
			clean++
		default:
			clean++
		}
		if n > 128 {
			over++
		}
	}
	// Both answers and the budget edge must be exercised, or the random half
	// proves nothing.
	t.Logf("random graphs: marked=%d clean=%d over budget=%d clean near budget=%d", marked, clean, over, near)
	if marked < 1000 || clean < 1000 || over < 500 || near < 50 {
		t.Fatalf("weak random coverage: marked=%d clean=%d over=%d near=%d", marked, clean, over, near)
	}
}

// entries counts the walked entries, nil ones included, up to limit.
func entries(err error, limit int) int {
	n := 0
	pending := []error{err}
	for len(pending) > 0 && n < limit {
		n++
		e := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		switch w := e.(type) {
		case interface{ Unwrap() []error }:
			pending = append(pending, w.Unwrap()...)
		case interface{ Unwrap() error }:
			pending = append(pending, w.Unwrap())
		}
	}
	return n
}
