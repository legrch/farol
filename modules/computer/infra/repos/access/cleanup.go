package access

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// ConstructorCleanupState describes only native descriptions acquired by one
// failed Create/Open call. It is not authority, archive success, predecessor
// drain, durable publication, or proof of filesystem rollback/artifact removal.
type ConstructorCleanupState uint8

const (
	// ConstructorCleanupUnreported includes nil and errors without this receipt.
	// Absence of a receipt must never be interpreted as confirmed cleanup.
	ConstructorCleanupUnreported ConstructorCleanupState = iota
	ConstructorCleanupNotAcquired
	ConstructorCleanupConfirmed
	ConstructorCleanupUnknown
)

// ConstructorCleanup reads the explicit receipt on one constructor error,
// including through wrapping. NotAcquired means that call acquired no native
// description; Confirmed means every description it acquired returned a nil
// close receipt. Unknown includes a failed/lost receipt even if the OS may have
// consumed the handle. None permits retry, activation, or ignoring the error.
// A live Store (nil error) has no cleanup receipt. Independent constructor
// errors must be inspected separately, not combined into one scoped receipt.
func ConstructorCleanup(err error) ConstructorCleanupState {
	var failure *constructorFailure
	if !errors.As(err, &failure) {
		return ConstructorCleanupUnreported
	}
	if CleanupUnknown(err) {
		return ConstructorCleanupUnknown
	}
	return failure.cleanup
}

type constructorFailure struct {
	cleanup ConstructorCleanupState
	cause   error
}

func (e *constructorFailure) Error() string { return unavailable().Error() }
func (e *constructorFailure) Unwrap() error { return errors.Join(unavailable(), e.cause) }

func constructorError(cause error, cleanup ConstructorCleanupState) error {
	return &constructorFailure{cleanup: cleanup, cause: cause}
}

// CleanupUnknown reports uncertain native descriptor cleanup independently of
// OutcomeUnknown (publication/durability). Causes remain available via Is/As;
// Error text is classified and never contains private native diagnostics.
func CleanupUnknown(err error) bool {
	var failure *cleanupFailure
	return errors.As(err, &failure)
}

type cleanupFailure struct{ cause error }

func (e *cleanupFailure) Error() string { return unavailable().Error() }
func (e *cleanupFailure) Unwrap() error { return errors.Join(unavailable(), e.cause) }

type storeFailure struct{ cause error }

func (e *storeFailure) Error() string { return unavailable().Error() }
func (e *storeFailure) Unwrap() error { return errors.Join(unavailable(), e.cause) }

func refuse(causes ...error) error {
	return &storeFailure{cause: errors.Join(causes...)}
}

// Only a package test can replace a receipt on this instance. It must consume
// the exact disposable owner before injecting a lost receipt; this is not an
// alternate native engine, a global syscall override, or an OS refusal fixture.
type nativeCleanup struct {
	closeFD   func(int) error
	closeFile func(*os.File) error
}

func (c nativeCleanup) fd(fd int) error {
	if c.closeFD != nil {
		return c.closeFD(fd)
	}
	return unix.Close(fd)
}

func (d *disk) closeFile(file *os.File) error {
	var err error
	if d.cleanup.closeFile != nil {
		err = d.cleanup.closeFile(file)
	} else {
		err = file.Close()
	}
	if err == nil {
		return nil
	}
	failure := &cleanupFailure{cause: err}
	d.cleanupErr = errors.Join(d.cleanupErr, failure)
	return failure
}
