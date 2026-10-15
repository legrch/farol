// Package handoff observes inherited Release lease and closed-predecessor
// custody. It does not admit, launch, mutate, or select an updater route.
//
// Successful observations are not durable authority or readiness. The caller
// must retain the parent's authoritative exclusive lock and reverify at each
// effect boundary. Namespace/process changes remain possible between checks.
package handoff

import (
	"context"
	"os"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"
)

// Code is a stable classified refusal. It never includes paths or file content.
type Code string

func (c Code) Error() string { return string(c) }

const (
	ErrInput            Code = "input"
	ErrDependency       Code = "dependency_missing"
	ErrCanceled         Code = "context_cancelled"
	ErrDescriptor       Code = "descriptor_unavailable"
	ErrHomeType         Code = "home_type"
	ErrHomeReplaced     Code = "home_replaced"
	ErrHomeOwner        Code = "home_owner"
	ErrPathType         Code = "path_type"
	ErrPathReplaced     Code = "path_replaced"
	ErrStateChanged     Code = "closed_state_changed"
	ErrLeaseIdentity    Code = "inherited_lease_identity"
	ErrLeaseAccess      Code = "inherited_lease_access"
	ErrLeaseProbe       Code = "inherited_lease_probe"
	ErrLeaseUnheld      Code = "inherited_lease_unheld"
	ErrLeaseCrossed     Code = "inherited_lease_crossed"
	ErrProcessRunning   Code = "closed_process_running"
	ErrProcessUnknown   Code = "closed_process_unknown"
	ErrRunningMarker    Code = "run_marker_present"
	ErrQuitChanged      Code = "closed_quit_changed"
	ErrQuitDigest       Code = "closed_quit_digest"
	ErrQuitNotConfirmed Code = "quit_not_confirmed"
	ErrQuitInvalid      Code = "quit_invalid"
	ErrQuitStale        Code = "quit_stale"
	ErrClock            Code = "clock_invalid"
)

// Identity preserves canonical decimal device/inode values without a float or
// platform-width conversion. Each component is 1..30 ASCII digits, without a
// leading zero except for zero itself.
type Identity struct{ Device, Inode string }

// Expected is the already-correlated predecessor binding from the caller.
// StartedAt uses the RFC3339Nano subset documented by New.
type Expected struct {
	StateIdentity, LeaseIdentity            Identity
	PID                                     int
	ProcessStart, StartedAt, LastQuitSHA256 string
}

type ProcessState uint8

const (
	ProcessUnknown ProcessState = iota
	ProcessAbsent
	ProcessPresent
)

// ProcessObserver must explicitly establish absence of PID, including checking
// for reuse. Every present PID refuses, even when its birth differs from
// processStart. Errors and unknown observations must never become absence.
// Implementations must honor ctx; this package launches no process and retries
// no observation.
type ProcessObserver interface {
	Observe(ctx context.Context, pid int, processStart string) (ProcessState, error)
}

// Verifier borrows all three files. It never closes, unlocks, seeks, changes
// flags/deadlines/inheritability, or assumes ownership of those descriptions.
// Callers must keep them open and prevent concurrent close/rebind, flag/lock
// changes, including through duplicates. No caller lifetime or authority lock
// is acquired. Calls on one Verifier serialize with cancelable waiting;
// independent instances require the same caller custody discipline.
type Verifier struct {
	homePath           string
	home, state, lease *os.File
	expected           Expected
	process            ProcessObserver
	now                func() time.Time
	gate               chan struct{}
	// Only package tests replace this to reopen disposable fixture routes when
	// the Cloud host's physical ancestors fail production ownership checks.
	reopen func(context.Context, string) (int, int, error)
}

// New validates dependencies and binding syntax, without acquiring authority.
// Timestamps accept RFC3339Nano with an explicit Z or numeric timezone, dot
// fractional seconds (at most nine digits), seconds 00..59, and years 0001..9999.
// This deliberately bounded producer subset excludes Python's wider ISO parser.
func New(homePath string, home, state, lease *os.File, expected Expected, process ProcessObserver, now func() time.Time) (*Verifier, error) {
	if home == nil || state == nil || lease == nil || nilObserver(process) || now == nil {
		return nil, ErrDependency
	}
	if !validHome(homePath) || !validIdentity(expected.StateIdentity) || !validIdentity(expected.LeaseIdentity) || expected.PID <= 1 ||
		!validText(expected.ProcessStart, 128) || !validDigest(expected.LastQuitSHA256) {
		return nil, ErrInput
	}
	if _, ok := timestamp(expected.StartedAt); !ok {
		return nil, ErrInput
	}
	return &Verifier{homePath: homePath, home: home, state: state, lease: lease, expected: expected, process: process, now: now, gate: make(chan struct{}, 1), reopen: openRoute}, nil
}

func nilObserver(p ProcessObserver) bool {
	if p == nil {
		return true
	}
	v := reflect.ValueOf(p)
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return v.IsNil()
	}
	return false
}

func validText(s string, limit int) bool {
	if len(s) < 1 || len(s) > limit || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validHome(path string) bool {
	if len(path) < 2 || path[0] != '/' || strings.IndexByte(path, 0) >= 0 || !utf8.ValidString(path) {
		return false
	}
	for _, p := range strings.Split(path[1:], "/") {
		if p == "" || p == "." || p == ".." || len(p) > 255 {
			return false
		}
	}
	return true
}

func decimal(s string) bool {
	if len(s) < 1 || len(s) > 30 || len(s) > 1 && s[0] == '0' {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func validIdentity(i Identity) bool { return decimal(i.Device) && decimal(i.Inode) }
func validDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func canceled(ctx context.Context) error {
	if ctx == nil {
		return ErrDependency
	}
	if ctx.Err() != nil {
		return ErrCanceled
	}
	return nil
}

func (v *Verifier) run(ctx context.Context, fn func(int, int, int) error) error {
	if err := canceled(ctx); err != nil {
		return err
	}
	if v == nil || v.gate == nil {
		return ErrDependency
	}
	select {
	case v.gate <- struct{}{}:
	case <-ctx.Done():
		return ErrCanceled
	}
	defer func() { <-v.gate }()
	if err := canceled(ctx); err != nil {
		return err
	}
	files := []*os.File{v.home, v.state, v.lease}
	var fds [3]int
	var hold func(int) error
	hold = func(n int) error {
		if err := canceled(ctx); err != nil {
			return err
		}
		if n == len(files) {
			return fn(fds[0], fds[1], fds[2])
		}
		raw, err := files[n].SyscallConn()
		if err != nil {
			return ErrDescriptor
		}
		var result error
		err = raw.Control(func(fd uintptr) { fds[n] = int(fd); result = hold(n + 1) })
		if err != nil {
			return ErrDescriptor
		}
		return result
	}
	return hold(0)
}

// VerifyInherited checks canonical route, bound inode custody, and the already
// inherited exclusive description. It never obtains a fresh authoritative lease.
func (v *Verifier) VerifyInherited(ctx context.Context) error {
	return v.run(ctx, func(home, state, lease int) error { return v.verifyInherited(ctx, home, state, lease) })
}

// VerifyClosed rechecks inherited custody before observing process absence and
// the bound quit receipt. Neither method's success is cached or durable.
func (v *Verifier) VerifyClosed(ctx context.Context) error {
	return v.run(ctx, func(home, state, lease int) error {
		if err := v.verifyInherited(ctx, home, state, lease); err != nil {
			return err
		}
		return v.verifyClosed(ctx, state)
	})
}
