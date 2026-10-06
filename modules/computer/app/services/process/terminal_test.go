package process

import (
	"bytes"
	"context"
	"strconv"
	"sync"
	"testing"
	"time"
)

// Paged output, clocks, authority and physical roots are explicit doubles.
// No process, native filesystem, persistence or provider qualification here.
type terminalChildDouble struct {
	stdout, stderr []byte
	reads, cancels int
	pageBytes      int
	running        bool
	mutate         func(int, *Observation)
}

func (*terminalChildDouble) Handle() string { return "owned-child" }
func (c *terminalChildDouble) Cancel(context.Context) (*CancelReceipt, error) {
	c.cancels++
	return nil, &NativeFailure{Unknown: true}
}
func (c *terminalChildDouble) Read(_ context.Context, w Window) (*Observation, error) {
	c.reads++
	limit := c.pageBytes
	if limit == 0 {
		limit = WindowBytes
	}
	window := func(data []byte, offset uint64) []byte {
		if offset > uint64(len(data)) {
			return nil
		}
		end := min(offset+uint64(limit), uint64(len(data)))
		return data[offset:end]
	}
	code := 4
	out := &Observation{Handle: c.Handle(), Root: RootExited, Waited: true, ExitCode: &code,
		GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true,
		Stdout: window(c.stdout, w.StdoutOffset), Stderr: window(c.stderr, w.StderrOffset),
		StdoutOffset: w.StdoutOffset, StderrOffset: w.StderrOffset, StdoutBytes: uint64(len(c.stdout)), StderrBytes: uint64(len(c.stderr))}
	out.StdoutNext, out.StderrNext = w.StdoutOffset+uint64(len(out.Stdout)), w.StderrOffset+uint64(len(out.Stderr))
	if c.running {
		out.Root, out.Waited, out.ExitCode = RootRunning, false, nil
		out.GroupCleanup, out.DescendantCleanup, out.OutputDrained = CleanupPending, CleanupPending, false
	}
	if c.mutate != nil {
		c.mutate(c.reads, out)
	}
	return out, nil
}

type terminalLaunchDouble struct {
	seal  Seal
	child *terminalChildDouble
	calls int
}

func (p *terminalLaunchDouble) Seal() Seal { return p.seal }
func (p *terminalLaunchDouble) Spawn(ctx context.Context, r SpawnRequest) (Child, error) {
	if err := r.Check(ctx); err != nil {
		return nil, err
	}
	p.calls++
	return p.child, nil
}

func terminalCaptureFixture(t *testing.T, stdout, stderr []byte) (*Service, *terminalLaunchDouble, *connectorReadDouble, *execution, *observedWorkspace, *clock, *reservation) {
	t.Helper()
	_, clock, original, r, p := setup(t)
	launch := &terminalLaunchDouble{seal: p.seal, child: &terminalChildDouble{stdout: stdout, stderr: stderr}}
	s, err := NewForConnector("operation", connectorScopeDouble(), original, launch, r, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	start(t, s)
	clock.now = original.deadline.Add(time.Millisecond)
	current, read := connectorReadSelectionDouble(clock, original)
	return s, launch, current, read, workspaceFixture(s, read), clock, r
}

func TestCaptureTerminalRetainsCompleteBoundedOutputAfterExecutionExpiry(t *testing.T) {
	for _, size := range []int{0, 7, WindowBytes + 31, MaximumOutput} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			stdout, stderr := bytes.Repeat([]byte{0xff}, size/2), bytes.Repeat([]byte{0}, size-size/2)
			s, p, current, read, workspace, clock, r := terminalCaptureFixture(t, stdout, stderr)
			intent, scope := s.intent, *s.connector
			out, err := s.CaptureTerminal(context.Background(), current, workspace)
			if err != nil || out == nil || !ValidTerminalResult(*out) || !bytes.Equal(out.Observation.Stdout, stdout) || !bytes.Equal(out.Observation.Stderr, stderr) || out.Intent != intent || out.Scope != scope {
				t.Fatal("complete original result missing", err)
			}
			if p.calls != 1 || r.calls != 1 || p.child.cancels != 0 || p.child.reads > maximumTerminalPages || !sameIntent(s.intent, intent) || *s.connector != scope {
				t.Fatal("capture renewed or executed")
			}
			if size > 1 {
				out.Observation.Stdout[0] = 1
				if stdout[0] != 0xff {
					t.Fatal("capture leaked mutable child buffer")
				}
			}
			clock.now = read.deadline
			if out, err := s.CaptureTerminal(context.Background(), current, workspace); out != nil || err == nil {
				t.Fatal("capture renewed expired READ")
			}
		})
	}
}

func TestCaptureTerminalRefusesPartialChangedAndLateDeniedResult(t *testing.T) {
	for _, fault := range []string{"running", "unknown", "zero-progress", "changed-exit", "changed-size", "changed-flags", "withdraw-page", "expire-page", "physical-final", "unknown-final"} {
		t.Run(fault, func(t *testing.T) {
			s, p, current, read, workspace, clock, r := terminalCaptureFixture(t, bytes.Repeat([]byte("x"), WindowBytes+3), nil)
			switch fault {
			case "running":
				p.child.running = true
			case "unknown":
				s.uncertain = true
			case "physical-final":
				workspace.before = func() {
					if workspace.calls == 5 {
						workspace.value.RootIdentity.Inode = "changed"
					}
				}
			case "unknown-final":
				workspace.before = func() {
					if workspace.calls == 5 {
						s.gate.Lock()
						s.uncertain = true
						s.gate.Unlock()
					}
				}
			default:
				p.child.mutate = func(page int, out *Observation) {
					if page != 2 {
						return
					}
					switch fault {
					case "zero-progress":
						out.Stdout, out.StdoutNext = nil, out.StdoutOffset
					case "changed-exit":
						*out.ExitCode = 9
					case "changed-size":
						out.StdoutBytes++
					case "changed-flags":
						out.TimedOut = true
					case "withdraw-page":
						read.revoked = true
					case "expire-page":
						clock.now = read.deadline
					}
				}
			}
			out, err := s.CaptureTerminal(context.Background(), current, workspace)
			if out != nil || err == nil || p.calls != 1 || r.calls != 1 || p.child.cancels != 0 || p.child.reads > 2 {
				t.Fatalf("partial/changed/denied result: returned=%t error=%v spawn=%d reserve=%d cancel=%d reads=%d", out != nil, err, p.calls, r.calls, p.child.cancels, p.child.reads)
			}
			if fault == "zero-progress" || fault == "changed-exit" || fault == "changed-size" || fault == "changed-flags" {
				p.child.mutate = nil
				if out, err := s.CaptureTerminal(context.Background(), current, workspace); out != nil || err == nil || !s.uncertain {
					t.Fatal("incoherent terminal result lost sticky uncertainty")
				}
			}
		})
	}
}

func TestCaptureTerminalBoundsValidTinyWindowsWithoutRenewal(t *testing.T) {
	s, p, current, _, workspace, _, _ := terminalCaptureFixture(t, bytes.Repeat([]byte("x"), maximumTerminalPages+1), nil)
	p.child.pageBytes = 1
	out, err := s.CaptureTerminal(context.Background(), current, workspace)
	if out != nil || err == nil || err.Error() != "PROCESS_RESULT_WINDOW_LIMIT" || p.child.reads != maximumTerminalPages || p.calls != 1 || p.child.cancels != 0 {
		t.Fatalf("tiny windows exceeded bounded work: returned=%t error=%v reads=%d", out != nil, err, p.child.reads)
	}
}
