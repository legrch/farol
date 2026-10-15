// Package helperroutes holds existing physical updater directories. It performs
// no mutation, lease acquisition, resource selection, or admission. Successful
// verification is an observation; callers retain all effect authority and must
// reverify at their own effect boundaries.
package helperroutes

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Code is a closed, path-free failure classification.
type Code string

const (
	CodeInvalid    Code = "invalid"
	CodeDependency Code = "dependency"
	CodeContext    Code = "context"
	CodeClosed     Code = "closed"
	CodeMissing    Code = "missing"
	CodeType       Code = "type"
	CodeOwner      Code = "owner"
	CodeMode       Code = "mode"
	CodeChanged    Code = "changed"
	CodeNative     Code = "native"
	CodeCallback   Code = "callback"
	CodeCleanup    Code = "cleanup"
	CodeBorrow     Code = "borrow_scope"
)

// Error retains exact causes without including native messages or paths in its
// own message. Internal distinguishes unexpected dependency/native failures
// from inspected refusals. Inspect causes with errors.Is/errors.As.
type Error struct {
	Code     Code
	Internal bool
	cause    error
}

func (e *Error) Error() string {
	code := CodeNative
	if e != nil {
		switch e.Code {
		case CodeInvalid, CodeDependency, CodeContext, CodeClosed, CodeMissing, CodeType, CodeOwner, CodeMode, CodeChanged, CodeNative, CodeCallback, CodeCleanup, CodeBorrow:
			code = e.Code
		}
	}
	return "helper routes: " + string(code)
}
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}
func failure(code Code, internal bool, cause error) error {
	return &Error{Code: code, Internal: internal, cause: cause}
}
func internal(err error) bool {
	if err == nil || err == context.Canceled || err == context.DeadlineExceeded {
		return false
	}
	if e, ok := err.(*Error); ok {
		return e.Internal
	}
	// An opaque wrapper/join that happens to match a context sentinel is still
	// an unknown dependency error. errors.Is alone cannot downgrade it.
	return true
}
func combine(primary, secondary error) error {
	if primary == nil {
		return secondary
	}
	if secondary == nil {
		return primary
	}
	code := CodeNative
	if e, ok := primary.(*Error); ok {
		code = e.Code
	}
	return failure(code, internal(primary) || internal(secondary), errors.Join(primary, secondary))
}
func contextFailure(ctx context.Context) error {
	// Timer delivery (and a custom context's Err/Done) can lag the absolute
	// deadline. Native observations must enforce that bound independently.
	now := time.Now()
	cause := ctx.Err()
	if until, ok := ctx.Deadline(); ok && !now.Before(until) && cause != context.DeadlineExceeded {
		cause = errors.Join(cause, context.DeadlineExceeded)
	}
	if cause != nil {
		return failure(CodeContext, false, cause)
	}
	return nil
}
func dependencyFailure(ctx context.Context) error {
	err := failure(CodeDependency, true, nil)
	if ctx != nil {
		err = combine(err, contextFailure(ctx))
	}
	return err
}

// Identity uses exact canonical decimal values, without float conversion.
type Identity struct{ Device, Inode string }

// Files are BORROWED only for the synchronous WithFiles callback. The caller
// must not close, reconfigure, retain, or use them after that callback, including
// through duplicates or background work. SharedParent identifies the strict
// /Applications role; it never relaxes the home/state/staging ownership rules.
type Files struct {
	Home, Applications, Update, Operation, State     *os.File
	HomeIdentity, ApplicationsIdentity               Identity
	UpdateIdentity, OperationIdentity, StateIdentity Identity
	SharedParent                                     bool
	scope                                            *borrowScope
}

type borrowScope struct {
	mu     sync.Mutex
	active bool
	owner  *owner
	ctx    context.Context
	until  time.Time
}

// borrowContext observes cancellation of the original synchronous borrow even
// when its caller supplies a fresh context to Reverify. The fixed borrow bound
// is independently enforced through Deadline by every native check.
type borrowContext struct {
	context.Context
	original context.Context
}

