package process

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// All tests inject the private OS boundary and manual timer. NONE invokes
// nativeBoundary.Start, exec/spawn, signals, a shell, a daemon or a provider.
type testClock struct{ value time.Time }

func (c *testClock) Now() time.Time { return c.value }

type waited struct {
	result exit
	err    error
}
type ownedDouble struct {
	mutex     sync.Mutex
	result    chan waited
	kills     int
	killError error
}

func (o *ownedDouble) Wait() (exit, error) { v := <-o.result; return v.result, v.err }
func (o *ownedDouble) Kill() error {
	o.mutex.Lock()
	defer o.mutex.Unlock()
	o.kills++
	return o.killError
}
func (o *ownedDouble) killCount() int { o.mutex.Lock(); defer o.mutex.Unlock(); return o.kills }

type boundaryDouble struct {
	root           *ownedDouble
	calls          int
	captured       Command
	stdout, stderr io.Writer
	before         func()
	err            error
}

func (b *boundaryDouble) Start(ctx context.Context, c Command, check func(context.Context) error, out, diag io.Writer) (owned, error) {
	b.calls++
	b.captured = copyCommand(c)
	b.stdout, b.stderr = out, diag
	if b.before != nil {
		b.before()
	}
	if err := check(ctx); err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	if b.err != nil {
		return nil, b.err
	}
	return b.root, nil
}

type manualTimer struct {
	mutex    sync.Mutex
	callback func()
	stopped  bool
	duration time.Duration
}

func (m *manualTimer) Stop() bool {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	old := m.stopped
	m.stopped = true
	return !old
}
func (m *manualTimer) fire() {
	m.mutex.Lock()
	if m.stopped {
		m.mutex.Unlock()
		return
	}
	f := m.callback
	m.mutex.Unlock()
	f()
}

type timers struct {
	mutex sync.Mutex
	all   []*manualTimer
}

