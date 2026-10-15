package slotbinding

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

type Identity struct{ Device, Inode string }

// VerificationFailure separates positively inspected refusals from unexpected
// native errors. Its exact private causes remain available without exposing
// paths or record bytes in the outer message. Verification never grants effects.
type VerificationFailure struct {
	Code     string
	Internal bool
	cause    error
}

func (e *VerificationFailure) Error() string {
	if e != nil {
		switch e.Code {
		case "slot_binding_invalid", "slot_binding_directory", "slot_binding_missing", "slot_binding_type", "slot_binding_changed", "slot_binding_mismatch", "slot_binding_canceled", "slot_binding_deadline", "slot_binding_internal":
			return e.Code
		}
	}
	return "slot_binding_internal"
}
func (e *VerificationFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}
func verificationFailure(code string, internal bool, cause error) error {
	return &VerificationFailure{Code: code, Internal: internal, cause: cause}
}
func verificationJoin(first, second error) error {
	if first == nil {
		return second
	}
	if second == nil {
		return first
	}
	code, internal := "slot_binding_internal", false
	for _, err := range []error{first, second} {
		f, ok := err.(*VerificationFailure)
		if !ok || f == nil || f.Error() != f.Code {
			internal = true
			continue
		}
		if code == "slot_binding_internal" || f.Internal {
			code = f.Code
		}
		internal = internal || f.Internal
	}
	return verificationFailure(code, internal, errors.Join(first, second))
}

// Verifier borrows one exact operation directory. The caller holds the original
// named route, lease, slot and admission through actual synchronous return. It
// never closes, seeks, unlocks or reconfigures that borrowed description. Repeat
// observations are not authority, readiness, persistence or a replay permit.
type Verifier struct {
	directory *os.File
	identity  Identity
	expected  []byte
	until     time.Time
	// Deterministic private test seams; production uses fixed native operations.
	step      func(string)
	read      func(int, []byte) (int, error)
	closeFile func(*os.File) error
}

func NewVerifier(directory *os.File, identity Identity, expected []byte, until time.Time) (*Verifier, error) {
	decimal := func(s string) bool {
		n, err := strconv.ParseUint(s, 10, 64)
		return err == nil && strconv.FormatUint(n, 10) == s
	}
	if directory == nil || until.IsZero() || len(expected) < 1 || len(expected) > maxRecord || !decimal(identity.Device) || !decimal(identity.Inode) {
		return nil, verificationFailure("slot_binding_invalid", false, nil)
	}
	captured := append([]byte(nil), expected...)
	if !canonical(captured) {
		return nil, verificationFailure("slot_binding_invalid", false, nil)
	}
	return &Verifier{directory: directory, identity: identity, expected: captured, until: until}, nil
}

func (v *Verifier) bound(ctx context.Context) error {
	now := time.Now()
	cause := ctx.Err()
	deadline, hasDeadline := ctx.Deadline()
	if !now.Before(v.until) || hasDeadline && !now.Before(deadline) || cause == context.DeadlineExceeded {
		return verificationFailure("slot_binding_deadline", false, errors.Join(cause, context.DeadlineExceeded))
	}
	if cause != nil {
		return verificationFailure("slot_binding_canceled", false, cause)
	}
	return nil
}

func (v *Verifier) call(ctx context.Context, label, code string, fn func() error) error {
	if v.step != nil {
		v.step(label)
	}
	if err := v.bound(ctx); err != nil {
		return err
	}
	err := fn()
	if err != nil {
		err = verificationFailure(code, true, err)
	}
	return verificationJoin(err, v.bound(ctx))
}

func (v *Verifier) Verify(ctx context.Context) error {
	if ctx == nil || v == nil || v.directory == nil {
		return verificationFailure("slot_binding_internal", true, nil)
	}
	if err := v.bound(ctx); err != nil {
		return err
	}
	raw, err := v.directory.SyscallConn()
	if err != nil {
		return verificationJoin(verificationFailure("slot_binding_directory", true, err), v.bound(ctx))
	}
	var result error
	err = raw.Control(func(fd uintptr) { result = v.verify(ctx, int(fd)) })
	if err != nil {
		result = verificationJoin(result, verificationFailure("slot_binding_directory", true, err))
	}
	return verificationJoin(result, v.bound(ctx))
}

