package process

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// VerifyExecutableSignatures checks the two signed executables in the accepted
// installed tree. The outer app is presently unsigned; this is not a publisher
// identity check. The caller retains the slot, lease and original deadline.
func VerifyExecutableSignatures(ctx context.Context, until time.Time, slot string) error {
	if ctx == nil || until.IsZero() || slot == "" || !filepath.IsAbs(slot) {
		return &port.HelperRecoveryFailure{Code: "launch_signature_unknown", Phase: "refused", Internal: true, Uncertain: true}
	}
	checks := [][]string{
		{"--verify", "--strict", filepath.Join(slot, "Contents/Resources/app/farol-backend")},
		{"--verify", "--strict", "--ignore-resources", filepath.Join(slot, "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron")},
	}
	for _, args := range checks {
		if err := ctx.Err(); err != nil || !time.Now().Before(until) {
			return &port.HelperRecoveryFailure{Code: "launch_signature_unknown", Phase: "refused", Uncertain: true, Cause: errors.Join(err, context.DeadlineExceeded)}
		}
		bounded, cancel := context.WithDeadline(ctx, until)
		cmd := exec.CommandContext(bounded, "/usr/bin/codesign", args...)
		cmd.Dir, cmd.Env = "/", []string{"LANG=C.UTF-8", "PATH=/usr/bin:/bin"}
		stdout, stderr := &drain{}, &drain{}
		cmd.Stdout, cmd.Stderr = stdout, stderr
		cmd.WaitDelay = time.Second
		err := cmd.Run()
		late := bounded.Err()
		cancel()
		if err != nil || late != nil || cmd.ProcessState == nil || !cmd.ProcessState.Exited() || !stdout.complete() || !stderr.complete() {
			var exit *exec.ExitError
			if errors.As(err, &exit) && late == nil && stdout.complete() && stderr.complete() {
				return &port.HelperRecoveryFailure{Code: "launch_signature_refused", Phase: "refused", Cause: err}
			}
			return &port.HelperRecoveryFailure{Code: "launch_signature_unknown", Phase: "refused", Uncertain: true, Cause: errors.Join(err, late)}
		}
	}
	return nil
}
