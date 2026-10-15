package processprobe

import (
	"context"
	"errors"
	"io"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/services/processwait"
)

// These fixtures retain the real native lifecycle and the owning app policy.
// Controlled child primitives are not Darwin, helper, package or installed proof.
type compositionClock struct {
	origin  time.Time
	elapsed atomic.Int64
}

func (c *compositionClock) Now() time.Time { return c.origin.Add(time.Duration(c.elapsed.Load())) }
func (c *compositionClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.elapsed.Add(int64(d))
	return nil
}

type compositionStep struct {
	stdout, stderr                    string
	startFailure, missingEOF, timeout bool
	after                             func()
}

func composedProbe(t *testing.T, steps []compositionStep) (*Probe, *fixtureBoundary, []*fixtureChild) {
	t.Helper()
	children := make([]*fixtureChild, len(steps))
	for i := range children {
		children[i] = &fixtureChild{}
	}
	b := &fixtureBoundary{existence: func(int) bool { return true }}
	b.build = func(out, diagnostic io.Writer) child {
		index := int(b.prepares.Load()) - 1
		if index >= len(steps) {
			t.Error("composition launched an extra observation")
			return nil
		}
		step, c := steps[index], children[index]
		if step.startFailure {
			c.startFn = func() error { return errors.New("controlled startup failure") }
		}
		killed := make(chan struct{})
		c.killFn = func() error { close(killed); return nil }
		c.waitFn = func() (status, error) {
			if step.timeout {
				<-killed
			}
			if step.missingEOF {
				_, _ = out.Write([]byte(step.stdout))
			} else {
				copyOutput(out, step.stdout)
			}
			copyOutput(diagnostic, step.stderr)
			if step.after != nil {
				step.after()
			}
			return status{exited: true, code: 0}, nil
		}
		return c
	}
	return newProbe(23456, b), b, children
}

func composedService(t *testing.T, p *Probe, clock *compositionClock) *processwait.Service {
	t.Helper()
	s, err := processwait.New(birth, p, clock)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func requireAppFailure(t *testing.T, err error, code string, uncertain bool) {
	t.Helper()
	var f *processwait.Failure
	if !errors.As(err, &f) || f == nil || f.Code != code || f.Uncertain != uncertain {
		t.Fatalf("app failure = %#v (%v), want %s uncertain=%t", f, err, code, uncertain)
	}
}

func TestCompositionPreservesNativeFailureClassification(t *testing.T) {
	for _, method := range []string{"capture", "confirm", "wait"} {
		for _, tc := range []struct {
			name      string
			step      compositionStep
			uncertain bool
		}{
			{"completed-refusal", compositionStep{stdout: birth, stderr: "\n"}, false},
			{"startup", compositionStep{startFailure: true}, true},
			{"cleanup-without-eof", compositionStep{stdout: birth, missingEOF: true}, true},
			{"in-flight-deadline", compositionStep{timeout: true}, true},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				clock := &compositionClock{origin: time.Now()}
				until := clock.Now().Add(2 * time.Second)
				if tc.step.timeout {
					// Hold the app clock before the deadline so the native typed
					// timeout reaches app error mapping, independent of scheduler
					// timing between a matching poll and app budget expiry.
					until = clock.Now().Add(80 * time.Millisecond)
				}
				steps := []compositionStep{tc.step}
				if method == "wait" {
					steps = append([]compositionStep{{stdout: birth}}, steps...)
				}
				p, b, children := composedProbe(t, steps)
				var err error
				switch method {
				case "capture":
					var token string
					token, err = processwait.Capture(context.Background(), until, p, clock)
					if token != "" {
						t.Fatal("failed capture disclosed an identity")
					}
				case "confirm":
					s := composedService(t, p, clock)
					err = s.ConfirmIdentity(context.Background(), until)
					requireAppFailure(t, s.WaitExit(context.Background(), until), "process_identity", false)
					requireAppFailure(t, s.ConfirmIdentity(context.Background(), until), "process_consumed", false)
				case "wait":
					s := composedService(t, p, clock)
					if e := s.ConfirmIdentity(context.Background(), until); e != nil {
						t.Fatal(e)
					}
					err = s.WaitExit(context.Background(), until)
					requireAppFailure(t, s.WaitExit(context.Background(), until), "process_consumed", false)
				}
				requireAppFailure(t, err, "process_unknown", tc.uncertain)
				// A fresh app operation still cannot relaunch a tainted native probe.
				_, again := processwait.Capture(context.Background(), time.Now().Add(time.Second), p, clock)
				requireAppFailure(t, again, "process_unknown", tc.uncertain)
				if b.prepares.Load() != int32(len(steps)) || b.exists.Load() != 0 {
					t.Fatal("failed observation retried or established absence")
				}
				for i, c := range children {
					wantWait, wantKill := int32(1), int32(0)
					if steps[i].startFailure {
						wantWait = 0
					}
					if steps[i].timeout {
						wantKill = 1
					}
					if c.starts.Load() != 1 || c.waits.Load() != wantWait || c.kills.Load() != wantKill {
						t.Fatalf("child %d lifecycle: start=%d wait=%d kill=%d", i, c.starts.Load(), c.waits.Load(), c.kills.Load())
					}
				}
			})
		}
	}
}

