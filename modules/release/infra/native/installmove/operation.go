// Package installmove provides an unselected, one-attempt app namespace primitive.
// Release retains route, lease, slot, journal and admission authority in Fence.
// Expected device/inode values do not prove accepted tree contents or attributes:
// Fence must verify those. Private snapshots preserve mode/owner/group from the
// first observation through the effect and readback, as Python identity() does.
// Native calls run synchronously: deadlines cannot interrupt a blocked kernel call.
package installmove

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

type Identity struct{ Device, Inode string }

// ParentKind is selected only by trusted native composition after verifying the
// physical root/Applications route and Release Fence. It grants no authority and
// must never be decoded from wire input. The zero value retains private custody.
type ParentKind uint8

const (
	OwnedParent ParentKind = iota
	SharedApplicationsParent
)

type Directory struct {
	File     *os.File
	Identity Identity
	Kind     ParentKind
}
type Location struct {
	Parent Directory
	Name   string
}

// Fence revalidates Release's named route, lease, slot, journal and admission.
// It must not close, replace or reconfigure either borrowed parent handle.
type Fence func(context.Context) error

// Failure contains only bounded classifications, never native paths or errors.
// Uncertain prohibits retry, rollback, or inferring which namespace is current.
// Internal distinguishes unexpected infrastructure errors from known refusals.
type Failure struct {
	Code                string
	Uncertain, Internal bool
	cause               error
}

func (f *Failure) Error() string { return f.Code }
func (f *Failure) Unwrap() error { return f.cause }

type attempt struct{ consumed atomic.Bool }

var errEntryChanged = errors.New("entry_changed")

// Operation captures immutable inputs. Copies share the same attempt admission.
// The caller owns both exact parent handles through Run's actual return, including
// admission and any blocked syscall; this package never closes or changes them.
type Operation struct {
	left, right                 Location
	leftExpected, rightExpected Identity
	until                       time.Time
	fence                       Fence
	exchange                    bool
	capturePublication          bool
	state                       *attempt
	backend                     backend
}

func PrepareRename(source, target Location, expected Identity, until time.Time, fence Fence) (*Operation, error) {
	return prepare(source, target, expected, Identity{}, until, fence, false, productionBackend())
}
func PrepareExchange(left, right Location, leftExpected, rightExpected Identity, until time.Time, fence Fence) (*Operation, error) {
	return prepare(left, right, leftExpected, rightExpected, until, fence, true, productionBackend())
}

// PrepareCapturePublication is the sole extra rename role. Trusted copy
// composition supplies its internally generated capture name; neither ordinary
// rename/exchange nor shared Applications accepts either capture role. Both
// operands must be the SAME private operation directory and never overwrite.
func PrepareCapturePublication(directory Directory, capture string, expected Identity, until time.Time, fence Fence) (*Operation, error) {
	return prepareCapturePublication(directory, capture, expected, until, fence, productionBackend())
}