func (t *timers) schedule(d time.Duration, f func()) timer {
	m := &manualTimer{callback: f, duration: d}
	t.mutex.Lock()
	t.all = append(t.all, m)
	t.mutex.Unlock()
	return m
}
func (t *timers) at(i int) *manualTimer { t.mutex.Lock(); defer t.mutex.Unlock(); return t.all[i] }
func fixture(t *testing.T) (*Prepared, *boundaryDouble, *testClock, *timers) {
	t.Helper()
	clock := &testClock{time.UnixMilli(1900000000000)}
	command := Command{WorkspaceID: "code", Root: "/approved/code", Cwd: "/approved/code", RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}, Executable: "/selected/command", ExecutableSHA256: strings.Repeat("a", 64), Args: []string{"arg"}, Environment: []string{"PATH=/usr/bin", "LANG=C.UTF-8"}, Input: []byte("input")}
	boundary := &boundaryDouble{root: &ownedDouble{result: make(chan waited, 1)}}
	timers := &timers{}
	p, err := newPrepared(command, boundary, clock, timers.schedule)
	if err != nil {
		t.Fatal(err)
	}
	return p, boundary, clock, timers
}
func spawn(t *testing.T, p *Prepared, c *testClock, check func(context.Context) error) *Child {
	t.Helper()
	out, err := p.Spawn(context.Background(), processsvc.SpawnRequest{Deadline: c.Now().Add(15 * time.Second), Check: check})
	if err != nil {
		t.Fatal(err)
	}
	return out.(*Child)
}
func finish(t *testing.T, c *Child, b *boundaryDouble, valid bool) {
	t.Helper()
	code := 0
	if valid {
		b.root.result <- waited{result: exit{Code: &code, Waited: true, Drained: true}}
	} else {
		b.root.result <- waited{err: errors.New("Wait unavailable")}
	}
	select {
	case <-c.done:
	case <-time.After(time.Second):
		t.Fatal("boundary Wait did not settle")
	}
}
func TestNativeOwningHandleSeparatesRootWaitAndCohort(t *testing.T) {
	p, b, c, _ := fixture(t)
	child := spawn(t, p, c, func(context.Context) error { return nil })
	finish(t, child, b, true)
	out, err := child.Read(context.Background(), processsvc.Window{})
	if err != nil || !out.Waited || out.Root != processsvc.RootExited || out.ExitCode == nil || *out.ExitCode != 0 || out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
		t.Fatal(out, err)
	}
	receipt, err := child.Cancel(context.Background())
	if err != nil || receipt.Status != processsvc.AlreadyTerminal || b.root.killCount() != 0 {
		t.Fatal("reaped root did not retain a no-effect cancel acknowledgement")
	}
	if _, err := p.Spawn(context.Background(), processsvc.SpawnRequest{Deadline: c.Now().Add(time.Hour), Check: func(context.Context) error { return nil }}); err == nil || b.calls != 1 {
		t.Fatal("redispatch after Wait")
	}
}
func TestLostWaitCannotBecomeSignalOrTerminalProof(t *testing.T) {
	p, b, c, scheduled := fixture(t)
	child := spawn(t, p, c, func(context.Context) error { return nil })
	finish(t, child, b, false)
	scheduled.at(0).fire()
	receipt, err := child.Cancel(context.Background())
	if err != nil || receipt.Status != processsvc.CancelUnknown || b.root.killCount() != 0 {
		t.Fatal("signal after unknown Wait")
	}
	out, err := child.Read(context.Background(), processsvc.Window{})
	if err != nil || out.Waited || out.GroupCleanup != processsvc.CleanupUnverified {
		t.Fatal(out, err)
	}
}
func TestRefusedSignalHasNoEscalationOrAlternateAttempt(t *testing.T) {
	p, b, c, scheduled := fixture(t)
	b.root.killError = errors.New("EPERM double")
	child := spawn(t, p, c, func(context.Context) error { return nil })
	receipt, err := child.Cancel(context.Background())
	if err != nil || receipt.Status != processsvc.CancelUnknown {
		t.Fatal(receipt, err)
	}
	scheduled.at(0).fire()
	scheduled.at(1).fire()
	child.Cancel(context.Background())
	if b.root.killCount() != 1 {
		t.Fatal("signal replay")
	}
	finish(t, child, b, true)
}
func TestFixedDeadlineAndOwnerRevocationRequestOnlyOneStop(t *testing.T) {
	for _, reason := range []string{"deadline", "owner"} {
		t.Run(reason, func(t *testing.T) {
			p, b, c, scheduled := fixture(t)
			admitted := true
			child := spawn(t, p, c, func(context.Context) error {
				if !admitted {
					return errors.New("owner unavailable")
				}
				return nil
			})
			if scheduled.at(0).duration != 15*time.Second {
				t.Fatal("deadline changed")
			}
			if reason == "deadline" {
				scheduled.at(0).fire()
			} else {
				admitted = false
				scheduled.at(1).fire()
			}
			child.Cancel(context.Background())
			if b.root.killCount() != 1 {
				t.Fatal("multiple stop effects")
			}
			out, err := child.Read(context.Background(), processsvc.Window{})
			if err != nil || !out.CancelRequested || out.TimedOut != (reason == "deadline") || out.AuthorityLost != (reason == "owner") {
				t.Fatal(out, err)
			}
			finish(t, child, b, true)
		})
	}
}
func TestBoundedBinaryOutputAndIndependentWindows(t *testing.T) {
	p, b, c, _ := fixture(t)
	child := spawn(t, p, c, func(context.Context) error { return nil })
	payload := bytes.Repeat([]byte{0xff, 0, 0xe2}, 40000)
	if _, err := b.stdout.Write(payload); err != nil {
		t.Fatal(err)
	}
	b.stderr.Write([]byte{0, 0xff})
	first, err := child.Read(context.Background(), processsvc.Window{})
	if err != nil || len(first.Stdout) != processsvc.WindowBytes || !bytes.Equal(first.Stdout, payload[:processsvc.WindowBytes]) || !bytes.Equal(first.Stderr, []byte{0, 0xff}) {
		t.Fatal("binary output/window changed", err)
	}
	first.Stdout[0] = 1
	next, err := child.Read(context.Background(), processsvc.Window{StdoutOffset: first.StdoutNext, StderrOffset: 2})
	if err != nil || !bytes.Equal(next.Stdout, payload[processsvc.WindowBytes:]) || len(next.Stderr) != 0 {
		t.Fatal("bad next window", err)
	}
	b.stdout.Write(bytes.Repeat([]byte{'x'}, processsvc.MaximumOutput))
	limited, err := child.Read(context.Background(), processsvc.Window{})
	if err != nil || limited.StdoutBytes+limited.StderrBytes != processsvc.MaximumOutput || !limited.OutputLimitReached || b.root.killCount() != 1 {
		t.Fatal("unbounded output or missing single stop")
	}
	finish(t, child, b, true)
}
func TestNativeAttemptFailureDoesNotReissueAndInputsAreCopied(t *testing.T) {
	p, b, c, _ := fixture(t)
	original := copyCommand(p.command)
	snapshot := copyCommand(original)
	sealed, err := newPrepared(original, b, c, p.schedule)
	if err != nil {
		t.Fatal(err)
	}
	p = sealed
	original.Args[0] = "changed"
	original.Environment[0] = "PATH=/changed"
	original.Input[0] = 'X'
	b.err = &processsvc.NativeFailure{Unknown: true}
	req := processsvc.SpawnRequest{Deadline: c.Now().Add(15 * time.Second), Check: func(context.Context) error { return nil }}
	if _, err := p.Spawn(context.Background(), req); err == nil {
		t.Fatal("lost ACK accepted")
	}
	if _, err := p.Spawn(context.Background(), req); err == nil || b.calls != 1 {
		t.Fatal("unknown start replay")
	}
	if b.captured.Args[0] != snapshot.Args[0] || b.captured.Environment[0] != snapshot.Environment[0] || !bytes.Equal(b.captured.Input, snapshot.Input) {
		t.Fatal("producer retained external mutable command")
	}
	command := copyCommand(p.command)
	command.Input[0] = 'X'
	command.Args[0] = "changed"
	command.Environment[0] = "PATH=/changed"
	if string(p.command.Input) != "input" || p.command.Args[0] != "arg" || p.command.Environment[0] != "PATH=/usr/bin" {
		t.Fatal("mutable command alias")
	}
}
func TestNoDefaultQualificationOrEnvironmentInheritance(t *testing.T) {
	p, _, c, _ := fixture(t)
	if _, err := New(p.command, nil, c); err == nil {
		t.Fatal("permissive default qualifier")
	}
	for _, environment := range [][]string{{"PATH=a", "PATH=b"}, {"INVALID"}, {"=value"}, {"TOKEN=x\x00y"}} {
		command := copyCommand(p.command)
		command.Environment = environment
		if validCommand(command) {
			t.Fatal("invalid environment accepted")
		}
	}
	command := copyCommand(p.command)
	command.Environment = []string{}
	copy := copyCommand(command)
	if copy.Environment == nil {
		t.Fatal("nil environment would inherit host state")
	}
}
