//go:build linux || darwin

// Package helperlocks provides unselected counterparts of the helper's fixed
// update lock and fresh promotion lease. It grants no install authority and does
// not replace handoff's verification of an inherited, transferred lease.
//
// Callers retain the borrowed parent, its actual named route, all other owners,
// and admission through Close. Native calls and callbacks run synchronously;
// deadlines do not prove that a blocked call returned or cleanup completed.
package helperlocks

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"time"
)

// Identity contains canonical unsigned 64-bit decimal device/inode values.
type Identity struct{ Device, Inode string }
type Directory struct {
	File     *os.File
	Identity Identity
}

// Failure has closed outer text and preserves exact underlying causes. Internal
// distinguishes native/opaque failures from inspected refusals. Uncertain means
// a private create effect, its persistence, or owned-description cleanup may be
// unknown. It must not be interpreted as authorization to retry or remove a file.
type Failure struct {
	Code                string
	Internal, Uncertain bool
	cause               error
}

func (f *Failure) Error() string {
	if f == nil || !closedCode(f.Code) {
		return "lock_io"
	}
	return f.Code
}
func (f *Failure) Unwrap() error {
	if f == nil {
		return nil
	}
	return f.cause
}

func closedCode(s string) bool {
	switch s {
	case "lock_input", "lock_io", "lock_cleanup", "lock_callback", "lock_closed", "lock_canceled", "lock_deadline",
		"lock_parent_type", "lock_parent_changed", "lock_type", "lock_replaced", "lock_lost", "update_busy",
		"owner_lease_type", "owner_lease_replaced", "owner_lease_lost", "owner_lease_held":
		return true
	}
	return false
}
func refusal(code string) error { return &Failure{Code: code} }
func native(err error) error {
	if err == nil {
		return nil
	}
	return &Failure{Code: "lock_io", Internal: true, cause: err}
}

// classify accepts only exact context sentinels and well-formed direct Failure
// values. Matching an opaque wrapper/join against cancellation cannot downgrade
// an unknown callback or infrastructure failure.
func classify(err error) (string, bool, bool) {
	if err == context.Canceled {
		return "lock_canceled", false, false
	}
	if err == context.DeadlineExceeded {
		return "lock_deadline", false, false
	}
	if f, ok := err.(*Failure); ok && f != nil && closedCode(f.Code) {
		if (f.Code == "lock_io" || f.Code == "lock_cleanup" || f.Code == "lock_callback") && !f.Internal {
			return "lock_io", true, f.Uncertain
		}
		if f.Code == "lock_cleanup" && !f.Uncertain {
			return "lock_io", true, true
		}
		return f.Code, f.Internal, f.Uncertain
	}
	return "lock_io", true, false
}
func combine(all ...error) error {
	var causes []error
	code, internal, uncertain := "", false, false
	for _, err := range all {
		if err == nil {
			continue
		}
		c, i, u := classify(err)
		if code == "" || i && !internal {
			code = c
		}
		internal, uncertain = internal || i, uncertain || u
		causes = append(causes, err)
	}
	if len(causes) == 0 {
		return nil
	}
	return &Failure{Code: code, Internal: internal, Uncertain: uncertain, cause: errors.Join(causes...)}
}
func canonical(s string) bool {
	if len(s) == 0 || len(s) > 20 {
		return false
	}
	n, e := strconv.ParseUint(s, 10, 64)
	return e == nil && strconv.FormatUint(n, 10) == s
}
func valid(d Directory) bool {
	return d.File != nil && canonical(d.Identity.Device) && canonical(d.Identity.Inode)
}
func bound(ctx context.Context, until time.Time) time.Time {
	if d, ok := ctx.Deadline(); ok && d.Before(until) {
		return d
	}
	return until
}

// Lease copies share one owner, operation gate and exactly-once Close. The zero
// value is invalid. Close releases only this lease's owned open description.
type Lease struct{ owner *owner }
type owner struct {
	parent             Directory
	file               *os.File
	parentPin, filePin fingerprint
	promotion          bool
	until              time.Time
	hooks              hooks
	gate               chan struct{}
	mu                 sync.Mutex
	closing            bool
	once               sync.Once
	closeErr           error
}

// AcquireUpdate opens only "lock". Missing entries use exclusive creation and
// sync the borrowed update directory before attempting the nonblocking flock.
func AcquireUpdate(ctx context.Context, update Directory, originalUntil time.Time) (*Lease, error) {
	return acquire(ctx, update, originalUntil, false, hooks{})
}