func prepareCapturePublication(d Directory, name string, expected Identity, until time.Time, fence Fence, b backend) (*Operation, error) {
	if d.File == nil || d.Kind != OwnedParent || !validIdentity(d.Identity) || !validIdentity(expected) ||
		len(name) != len(".launch-capture-")+24 || name[:len(".launch-capture-")] != ".launch-capture-" || until.IsZero() || fence == nil {
		return nil, &Failure{Code: "input"}
	}
	for _, c := range name[len(".launch-capture-"):] {
		if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
			return nil, &Failure{Code: "input"}
		}
	}
	if b == nil {
		return nil, &Failure{Code: "rename_unsupported"}
	}
	return &Operation{left: Location{Parent: d, Name: name}, right: Location{Parent: d, Name: "launch-Farol.app"}, leftExpected: expected, until: until, fence: fence, state: &attempt{}, backend: b, capturePublication: true}, nil
}
func prepare(left, right Location, le, re Identity, until time.Time, fence Fence, exchange bool, b backend) (*Operation, error) {
	if !validLocation(left) || !validLocation(right) || !validIdentity(le) || exchange && !validIdentity(re) {
		return nil, &Failure{Code: "input"}
	}
	if until.IsZero() || fence == nil || left.Parent.Identity == right.Parent.Identity && left.Name == right.Name || exchange && le == re {
		return nil, &Failure{Code: "input"}
	}
	if b == nil {
		return nil, &Failure{Code: unsupported(exchange)}
	}
	return &Operation{left: left, right: right, leftExpected: le, rightExpected: re, until: until, fence: fence, exchange: exchange, state: &attempt{}, backend: b}, nil
}
func validIdentity(i Identity) bool { return canonical(i.Device) && canonical(i.Inode) }
func canonical(s string) bool {
	if len(s) == 0 || len(s) > 20 {
		return false
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && strconv.FormatUint(n, 10) == s
}
func validLocation(l Location) bool {
	if l.Parent.File == nil || !validIdentity(l.Parent.Identity) {
		return false
	}
	switch l.Parent.Kind {
	case OwnedParent:
	case SharedApplicationsParent:
		if l.Name != "Farol.app" {
			return false
		}
	default:
		return false
	}
	switch l.Name {
	case "Farol.app", "staged.app", "previous.app", "failed.app":
		return true
	}
	return false
}
func unsupported(exchange bool) string {
	if exchange {
		return "exchange_unsupported"
	}
	return "rename_unsupported"
}
func (o *Operation) uncertain(internal bool, cause error) error {
	code := "move_uncertain"
	if o.exchange {
		code = "exchange_uncertain"
	}
	return &Failure{Code: code, Uncertain: true, Internal: internal, cause: cause}
}
func (o *Operation) precondition() string {
	if o.exchange {
		return "exchange_precondition"
	}
	return "source_replaced"
}

// Run consumes admission before any I/O, even on cancellation or fence refusal.
// A duplicate returns conservatively uncertain without dispatching another effect.
func (o *Operation) Run(ctx context.Context) error {
	if o == nil || o.state == nil || o.backend == nil {
		return &Failure{Code: "input"}
	}
	if !o.state.consumed.CompareAndSwap(false, true) {
		return &Failure{Code: "operation_consumed", Uncertain: true}
	}
	if ctx == nil {
		return &Failure{Code: "input"}
	}
	if deadline, ok := ctx.Deadline(); !ok || o.until.Before(deadline) {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, o.until)
		defer cancel()
	}
	if err := canceled(ctx); err != nil {
		return err
	}
	// RawConn.Control holds the exact os.File references for the entire synchronous
	// operation. No borrowed numeric descriptor escapes either callback lifetime.
	l, err := o.left.Parent.File.SyscallConn()
	if err != nil {
		return &Failure{Code: "parent_replaced", Internal: true}
	}
	r, err := o.right.Parent.File.SyscallConn()
	if err != nil {
		return &Failure{Code: "parent_replaced", Internal: true}
	}
	var result error
	var attempted bool
	err = l.Control(func(lfd uintptr) {
		inner := r.Control(func(rfd uintptr) { result = o.run(ctx, int(lfd), int(rfd), &attempted) })
		if inner != nil && result == nil {
			result = &Failure{Code: "parent_replaced", Internal: true}
		}
	})
	if result != nil {
		// Owned-pin cleanup also runs synchronously inside Control. A deadline
		// crossed there must not leave an earlier native refusal looking safe.
		if attempted {
			if c := canceled(ctx); c != nil {
				var failure *Failure
				return o.uncertain(errors.As(result, &failure) && failure.Internal, c)
			}
		}
		return result
	}
	if err != nil {
		if attempted {
			return o.uncertain(true, nil)
		}
		return &Failure{Code: "parent_replaced", Internal: true}
	}
	if err := canceled(ctx); err != nil {
		if attempted {
			return o.uncertain(false, err)
		}
		return err
	}
	return nil
}

type metadata struct {
	identity                    Identity
	mode, uid, gid              uint32
	directory, owner, protected bool
}

func (m metadata) acceptsParent(kind ParentKind) bool {
	if !m.directory {
		return false
	}
	switch kind {
	case OwnedParent:
		return m.owner && m.protected
	case SharedApplicationsParent:
		// Exact update_helper.py require_shared_parent predicate. This role is
		// restricted to Farol.app by prepare; it never relaxes entry ownership.
		return m.uid == 0 && m.mode&0002 == 0 && (m.mode&0020 == 0 || m.gid == 80)
	default:
		return false
	}
}

type snapshot struct {
	parents     [2]metadata
	left, right metadata
	captured    bool
}
type backend interface {
	held(int) (metadata, error)
	named(int, string) (metadata, bool, error)
	pin(int, string) (int, error)
	close(int)
	move(int, string, int, string, bool) error
	sync(int) error
	classify(error, bool) (code string, known bool)
}