func TestCompositionIdentityWitnessAndOnceState(t *testing.T) {
	clock := &compositionClock{origin: time.Now()}
	until := clock.Now().Add(2 * time.Second)
	p, b, children := composedProbe(t, []compositionStep{{stdout: "  " + birth + "\n"}, {stdout: birth}, {}})
	token, err := processwait.Capture(context.Background(), until, p, clock)
	if err != nil || token != birth {
		t.Fatalf("capture did not preserve native trimmed token: %q %v", token, err)
	}
	s := composedService(t, p, clock)
	requireAppFailure(t, s.WaitExit(context.Background(), until), "process_identity", false)
	if err = s.ConfirmIdentity(context.Background(), until); err != nil {
		t.Fatal(err)
	}
	copy := *s
	requireAppFailure(t, copy.ConfirmIdentity(context.Background(), until), "process_consumed", false)
	if err = copy.WaitExit(context.Background(), until); err != nil {
		t.Fatal(err)
	}
	requireAppFailure(t, s.WaitExit(context.Background(), until), "process_consumed", false)
	if b.prepares.Load() != 3 || b.exists.Load() != 1 {
		t.Fatal("witness/copy duplicated an observation or absence lacked native proof")
	}
	for _, c := range children {
		if c.starts.Load() != 1 || c.waits.Load() != 1 || c.kills.Load() != 0 {
			t.Fatal("clean composition changed child lifecycle")
		}
	}
}

func TestCompositionReuseAndLateAbsenceRefuse(t *testing.T) {
	for _, scenario := range []string{"initial-reuse", "reuse-after-confirm", "late-absence"} {
		t.Run(scenario, func(t *testing.T) {
			clock := &compositionClock{origin: time.Now()}
			until := clock.Now().Add(time.Second)
			steps := []compositionStep{{stdout: birth}, {stdout: "different birth"}}
			code, uncertain := "process_reused", false
			if scenario == "initial-reuse" {
				steps = steps[1:]
				code = "process_identity"
			}
			if scenario == "late-absence" {
				// The native child finishes in budget, but its absence is late
				// at the app boundary. Neither successful EOF nor ESRCH can
				// override the original method budget.
				steps[1] = compositionStep{after: func() { clock.elapsed.Store(int64(time.Second)) }}
				code, uncertain = "process_unknown", true
			}
			p, b, children := composedProbe(t, steps)
			s := composedService(t, p, clock)
			err := s.ConfirmIdentity(context.Background(), until)
			if scenario != "initial-reuse" {
				if err != nil {
					t.Fatal(err)
				}
				err = s.WaitExit(context.Background(), until)
			}
			requireAppFailure(t, err, code, uncertain)
			if b.prepares.Load() != int32(len(steps)) {
				t.Fatal("unexpected native retry")
			}
			if scenario == "late-absence" && b.exists.Load() != 1 {
				t.Fatal("absence fixture lacked native proof")
			}
			for _, c := range children {
				if c.kills.Load() != 0 {
					t.Fatal("identity refusal signaled child")
				}
			}
		})
	}
}

func TestCompositionActualFixedPSCaptureAndConfirm(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("fixed ps mechanism unavailable")
	}
	// Only the original fixed ps child runs. The observed target is this test
	// process; no nonzero target signal or production constructor is used.
	p := newProbe(os.Getpid(), nativeBoundary{})
	clock := &compositionClock{origin: time.Now()}
	token, err := processwait.Capture(context.Background(), time.Now().Add(2*time.Second), p, clock)
	if err != nil || token == "" {
		t.Fatalf("actual capture: %q %v", token, err)
	}
	s, err := processwait.New(token, p, clock)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ConfirmIdentity(context.Background(), time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "linux" {
		if _, err = New(os.Getpid()); err == nil {
			t.Fatal("portable fixture enabled production Linux route")
		}
	}
	t.Logf("actual %s fixed ps through app Capture/Confirm only; Darwin parity and updater selection unqualified", runtime.GOOS)
}