func (c borrowContext) Err() error {
	if err := c.original.Err(); err != nil {
		return err
	}
	return c.Context.Err()
}

// Reverify synchronously rechecks the active borrow's pinned routes without
// reacquiring Routes' gate. An effect fence may call this inside WithFiles.
// It grants no authority. Callers must not invoke it concurrently or from
// asynchronous work. After callback return it refuses before any I/O.
func (f Files) Reverify(ctx context.Context) error {
	if ctx == nil || f.scope == nil {
		return dependencyFailure(ctx)
	}
	s := f.scope
	if !s.mu.TryLock() {
		return combine(failure(CodeBorrow, false, nil), contextFailure(ctx))
	}
	defer s.mu.Unlock()
	if !s.active {
		return combine(failure(CodeBorrow, false, nil), contextFailure(ctx))
	}
	ctx, cancel := context.WithDeadline(ctx, s.until)
	defer cancel()
	effective := borrowContext{Context: ctx, original: s.ctx}
	if err := contextFailure(effective); err != nil {
		return err
	}
	return combine(s.owner.verify(effective), contextFailure(effective))
}

func (s *borrowScope) end() {
	// Keep the outer gate and original file references until an actual scoped
	// native return, even if a caller violates the synchronous-only contract.
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = false
}

// Routes copies share one owner and close gate. The zero value is unavailable.
// Verify, WithFiles and Close serialize through actual callback/native return.
// A callback must not reenter these methods on the same owner.
type Routes struct{ owner *owner }

type owner struct {
	gate                                 chan struct{}
	until                                time.Time
	nodes                                []node
	home, apps, update, operation, state int
	shared                               bool
	closed                               bool
	closeErr                             error
	fs                                   filesystem
}

