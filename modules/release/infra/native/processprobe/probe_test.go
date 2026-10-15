package processprobe

import (
	"context"
	"errors"
	"io"
	"math"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

const birth = "Thu Oct 15 12:34:56 2026"

type fixtureBoundary struct {
	build     func(io.Writer, io.Writer) child
	existence func(int) bool
	prepares  atomic.Int32
	exists    atomic.Int32
	boundPID  atomic.Int64
}

func (b *fixtureBoundary) prepare(pid int, out, err io.Writer) child {
	b.prepares.Add(1)
	b.boundPID.Store(int64(pid))
	return b.build(out, err)
}
func (b *fixtureBoundary) absent(pid int) bool {
	b.exists.Add(1)
	if b.existence == nil {
		return false
	}
	return b.existence(pid)
}

type fixtureChild struct {
	startFn              func() error
	waitFn               func() (status, error)
	killFn               func() error
	starts, waits, kills atomic.Int32
}

func (c *fixtureChild) start() error {
	c.starts.Add(1)
	if c.startFn != nil {
		return c.startFn()
	}
	return nil
}
func (c *fixtureChild) wait() (status, error) {
	c.waits.Add(1)
	return c.waitFn()
}
func (c *fixtureChild) kill() error {
	c.kills.Add(1)
	if c.killFn != nil {
		return c.killFn()
	}
	return nil
}

func copyOutput(out io.Writer, text string) {
	// Exercise the independent ReaderFrom/EOF witness rather than just Write.
	_, _ = io.Copy(out, struct{ io.Reader }{strings.NewReader(text)})
}

func completeFixture(stdout, stderr string, code int, absent bool) (*Probe, *fixtureBoundary, *fixtureChild) {
	c := &fixtureChild{}
	b := &fixtureBoundary{existence: func(int) bool { return absent }}
	b.build = func(out, err io.Writer) child {
		c.waitFn = func() (status, error) {
			copyOutput(out, stdout)
			copyOutput(err, stderr)
			return status{exited: true, code: code}, nil
		}
		return c
	}
	return newProbe(23456, b), b, c
}

func requireKind(t *testing.T, err error, want port.ProcessProbeFailureKind) {
	t.Helper()
	var f *port.ProcessProbeFailure
	if !errors.As(err, &f) || f.Kind != want {
		t.Fatalf("failure = %v (%#v), want kind %d", err, f, want)
	}
	if err.Error() != "release_process_observation_failed" {
		t.Fatal("native detail leaked")
	}
}

func TestConstructorAndClosedInputs(t *testing.T) {
	for _, pid := range []int{-1, 0, 1} {
		_, err := New(pid)
		requireKind(t, err, port.ProcessProbeInput)
	}
	if int64(int(math.MaxInt32))+1 <= int64(math.MaxInt) {
		_, err := New(int(int64(math.MaxInt32) + 1))
		requireKind(t, err, port.ProcessProbeInput)
	}
	if runtime.GOOS != "darwin" {
		_, err := New(23456)
		requireKind(t, err, port.ProcessProbeUnknown)
	}
	var nilProbe *Probe
	if nilProbe.PID() != 0 {
		t.Fatal("nil PID")
	}
	for _, p := range []*Probe{nil, {}} {
		_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
		requireKind(t, err, port.ProcessProbeInput)
	}
	p, b, _ := completeFixture(birth, "", 0, false)
	if p.PID() != 23456 {
		t.Fatal("PID changed")
	}
	_, err := p.Observe(nil, time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeInput)
	_, err = p.Observe(context.Background(), time.Time{})
	requireKind(t, err, port.ProcessProbeInput)
	_, err = p.Observe(context.Background(), time.Now().Add(-time.Second))
	requireKind(t, err, port.ProcessProbeDeadline)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = p.Observe(ctx, time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCanceled)
	if b.prepares.Load() != 0 {
		t.Fatal("preflight performed IO")
	}
}

func TestCompletedObservations(t *testing.T) {
	tests := []struct {
		name, stdout, stderr string
		code                 int
		absent               bool
		presence             port.ProcessPresence
		start                string
		exists               int32
	}{
		{"present0", "  " + birth + "\n", "", 0, false, port.ProcessPresent, birth, 0},
		{"present1", birth, "", 1, false, port.ProcessPresent, birth, 0},
		{"absent0", "", "", 0, true, port.ProcessAbsent, "", 1},
		{"absent1", "", "", 1, true, port.ProcessAbsent, "", 1},
		{"trimEmpty", "\x1c\t \n\u0085", "", 1, true, port.ProcessAbsent, "", 1},
		{"stillExists", "", "", 1, false, port.ProcessUnknown, "", 1},
		{"stderrWhitespace", birth, "\n", 0, false, port.ProcessUnknown, "", 0},
		{"exit2", "", "", 2, true, port.ProcessUnknown, "", 0},
		{"signal", "", "", -1, true, port.ProcessUnknown, "", 0},
		{"multiline", birth + "\nother", "", 0, true, port.ProcessUnknown, "", 0},
		{"control", "a\x00b", "", 0, true, port.ProcessUnknown, "", 0},
		{"invalidUTF8", "\xff", "", 0, true, port.ProcessUnknown, "", 0},
		{"unicodeLine", "a\u2028b", "", 0, true, port.ProcessUnknown, "", 0},
		{"longBirth", strings.Repeat("a", 129), "", 0, true, port.ProcessUnknown, "", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, b, c := completeFixture(tt.stdout, tt.stderr, tt.code, tt.absent)
			got, err := p.Observe(context.Background(), time.Now().Add(time.Second))
			if tt.presence == port.ProcessUnknown {
				requireKind(t, err, port.ProcessProbeUnknown)
			} else if err != nil {
				t.Fatal(err)
			}
			if got.Presence != tt.presence || got.Start != tt.start || b.exists.Load() != tt.exists || b.boundPID.Load() != 23456 {
				t.Fatalf("observation = %#v, exists=%d bound=%d", got, b.exists.Load(), b.boundPID.Load())
			}
			if c.starts.Load() != 1 || c.waits.Load() != 1 || c.kills.Load() != 0 {
				t.Fatal("unexpected child lifecycle")
			}
			if err != nil {
				_, again := p.Observe(context.Background(), time.Now().Add(time.Second))
				requireKind(t, again, port.ProcessProbeUnknown)
				if c.starts.Load() != 1 {
					t.Fatal("tainted probe retried")
				}
			}
		})
	}
}