func (o *Operation) run(ctx context.Context, left, right int, attempted *bool) error {
	before := &snapshot{}
	if err := o.check(ctx, left, right, false, before); err != nil {
		return err
	}
	// Pins prevent removed originals being recycled into matching inode numbers.
	lpin, err := o.backend.pin(left, o.left.Name)
	if err != nil {
		return o.beforeIO(ctx, err, o.precondition())
	}
	defer o.backend.close(lpin)
	if err := o.checkPin(ctx, lpin, before.left); err != nil {
		return err
	}
	if o.exchange {
		rpin, err := o.backend.pin(right, o.right.Name)
		if err != nil {
			return o.beforeIO(ctx, err, o.precondition())
		}
		defer o.backend.close(rpin)
		if err := o.checkPin(ctx, rpin, before.right); err != nil {
			return err
		}
	}
	if err := canceled(ctx); err != nil {
		return err
	}
	if err := o.fence(ctx); err != nil {
		return err
	}
	if err := o.check(ctx, left, right, false, before); err != nil {
		return err
	}
	if err := canceled(ctx); err != nil {
		return err
	}
	*attempted = true
	err = o.backend.move(left, o.left.Name, right, o.right.Name, o.exchange)
	if c := canceled(ctx); c != nil {
		_, known := o.backend.classify(err, o.exchange)
		return o.uncertain(err != nil && !known, c)
	}
	if err != nil {
		if code, known := o.backend.classify(err, o.exchange); known {
			return &Failure{Code: code}
		}
		return o.uncertain(true, nil)
	}
	if err := o.check(ctx, left, right, true, before); err != nil {
		return err
	}
	// Both parents are synced, even when they are the same directory.
	for _, fd := range []int{left, right} {
		if err := canceled(ctx); err != nil {
			return o.uncertain(false, err)
		}
		err := o.backend.sync(fd)
		if c := canceled(ctx); c != nil {
			return o.uncertain(err != nil, c)
		}
		if err != nil {
			return o.uncertain(true, nil)
		}
	}
	// Read back again after durability I/O, before declaring success.
	return o.check(ctx, left, right, true, before)
}
func (o *Operation) beforeIO(ctx context.Context, err error, code string) error {
	if err != nil && !errors.Is(err, errEntryChanged) {
		return &Failure{Code: code, Internal: true, cause: canceled(ctx)}
	}
	if c := canceled(ctx); c != nil {
		return c
	}
	if err != nil {
		return &Failure{Code: code}
	}
	return nil
}
func (o *Operation) checkPin(ctx context.Context, fd int, expected metadata) error {
	if err := canceled(ctx); err != nil {
		return err
	}
	m, err := o.backend.held(fd)
	if err != nil {
		return o.beforeIO(ctx, err, o.precondition())
	}
	if err := canceled(ctx); err != nil {
		return err
	}
	if !m.directory || !m.owner || m != expected {
		return &Failure{Code: o.precondition()}
	}
	return nil
}
func (o *Operation) check(ctx context.Context, left, right int, after bool, before *snapshot) error {
	fail := func(code string, internal bool, cause error) error {
		if after {
			return o.uncertain(internal, cause)
		}
		if cause != nil && !internal {
			return cause
		}
		return &Failure{Code: code, Internal: internal, cause: cause}
	}
	if err := canceled(ctx); err != nil {
		return fail("", false, err)
	}
	var parents [2]metadata
	for i, p := range []struct {
		fd       int
		expected Identity
		kind     ParentKind
	}{{left, o.left.Parent.Identity, o.left.Parent.Kind}, {right, o.right.Parent.Identity, o.right.Parent.Kind}} {
		m, err := o.backend.held(p.fd)
		if c := canceled(ctx); c != nil {
			return fail("parent_replaced", err != nil, c)
		}
		if err != nil {
			return fail("parent_replaced", true, nil)
		}
		if !m.acceptsParent(p.kind) || m.identity != p.expected {
			return fail("parent_replaced", false, nil)
		}
		if o.capturePublication && (p.kind != OwnedParent || m.mode&0o7077 != 0) {
			return fail("parent_replaced", false, nil)
		}
		if before.captured && m != before.parents[i] {
			return fail("parent_replaced", false, nil)
		}
		parents[i] = m
	}
	if o.left.Parent.Identity.Device != o.right.Parent.Identity.Device {
		return fail(unsupported(o.exchange), false, nil)
	}
	le, lp, err := o.backend.named(left, o.left.Name)
	if c := canceled(ctx); c != nil {
		return fail(o.precondition(), err != nil, c)
	}
	if err != nil {
		return fail(o.precondition(), true, nil)
	}
	re, rp, err := o.backend.named(right, o.right.Name)
	if c := canceled(ctx); c != nil {
		return fail(o.precondition(), err != nil, c)
	}
	if err != nil {
		return fail(o.precondition(), true, nil)
	}
	match := func(m metadata, present bool, i Identity) bool {
		return present && m.directory && m.owner && m.identity == i && i.Device == o.left.Parent.Identity.Device
	}
	if after {
		if o.exchange {
			if !match(le, lp, o.rightExpected) || !match(re, rp, o.leftExpected) || le != before.right || re != before.left {
				return fail("", false, nil)
			}
		} else if lp || !match(re, rp, o.leftExpected) || re != before.left {
			return fail("", false, nil)
		}
		return nil
	}
	if !match(le, lp, o.leftExpected) {
		return fail(o.precondition(), false, nil)
	}
	if o.exchange {
		if !match(re, rp, o.rightExpected) {
			return fail(o.precondition(), false, nil)
		}
	} else if rp {
		return fail("destination_exists", false, nil)
	}
	if before.captured && (le != before.left || o.exchange && re != before.right) {
		return fail(o.precondition(), false, nil)
	}
	if !before.captured {
		*before = snapshot{parents: parents, left: le, right: re, captured: true}
	}
	return nil
}

// Check the absolute deadline as well as the cancellation signal. A timer's
// delivery can lag its deadline, including during synchronous filesystem I/O.
func canceled(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}
