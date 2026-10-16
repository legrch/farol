package apptree

import (
	"context"
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// Per-verifier seams exercise actual-return and failure custody in package
// tests. Production always closes its own descriptors with the native calls.
// Borrowed handles never enter this owner.
type cleanup struct {
	closeFD   func(int) error
	closeFile func(*os.File) error
}

func (c cleanup) fd(fd int) error {
	if c.closeFD != nil {
		return c.closeFD(fd)
	}
	return unix.Close(fd)
}
func (c cleanup) file(f *os.File) error {
	if c.closeFile != nil {
		return c.closeFile(f)
	}
	return f.Close()
}
func finishCleanup(ctx context.Context, primary, closed error) error {
	late := canceled(ctx)
	if closed != nil {
		return &observationFailure{refusal: &Error{Code: CodeIO}, cause: errors.Join(primary, closed), cancellation: late}
	}
	if late != nil {
		return &observationFailure{refusal: &Error{Code: CodeCanceled}, cause: primary, cancellation: late}
	}
	return primary
}
