package handoff

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Failure retains native provenance behind a closed refusal code. Internal
// distinguishes failed observations from confirmed semantic refusals. Uncertain
// includes unconfirmed owned cleanup or uninspectable cause provenance. It
// makes no assertion that the descriptor is open or closed and permits no retry.
type Failure struct {
	Code                Code
	Internal, Uncertain bool
	cause               error
}

func (f *Failure) Error() string { return f.Code.Error() }
func (f *Failure) Unwrap() []error {
	if f.cause == nil {
		return []error{f.Code}
	}
	return []error{f.Code, f.cause}
}

const ErrCleanup Code = "descriptor_cleanup_unconfirmed"

func fail(code Code, internal, uncertain bool, causes ...error) error {
	pending := append([]error(nil), causes...)
	for remaining := 128; len(pending) > 0; remaining-- {
		if remaining == 0 {
			internal, uncertain = true, true
			break
		}
		cause := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if cause == nil {
			continue
		}
		if prior, ok := cause.(*Failure); ok {
			internal = internal || prior.Internal
			uncertain = uncertain || prior.Uncertain
		}
		switch e := cause.(type) {
		case interface{ Unwrap() []error }:
			children := e.Unwrap()
			if len(children) > remaining {
				internal, uncertain = true, true
				continue
			}
			pending = append(pending, children...)
		case interface{ Unwrap() error }:
			pending = append(pending, e.Unwrap())
		}
	}
	return &Failure{Code: code, Internal: internal, Uncertain: uncertain, cause: errors.Join(causes...)}
}

func contextCauses(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	var deadline error
	if at, ok := ctx.Deadline(); ok && !time.Now().Before(at) {
		deadline = context.DeadlineExceeded
	}
	return errors.Join(ctx.Err(), context.Cause(ctx), deadline)
}

func nativeFailure(ctx context.Context, code Code, causes ...error) error {
	cause := errors.Join(causes...)
	if c := canceled(ctx); c != nil {
		return fail(ErrCanceled, cause != nil, false, code, cause, c)
	}
	if cause != nil {
		return fail(code, true, false, cause)
	}
	return nil
}

func refusalCode(err error) Code {
	switch e := err.(type) {
	case Code:
		return e
	case *Failure:
		return e.Code
	default:
		return ErrDescriptor
	}
}

func finish(ctx context.Context, prior error) error {
	if c := canceled(ctx); c != nil {
		if prior == nil {
			return c
		}
		return fail(refusalCode(prior), false, false, prior, c)
	}
	return prior
}

// Consume the exact owned handle before Close, including on a failed receipt.
// No integer retry or descriptor-liveness inference is valid after this point.
func closeOwned(ctx context.Context, fd *int, result *error) {
	if *fd < 0 {
		return
	}
	closing := *fd
	*fd = -1
	if err := native(ctx).close(closing); err != nil {
		code := ErrCleanup
		if *result != nil {
			code = refusalCode(*result)
		}
		*result = fail(code, true, true, *result, ErrCleanup, err, canceled(ctx))
	} else {
		*result = finish(ctx, *result)
	}
}

// Only package tests can attach these per-call fault seams. Production uses
// the original syscalls, flags and synchronous retained RawConn lifetimes.
// No environment switch, exported setter or shared mutable owner is involved.
type nativeKey struct{}
type nativeCalls struct {
	stat   func(int, *unix.Stat_t) error
	named  func(int, string, *unix.Stat_t, int) error
	open   func(string, int, uint32) (int, error)
	openat func(int, string, int, uint32) (int, error)
	flags  func(uintptr, int, int) (int, error)
	flock  func(int, int) error
	read   func(int, []byte) (int, error)
	close  func(int) error
	conn   func(*os.File) (syscall.RawConn, error)
}

func native(ctx context.Context) nativeCalls {
	var n nativeCalls
	if ctx != nil {
		n, _ = ctx.Value(nativeKey{}).(nativeCalls)
	}
	if n.stat == nil {
		n.stat = unix.Fstat
	}
	if n.named == nil {
		n.named = unix.Fstatat
	}
	if n.open == nil {
		n.open = unix.Open
	}
	if n.openat == nil {
		n.openat = unix.Openat
	}
	if n.flags == nil {
		n.flags = unix.FcntlInt
	}
	if n.flock == nil {
		n.flock = unix.Flock
	}
	if n.read == nil {
		n.read = unix.Read
	}
	if n.close == nil {
		n.close = unix.Close
	}
	if n.conn == nil {
		n.conn = (*os.File).SyscallConn
	}
	return n
}