func TestMissingActualEOFRefusesEvenWithExitStatus(t *testing.T) {
	for _, missing := range []string{"stdout", "stderr", "both"} {
		t.Run(missing, func(t *testing.T) {
			b := &fixtureBoundary{build: func(out, err io.Writer) child {
				return &fixtureChild{waitFn: func() (status, error) {
					if missing == "stdout" || missing == "both" {
						_, _ = out.Write([]byte(birth)) // a prefix is not EOF
					} else {
						copyOutput(out, birth)
					}
					if missing != "stderr" && missing != "both" {
						copyOutput(err, "")
					}
					return status{exited: true, code: 1}, nil
				}}
			}}
			_, err := newProbe(23456, b).Observe(context.Background(), time.Now().Add(time.Second))
			requireKind(t, err, port.ProcessProbeCleanupUnknown)
			if b.exists.Load() != 0 {
				t.Fatal("missing EOF established absence")
			}
		})
	}
}

func TestStartFailureDoesNotWaitOrRetry(t *testing.T) {
	c := &fixtureChild{startFn: func() error { return errors.New("private native detail") }}
	b := &fixtureBoundary{build: func(io.Writer, io.Writer) child { return c }}
	p := newProbe(23456, b)
	_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeStartFailure)
	_, err = p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeStartFailure)
	if c.starts.Load() != 1 || c.waits.Load() != 0 || c.kills.Load() != 0 {
		t.Fatal("retried failed Start")
	}
}

func TestUnexpectedWaitErrorRetainsUncertainty(t *testing.T) {
	b := &fixtureBoundary{build: func(out, err io.Writer) child {
		return &fixtureChild{waitFn: func() (status, error) {
			copyOutput(out, birth)
			copyOutput(err, "")
			return status{exited: true, code: 0}, errors.New("unexpected native wait failure")
		}}
	}}
	p := newProbe(23456, b)
	_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCleanupUnknown)
	_, err = p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCleanupUnknown)
	if b.prepares.Load() != 1 {
		t.Fatal("unknown Wait retried")
	}
	if p.retained == nil {
		t.Fatal("uncertain owner discarded")
	}
}

func TestWaitWithoutTerminalProofStopsAndRetainsOriginalOwner(t *testing.T) {
	c := &fixtureChild{}
	b := &fixtureBoundary{build: func(out, err io.Writer) child {
		c.waitFn = func() (status, error) {
			copyOutput(out, birth)
			copyOutput(err, "")
			return status{}, errors.New("no terminal state")
		}
		return c
	}}
	p := newProbe(23456, b)
	_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCleanupUnknown)
	if p.retained == nil || c.kills.Load() != 1 || c.waits.Load() != 1 || b.exists.Load() != 0 {
		t.Fatal("unknown native Wait lost ownership or retried")
	}
	_, err = p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCleanupUnknown)
	if c.kills.Load() != 1 || c.waits.Load() != 1 {
		t.Fatal("uncertain cleanup retried")
	}
}

func TestSuccessfulSnapshotsMayObserveAgain(t *testing.T) {
	p, b, _ := completeFixture(birth, "", 0, false)
	until := time.Now().Add(time.Second)
	for range 2 {
		got, err := p.Observe(context.Background(), until)
		if err != nil || got.Presence != port.ProcessPresent || got.Start != birth {
			t.Fatalf("clean snapshot: %#v %v", got, err)
		}
	}
	if b.prepares.Load() != 2 {
		t.Fatal("clean observer was consumed")
	}
}

func TestTokenBoundAndExactTrim(t *testing.T) {
	for _, tc := range []struct {
		raw, want string
		ok        bool
	}{
		{"", "", true}, {" \n\t\x1c\x1f\u0085\u3000", "", true},
		{" \t\n" + birth + "\n\u00a0", birth, true},
		{strings.Repeat("é", 64), strings.Repeat("é", 64), true},
		{strings.Repeat("é", 65), "", false},
		{"a\tb", "", false}, {"a\rb", "", false}, {"a\x7fb", "", false},
		{"a\u2029b", "", false}, {"\xff ", "", false},
	} {
		got, ok := startToken([]byte(tc.raw))
		if ok != tc.ok || got != tc.want {
			t.Fatalf("token %q => %q,%v", tc.raw, got, ok)
		}
	}
}
