package process

import (
	"context"
	"encoding/base64"
	"testing"

	computer "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/task/app/port"
)

// Public Computer DTOs only. Task retains its strict completion requirement;
// a supervised result must still deliver actual bytes for lineage parsing.
func TestSupervisedExitPreservesTaskObservationWithoutClaimingCompletion(t *testing.T) {
	for _, mode := range []string{"known", "signal", "missing-supervisor", "unknown-supervisor", "running-root", "unwaited", "undrained", "pending", "confirmed", "missing-exit", "crossed-exit"} {
		t.Run(mode, func(t *testing.T) {
			c, f, q := peerFixture()
			if _, err := c.Prepare(context.Background(), q); err != nil {
				t.Fatal(err)
			}
			handle, err := c.Start(context.Background(), q.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			const data = "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"synthetic-session\"}\n"
			code := 0
			r := &f.response
			r.State, r.Supervisor, r.RootState = computer.Exited, computer.SupervisorExited, computer.RootExited
			r.RootWaited, r.OutputDrained, r.ExitCode = true, true, &code
			r.GroupCleanup, r.DescendantCleanup = computer.CleanupUnverified, computer.CleanupUnverified
			r.StdoutBase64 = base64.StdEncoding.EncodeToString([]byte(data))
			r.StdoutBytes, r.StdoutNext = uint64(len(data)), uint64(len(data))
			switch mode {
			case "signal":
				r.ExitCode, r.ExitSignal = nil, 9
			case "missing-supervisor":
				r.Supervisor = ""
			case "unknown-supervisor":
				r.Supervisor = computer.SupervisorUnknown
			case "running-root":
				r.RootState = computer.RootRunning
			case "unwaited":
				r.RootWaited = false
			case "undrained":
				r.OutputDrained = false
			case "pending":
				r.GroupCleanup = computer.CleanupPending
			case "confirmed":
				r.GroupCleanup, r.DescendantCleanup = computer.CleanupConfirmed, computer.CleanupConfirmed
			case "missing-exit":
				r.ExitCode = nil
			case "crossed-exit":
				r.ExitSignal = 9
			}
			out, err := c.Read(context.Background(), port.ClaudeRead{Handle: handle})
			if mode == "known" || mode == "signal" {
				if err != nil || out.State != "unknown" || string(out.Stdout) != data || out.GroupCleanup != "unverified" || out.DescendantCleanup != "unverified" || !out.RootWaited || !out.OutputDrained || out.ExitSignal != r.ExitSignal {
					t.Fatal("supervised result lost lineage bytes or became Task completion", out, err)
				}
			} else if err == nil || len(out.Stdout) != 0 {
				t.Fatal("malformed supervised result accepted", out, err)
			}
			if f.reads != 1 || f.starts != 1 || f.prepares != 1 || f.cancels != 0 {
				t.Fatal("read reissued execution or control")
			}
		})
	}
}