func validHome(path string) bool {
	if len(path) < 2 || path[0] != '/' || !utf8.ValidString(path) || strings.IndexByte(path, 0) >= 0 {
		return false
	}
	for _, part := range strings.Split(path[1:], "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
	}
	return true
}
func validOperation(op string) bool {
	if len(op) != 32 {
		return false
	}
	for _, c := range op {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// OpenExisting opens only existing routes. The earlier of originalUntil and the
// opening context deadline is captured once, with no extension by later contexts.
// location must be exactly legacy/shared;
// omitted-location normalization belongs to the trusted caller.
func OpenExisting(ctx context.Context, homePath, operationID, location string, originalUntil time.Time) (*Routes, error) {
	return openExisting(ctx, homePath, operationID, location, originalUntil, nativeFilesystem())
}

func openExisting(ctx context.Context, homePath, operationID, location string, originalUntil time.Time, fs filesystem) (*Routes, error) {
	if ctx == nil {
		return nil, dependencyFailure(ctx)
	}
	if !validHome(homePath) || !validOperation(operationID) || location != "legacy" && location != "shared" || originalUntil.IsZero() {
		return nil, combine(failure(CodeInvalid, false, nil), contextFailure(ctx))
	}
	ctx, cancel := context.WithDeadline(ctx, originalUntil)
	defer cancel()
	if err := contextFailure(ctx); err != nil {
		return nil, err
	}
	bound, _ := ctx.Deadline() // WithDeadline always supplies the captured bound.
	o := &owner{gate: make(chan struct{}, 1), until: bound, fs: fs, shared: location == "shared"}
	if err := o.open(ctx, homePath, operationID); err != nil {
		return nil, combine(combine(err, o.cleanup()), contextFailure(ctx))
	}
	if err := o.verify(ctx); err != nil {
		return nil, combine(combine(err, o.cleanup()), contextFailure(ctx))
	}
	if err := contextFailure(ctx); err != nil {
		return nil, combine(combine(err, o.cleanup()), contextFailure(ctx))
	}
	return &Routes{owner: o}, nil
}

func (r *Routes) run(ctx context.Context, fn func(context.Context, *owner) error) error {
	if ctx == nil || r == nil || r.owner == nil {
		return dependencyFailure(ctx)
	}
	o := r.owner
	ctx, cancel := context.WithDeadline(ctx, o.until)
	defer cancel()
	if err := contextFailure(ctx); err != nil {
		return err
	}
	// WithDeadline may inherit an earlier parent deadline without creating its
	// own timer. Bound gate waiting even if that parent's Done delivery lags.
	bound, _ := ctx.Deadline()
	timer := time.NewTimer(time.Until(bound))
	defer timer.Stop()
	select {
	case o.gate <- struct{}{}:
	case <-ctx.Done():
		return contextFailure(ctx)
	case <-timer.C:
		return combine(failure(CodeContext, false, context.DeadlineExceeded), contextFailure(ctx))
	}
	defer func() { <-o.gate }()
	if o.closed {
		return combine(failure(CodeClosed, false, nil), contextFailure(ctx))
	}
	if err := contextFailure(ctx); err != nil {
		return err
	}
	// Control retains every Go file reference until the synchronous operation
	// actually returns, even if cancellation arrives while native code blocks.
	result := o.hold(0, func() error { return fn(ctx, o) })
	return combine(result, contextFailure(ctx))
}

// Verify compares all originally held components with a fresh canonical walk.
// Changes to ordinary contents, directory size, timestamps or link count do not
// change directory identity. Tighter state/lease checks belong to their owner.
func (r *Routes) Verify(ctx context.Context) error {
	return r.run(ctx, func(ctx context.Context, o *owner) error { return o.verify(ctx) })
}

// WithFiles verifies before borrowing and again after callback return. A final
// observation never authorizes past/future effects or erases a callback cause.
// Cancellation does not permit closing handles while the callback still runs.
func (r *Routes) WithFiles(ctx context.Context, fn func(Files) error) error {
	if fn == nil {
		return dependencyFailure(ctx)
	}
	return r.run(ctx, func(ctx context.Context, o *owner) error {
		if err := o.verify(ctx); err != nil {
			return err
		}
		if err := contextFailure(ctx); err != nil {
			return err
		}
		bound, _ := ctx.Deadline()
		scope := &borrowScope{active: true, owner: o, ctx: ctx, until: bound}
		files := o.files()
		files.scope = scope
		err := func() error {
			defer scope.end()
			return fn(files)
		}()
		if err != nil {
			err = failure(CodeCallback, internal(err), err)
		}
		return combine(err, o.verify(ctx))
	})
}

// Close waits without abandoning an outstanding operation, closes each owned
// file exactly once, and returns the same collected cleanup outcome on copies.
func (r *Routes) Close() error {
	if r == nil || r.owner == nil {
		return failure(CodeDependency, true, nil)
	}
	o := r.owner
	o.gate <- struct{}{}
	defer func() { <-o.gate }()
	if !o.closed {
		o.closed = true
		o.closeErr = o.cleanup()
	}
	return o.closeErr
}

func (o *owner) hold(i int, fn func() error) error {
	if i == len(o.nodes) {
		return fn()
	}
	raw, err := o.nodes[i].file.SyscallConn()
	if err != nil {
		return failure(CodeNative, true, err)
	}
	var result error
	err = raw.Control(func(uintptr) { result = o.hold(i+1, fn) })
	if err != nil {
		result = combine(result, failure(CodeNative, true, err))
	}
	return result
}

func (o *owner) files() Files {
	return Files{
		Home: o.nodes[o.home].file, Applications: o.nodes[o.apps].file,
		Update: o.nodes[o.update].file, Operation: o.nodes[o.operation].file, State: o.nodes[o.state].file,
		HomeIdentity: o.nodes[o.home].pin.identity(), ApplicationsIdentity: o.nodes[o.apps].pin.identity(),
		UpdateIdentity: o.nodes[o.update].pin.identity(), OperationIdentity: o.nodes[o.operation].pin.identity(), StateIdentity: o.nodes[o.state].pin.identity(),
		SharedParent: o.shared,
	}
}

func (o *owner) cleanup() error {
	var result error
	for i := len(o.nodes) - 1; i >= 0; i-- {
		if err := o.fs.close(o.nodes[i].file); err != nil {
			result = combine(result, failure(CodeCleanup, true, err))
		}
	}
	return result
}
