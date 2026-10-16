// Package apptree observes a bounded, physical application tree. An observation
// grants no permission to install or execute it. The caller retains route and
// lease custody and must prevent borrowed descriptors from being closed or
// changed through aliases throughout New and Verify.
package apptree

import (
	"context"
	"errors"
	"os"
	"time"
	"unicode/utf8"
)

// Code is a stable refusal classification. Errors never disclose paths or bytes.
type Code string

const (
	CodeInput    Code = "input"
	CodeCanceled Code = "canceled"
	CodeIO       Code = "io"
	CodeChanged  Code = "changed"
	CodeType     Code = "type"
	CodeName     Code = "name"
	CodeLimit    Code = "limit"
	CodeLink     Code = "link"
	CodeDigest   Code = "digest"
	CodeIdentity Code = "identity"
)

// Error is a classified native refusal without underlying host error disclosure.
type Error struct{ Code Code }

func (e *Error) Error() string { return "app tree: " + string(e.Code) }
func refuse(c Code) error      { return &Error{Code: c} }

// observationFailure keeps the safe outer refusal while retaining dependency
// provenance for trusted callers. Dependency text never enters Error().
type observationFailure struct {
	refusal             *Error
	cause, cancellation error
}

func (e *observationFailure) Error() string { return e.refusal.Error() }
func (e *observationFailure) Unwrap() []error {
	causes := []error{e.refusal, e.cause}
	if e.cancellation != nil {
		causes = append(causes, e.cancellation)
	}
	return causes
}

func canceled(ctx context.Context) error {
	if ctx == nil {
		return refuse(CodeInput)
	}
	cause := ctx.Err()
	if until, ok := ctx.Deadline(); ok && !time.Now().Before(until) {
		cause = errors.Join(cause, context.DeadlineExceeded)
	}
	if cause != nil {
		return &observationFailure{refusal: &Error{Code: CodeCanceled}, cause: cause}
	}
	return nil
}

type Expected struct{ TreeSHA256, Version, BuildID string }
type ObjectIdentity struct {
	Device, Inode  string
	Mode, UID, GID uint32
}
type Observation struct{ Root ObjectIdentity }

// IdentityVerifier receives the exact bounded documents and original context.
// Trusted composition must inject the identity policy; no default is provided.
type IdentityVerifier func(context.Context, []byte, []byte, string, string) error

type Verifier struct {
	parent, app *os.File
	leaf        string
	expected    Expected
	identity    IdentityVerifier
	cleanup     cleanup
}

func New(parent, app *os.File, leaf string, expected Expected, identity IdentityVerifier) (*Verifier, error) {
	if parent == nil || app == nil || identity == nil || !component(leaf) || !hex64(expected.TreeSHA256) || !hex64(expected.BuildID) || !utf8.ValidString(expected.Version) || utf8.RuneCountInString(expected.Version) == 0 || utf8.RuneCountInString(expected.Version) > 128 {
		return nil, refuse(CodeInput)
	}
	// Control rejects closed handles without taking ownership or calling Fd
	// (which can change descriptor flags). Do not retain raw descriptor numbers.
	pc, err := parent.SyscallConn()
	if err != nil {
		return nil, refuse(CodeInput)
	}
	ac, err := app.SyscallConn()
	if err != nil {
		return nil, refuse(CodeInput)
	}
	var inner error
	err = pc.Control(func(uintptr) { inner = ac.Control(func(uintptr) {}) })
	if err != nil || inner != nil {
		return nil, refuse(CodeInput)
	}
	return &Verifier{parent: parent, app: app, leaf: leaf, expected: expected, identity: identity}, nil
}
func component(s string) bool {
	if s == "" || s == "." || s == ".." || len(s) > 255 || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c == '/' || c == 0 {
			return false
		}
	}
	return true
}
func hex64(s string) bool {
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

// Verify borrows both handles inside nested Control calls. It only enumerates
// independently reopened descriptions; borrowed flags, offsets and locks stay
// untouched. This is a mutation-sensitive observation, not an atomic snapshot.
func (v *Verifier) Verify(ctx context.Context) (Observation, error) {
	if err := canceled(ctx); err != nil {
		return Observation{}, err
	}
	if v == nil || v.parent == nil || v.app == nil || v.identity == nil {
		return Observation{}, refuse(CodeInput)
	}
	pc, err := v.parent.SyscallConn()
	if err != nil {
		return Observation{}, refuse(CodeIO)
	}
	ac, err := v.app.SyscallConn()
	if err != nil {
		return Observation{}, refuse(CodeIO)
	}
	var result Observation
	var inner error
	err = pc.Control(func(p uintptr) {
		e := ac.Control(func(a uintptr) { result, inner = v.verify(ctx, int(p), int(a)) })
		if e != nil {
			inner = &observationFailure{refusal: &Error{Code: CodeIO}, cause: errors.Join(inner, e)}
		}
	})
	if err != nil {
		inner = &observationFailure{refusal: &Error{Code: CodeIO}, cause: errors.Join(inner, err)}
	}
	if inner != nil {
		return Observation{}, inner
	}
	return result, nil
}