func (v *Verifier) verify(ctx context.Context, parent int) (result error) {
	var directory, before fingerprint
	if err := v.call(ctx, "parent", "slot_binding_directory", func() error { var e error; directory, e = statFD(parent); return e }); err != nil {
		return err
	}
	if !directory.privateDirectory() || strconv.FormatUint(directory.device, 10) != v.identity.Device || strconv.FormatUint(directory.inode, 10) != v.identity.Inode {
		return verificationFailure("slot_binding_directory", false, nil)
	}
	var missing bool
	if err := v.call(ctx, "entry", "slot_binding_type", func() error {
		var e error
		before, e = statAt(parent, filename)
		if e == unix.ENOENT {
			missing = true // Original entry() positively observes this absence.
			return nil
		}
		return e
	}); err != nil {
		return err
	}
	if missing {
		return verificationFailure("slot_binding_missing", false, nil)
	}
	if !before.privateFile() {
		return verificationFailure("slot_binding_type", false, nil)
	}
	fd := -1
	openErr := v.call(ctx, "open", "slot_binding_changed", func() error {
		var e error
		fd, e = unix.Openat(parent, filename, fileFlags(), 0)
		return e
	})
	if fd >= 0 {
		file := os.NewFile(uintptr(fd), "farol-slot-binding-read")
		defer func() {
			closeFile := v.closeFile
			if closeFile == nil {
				closeFile = (*os.File).Close
			}
			// Cleanup runs once even after expiry; it is not a new read budget.
			if err := closeFile(file); err != nil {
				result = verificationJoin(result, verificationFailure("slot_binding_changed", true, err))
			}
			result = verificationJoin(result, v.bound(ctx))
		}()
	}
	if openErr != nil {
		return openErr
	}
	checkFile := func() error {
		var current fingerprint
		if err := v.call(ctx, "held", "slot_binding_changed", func() error { var e error; current, e = statFD(fd); return e }); err != nil {
			return err
		}
		if current != before {
			return verificationFailure("slot_binding_changed", false, nil)
		}
		return nil
	}
	if err := checkFile(); err != nil {
		return err
	}
	data := make([]byte, 0, int(before.size)+1)
	var buffer [4096]byte
	for len(data) <= maxRecord {
		var n int
		if err := v.call(ctx, "read", "slot_binding_changed", func() error {
			read := v.read
			if read == nil {
				read = unix.Read
			}
			var e error
			n, e = read(fd, buffer[:min(len(buffer), maxRecord+1-len(data))])
			return e
		}); err != nil {
			return err
		}
		if n < 0 || n > len(buffer) || n > maxRecord+1-len(data) {
			return verificationFailure("slot_binding_internal", true, nil)
		}
		if n == 0 {
			break
		}
		data = append(data, buffer[:n]...)
	}
	if len(data) > maxRecord || int64(len(data)) != before.size {
		return verificationFailure("slot_binding_changed", false, nil)
	}
	if err := checkFile(); err != nil {
		return err
	}
	var named, currentParent fingerprint
	readbackMissing := false
	if err := v.call(ctx, "readback", "slot_binding_changed", func() error {
		var e error
		named, e = statAt(parent, filename)
		if e == unix.ENOENT {
			readbackMissing = true
			return nil
		}
		return e
	}); err != nil {
		return err
	}
	if err := v.call(ctx, "parent-readback", "slot_binding_directory", func() error { var e error; currentParent, e = statFD(parent); return e }); err != nil {
		return err
	}
	if readbackMissing || named != before || currentParent.identity() != directory.identity() {
		return verificationFailure("slot_binding_changed", false, nil)
	}
	if !bytes.Equal(data, v.expected) {
		return verificationFailure("slot_binding_mismatch", false, nil)
	}
	return v.bound(ctx)
}
