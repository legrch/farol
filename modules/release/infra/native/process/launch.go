// Package process owns one original /usr/bin/open child. The Release
// operation retains admission, journal and routes until Start/Wait/output return.
package process

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

type Clock struct{}

func (Clock) Now() time.Time { return time.Now() }
func (Clock) Sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

type drain struct {
	mu            sync.Mutex
	bytes         int
	eof, overflow bool
}

func (d *drain) Write(data []byte) (int, error) {
	d.mu.Lock()
	d.bytes += min(len(data), 4097-d.bytes)
	d.overflow = d.bytes > 4096
	d.mu.Unlock()
	return len(data), nil
}

type eofReader struct {
	io.Reader
	eof bool
}

func (r *eofReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err == io.EOF {
		r.eof = true
	}
	return n, err
}
func (d *drain) ReadFrom(source io.Reader) (int64, error) {
	r := &eofReader{Reader: source}
	n, err := io.Copy(struct{ io.Writer }{d}, struct{ io.Reader }{r})
	d.mu.Lock()
	d.eof = err == nil && r.eof
	d.mu.Unlock()
	return n, err
}
func (d *drain) complete() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.eof && !d.overflow
}

// Open receives only arguments built by the existing helper protocol owner.
// A failed launch is never retried or compensated. The original bound is
// shortened by the reference's ten-second launch cap, never renewed.
func Open(ctx context.Context, until time.Time, arguments []string, fence func(context.Context) error) error {
	fail := func(internal bool, cause error) error {
		return &port.HelperRecoveryFailure{Code: "launch_failed", Phase: "refused", Internal: internal, Uncertain: true, Cause: cause}
	}
	if ctx == nil || until.IsZero() || fence == nil || len(arguments) != 5 || arguments[0] != "/usr/bin/open" || arguments[1] != "-a" || arguments[3] != "--args" || !strings.HasPrefix(arguments[4], "--farol-installed-update-relaunch=") {
		return fail(true, nil)
	}
	end := time.Now().Add(10 * time.Second)
	if until.Before(end) {
		end = until
	}
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(end) {
		end = deadline
	}
	bounded, cancel := context.WithDeadline(ctx, end)
	defer cancel()
	check := func() error {
		if bounded.Err() != nil {
			return bounded.Err()
		}
		if !time.Now().Before(end) {
			return context.DeadlineExceeded
		}
		return nil
	}
	if err := check(); err != nil {
		return fail(false, err)
	}
	if err := fence(bounded); err != nil {
		return fail(true, err)
	}
	cmd := exec.CommandContext(bounded, "/usr/bin/open", append([]string(nil), arguments[1:]...)...)
	cmd.Dir, cmd.Env = "/", []string{"LANG=C.UTF-8", "PATH=/usr/bin:/bin"}
	stdout, stderr := &drain{}, &drain{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// Wait joins the actual child and copying producers. Forced pipe closure is
	// not EOF; the independent witnesses below preserve that distinction.
	cmd.WaitDelay = time.Second
	if err := check(); err != nil {
		return fail(false, err)
	}
	if err := cmd.Start(); err != nil {
		return fail(true, errors.Join(err, check()))
	}
	err := cmd.Wait()
	late, after := check(), fence(bounded)
	var exit *exec.ExitError
	if errors.As(err, &exit) && late == nil && after == nil && cmd.ProcessState != nil && cmd.ProcessState.Exited() && stdout.complete() && stderr.complete() {
		// Actual terminal nonzero status with joined EOF is the reference's
		// launch_failed result. Durable launch_requested is retained, no retry.
		return &port.HelperRecoveryFailure{Code: "launch_failed", Phase: "refused", Cause: err}
	}
	if err != nil || late != nil || after != nil || cmd.ProcessState == nil || !cmd.ProcessState.Exited() || !stdout.complete() || !stderr.complete() {
		return fail(err != nil || after != nil, errors.Join(err, late, after))
	}
	return nil
}