// AcquirePromotion opens only the already-existing "promotion.lease". This is
// for the legacy flow after its original process is positively verified quit;
// never use it to repair or replace an inherited lease proof.
func AcquirePromotion(ctx context.Context, state Directory, originalUntil time.Time) (*Lease, error) {
	return acquire(ctx, state, originalUntil, true, hooks{})
}

type runner struct {
	ctx      context.Context
	until    time.Time
	o        *owner
	effected bool
}

func (r *runner) check() error {
	var c error
	if e := r.ctx.Err(); e != nil {
		c = combine(e)
	}
	if !time.Now().Before(r.until) {
		c = combine(c, context.DeadlineExceeded)
	}
	return c
}
func (r *runner) result(err error) error {
	err = combine(err, r.check())
	if err != nil && r.effected {
		c, i, _ := classify(err)
		return &Failure{Code: c, Internal: i, Uncertain: true, cause: err}
	}
	return err
}
func (o *owner) name() string {
	if o.promotion {
		return "promotion.lease"
	}
	return "lock"
}
func (o *owner) code(update, promotion string) string {
	if o.promotion {
		return promotion
	}
	return update
}

func (l *Lease) run(ctx context.Context, fn func(*runner) error) error {
	if l == nil || l.owner == nil || ctx == nil {
		return refusal("lock_input")
	}
	o := l.owner
	r := &runner{ctx: ctx, until: bound(ctx, o.until), o: o}
	if e := r.check(); e != nil {
		return e
	}
	// A separate absolute timer bounds gate waiting even when ctx.Done/Err lag.
	timer := time.NewTimer(time.Until(r.until))
	defer timer.Stop()
	select {
	case o.gate <- struct{}{}:
	case <-ctx.Done():
		if e := r.check(); e != nil {
			return e
		}
		return combine(context.Canceled)
	case <-timer.C:
		return combine(r.check(), context.DeadlineExceeded)
	}
	defer func() { <-o.gate }()
	o.mu.Lock()
	closing := o.closing
	o.mu.Unlock()
	if closing {
		return combine(refusal("lock_closed"), r.check())
	}
	if e := r.check(); e != nil {
		return e
	}
	return r.result(fn(r))
}

// Verify checks the current borrowed parent and the full held/named pinned
// identity, mode, UID, GID and link count. It neither probes another lock nor
// changes any lock, flags, offset, deadline or inheritability.
func (l *Lease) Verify(ctx context.Context) error {
	return l.run(ctx, func(r *runner) error { return r.verify() })
}

// WithFile synchronously lends the same authoritative owned File, with pre/post
// verification. The callback must not close, reconfigure, retain or reenter the
// lease/File, including through duplicates. Its errors remain behind closed text.
func (l *Lease) WithFile(ctx context.Context, fn func(*os.File, Identity) error) error {
	if fn == nil {
		return refusal("lock_input")
	}
	return l.run(ctx, func(r *runner) error {
		if e := r.verify(); e != nil {
			return e
		}
		if e := r.check(); e != nil {
			return e
		}
		e := fn(r.o.file, r.o.filePin.identity())
		var callback error
		if e != nil {
			c, i, u := classify(e)
			if i {
				c = "lock_callback"
			}
			callback = &Failure{Code: c, Internal: i, Uncertain: u, cause: e}
		}
		// Verify even after a callback failure or cancellation; all checks remain
		// synchronous. Cancellation does not let an active callback escape custody.
		return combine(callback, r.check(), r.verify())
	})
}

// Close has no cancelable wait: it must retain ownership until active native
// operations/callbacks actually return. Concurrent copies receive the same
// retained close outcome. Release is exclusively via owned File.Close, never UN.
// Confirmed cleanup does not erase a prior failed or uncertain acquire/callback
// outcome, prove private-effect persistence, or grant operation acceptance.
func (l *Lease) Close() error {
	if l == nil || l.owner == nil {
		return refusal("lock_input")
	}
	o := l.owner
	o.once.Do(func() {
		o.mu.Lock()
		o.closing = true
		o.mu.Unlock()
		o.gate <- struct{}{}
		defer func() { <-o.gate }()
		if e := o.closeFile(); e != nil {
			o.closeErr = &Failure{Code: "lock_cleanup", Internal: true, Uncertain: true, cause: e}
		}
	})
	return o.closeErr
}
