// Package stop signals exactly one bound predecessor PID, and only while
// the kernel reports that PID's executable inside the bound installed slot.
// It decides nothing: the processwait service owns identity, timing and the
// positive exit observation.
package stop

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/legrch/farol/modules/release/app/port"
)

var (
	ErrInput       = errors.New("process_term_input")
	ErrPath        = errors.New("process_term_path")
	ErrUnknown     = errors.New("process_term_unknown")
	ErrUnsupported = errors.New("process_term_unsupported")
)

// Terminator implements port.ProcessTerminator for one PID and one slot.
type Terminator struct {
	pid  int
	slot string
	os   system
}

type system interface {
	// path returns the kernel executable path, "" when the PID is gone.
	path(ctx context.Context, pid int) (string, error)
	signal(pid int, s port.ProcessSignal) error
}

// Slot is the installed bundle a helper replaces: the shared /Applications
// copy, or the one under the user's home.
func Slot(home string, shared bool) string {
	if shared {
		return "/Applications/Farol.app"
	}
	return home + "/Applications/Farol.app"
}

// New binds pid to slot, an absolute clean `.app` bundle path such as
// /Applications/Farol.app.
func New(pid int, slot string) (*Terminator, error) {
	return newTerminator(pid, slot, nativeSystem{})
}

func newTerminator(pid int, slot string, os system) (*Terminator, error) {
	if pid <= 1 || !filepath.IsAbs(slot) || filepath.Clean(slot) != slot || !strings.HasSuffix(slot, ".app") || os == nil {
		return nil, ErrInput
	}
	return &Terminator{pid: pid, slot: slot, os: os}, nil
}

func (t *Terminator) Signal(ctx context.Context, s port.ProcessSignal) error {
	if t == nil || ctx == nil || s != port.ProcessSignalTerminate && s != port.ProcessSignalKill {
		return ErrInput
	}
	path, err := t.os.path(ctx, t.pid)
	if err != nil {
		return ErrUnknown
	}
	if path == "" {
		// Gone before the signal: nothing to send. Only the waiter's probe
		// may conclude absence.
		return nil
	}
	if !inside(path, t.slot) {
		return ErrPath
	}
	return t.os.signal(t.pid, s)
}

func inside(path, slot string) bool {
	return filepath.Clean(path) == path && strings.HasPrefix(path, slot+"/Contents/")
}
