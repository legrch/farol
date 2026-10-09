//go:build darwin

package codex

// Lead-only, original proxy lifetime/physical-selection evidence. No vendor
// protocol, provider, installed profile, process lookup or descendant claim.
import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/domain"
)

// Fixed bytes, shell builtins only: no descendants, external sleep or network.
// The ten-second self-exit is independent of Close; it never upgrades an
// unknown Close/Wait. TERM proof is written before exit by this exact child.
const nativeProxyFixtureImage = `#!/bin/bash
[ "$#" -eq 4 ] && [ "$1" = app-server ] && [ "$2" = proxy ] && [ "$3" = --sock ] && [ "$4" = "$HOME/p.sock" ] || exit 64
trap 'printf "%s\n" "$$" > "$HOME/term.pid"; exit 0' TERM
printf '%s\n' "$$" > "$HOME/child.pid" || exit 65
SECONDS=0
while [ "$SECONDS" -lt 10 ]; do
  IFS= read -r -t 1 unused || :
done
exit 70
`

type nativeProxyFixture struct {
	ctx       context.Context
	root      string
	rootInfo  os.FileInfo
	selection Selection
	boundary  Boundary
	listeners []*net.UnixListener
	mu        sync.Mutex
	original  *nativeProcess
	launched  bool
	logFailed bool
	retain    atomic.Bool
	complete  bool
}

// No TempDir: testing's automatic deletion would destroy unknown evidence.
func newNativeProxyFixture(t *testing.T, ctx context.Context) *nativeProxyFixture {
	t.Helper()
	root, err := os.MkdirTemp("/private/tmp", "farol-proxy-")
	if err != nil {
		t.Fatal(err)
	}
	f := &nativeProxyFixture{ctx: ctx, root: root, boundary: NativeBoundary()}
	t.Logf("fresh synthetic proxy root: %s", root)
	t.Cleanup(func() { f.cleanup(t) })
	f.rootInfo, err = os.Lstat(root)
	if err != nil {
		t.Fatal(err)
	}
	s := testSelection() // Synthetic value witness only; replace every host path.
	s.ScratchRoot, s.ExecutablePath = filepath.Join(root, "s"), filepath.Join(root, "proxy")
	s.SocketPath, s.ExpectedCodexHome = filepath.Join(s.ScratchRoot, "p.sock"), filepath.Join(root, "unused-home")
	repo := filepath.Join(root, "repo")
	for _, dir := range []string{s.ScratchRoot, repo} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	gitCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	// Fresh fixture init ONLY; no existing checkout/config/hooks/templates.
	cmd := exec.CommandContext(gitCtx, "/usr/bin/git", "init", "--quiet", "--template=", repo)
	cmd.Env = []string{"HOME=" + root, "PATH=/usr/bin:/bin", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0"}
	cmd.Stdout, cmd.Stderr, cmd.WaitDelay = io.Discard, io.Discard, time.Second
	if err := cmd.Run(); err != nil {
		t.Fatal("fresh Git init refused/unknown; no retry", err)
	}
	_, stat, err := metadata(repo)
	if err != nil {
		t.Fatal(err)
	}
	s.Binding.Project = task.Root{Path: repo, Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10), GitCommonDirectory: filepath.Join(repo, ".git")}
	s.Binding.Writer = s.Binding.Project
	if err := os.WriteFile(s.ExecutablePath, []byte(nativeProxyFixtureImage), 0700); err != nil {
		t.Fatal(err)
	}
	s.ExecutableSHA256 = fmt.Sprintf("%x", sha256.Sum256([]byte(nativeProxyFixtureImage)))
	f.selection = s
	f.listen(t)
	f.record("synthetic selection=%+v", s)
	for _, path := range []string{root, repo, s.ScratchRoot, s.SocketPath, s.ExecutablePath} {
		_, stat, err := metadata(path)
		if err != nil {
			t.Fatal(err)
		}
		f.record("original path=%s identity=%s uid=%d", path, identity(stat), stat.Uid)
	}
	if err := f.boundary.Verify(ctx, s); err != nil {
		f.record("original Verify=%v", err)
		t.Fatal("original NativeBoundary Verify refused; no launch", err)
	}
	f.record("original Verify=known-valid")
	f.mu.Lock()
	logFailed := f.logFailed
	f.mu.Unlock()
	if logFailed {
		t.Fatal("original selection evidence unavailable; retain root, no launch")
	}
	return f
}

func (f *nativeProxyFixture) listen(t *testing.T) {
	t.Helper()
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: f.selection.SocketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	l.SetUnlinkOnClose(false) // Preserve the original socket inode on uncertainty.
	f.listeners = append(f.listeners, l)
}

// Local synthetic diagnostics, not a production receipt/schema or transcript.
func (f *nativeProxyFixture) record(format string, args ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	file, err := os.OpenFile(filepath.Join(f.root, "qualification.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		f.logFailed = true
		return
	}
	_, err = fmt.Fprintf(file, format+"\n", args...)
	closeErr := file.Close()
	f.logFailed = f.logFailed || err != nil || closeErr != nil
}

func (f *nativeProxyFixture) launch(ctx context.Context, s Selection) (Process, error) {
	f.mu.Lock()
	f.launched = true
	f.mu.Unlock()
	p, err := f.boundary.Launch(ctx, s) // ORIGINAL port, context and argv.
	native, _ := p.(*nativeProcess)
	f.mu.Lock()
	f.original = native
	f.mu.Unlock()
	f.record("original Launch process=%p error=%v", native, err)
	if err != nil || native == nil {
		f.retain.Store(true)
	}
	return p, err
}

func nativeProxyAwait(t *testing.T, ctx context.Context, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("bounded original observation incomplete; retain evidence", ctx.Err())
	}
}

func (f *nativeProxyFixture) ready(t *testing.T, p *nativeProcess) {
	t.Helper()
	if p == nil || p.cmd.Process == nil || p.cmd.Path != f.selection.ExecutablePath || p.cmd.Dir != f.selection.ScratchRoot ||
		!reflect.DeepEqual(p.cmd.Args, []string{f.selection.ExecutablePath, "app-server", "proxy", "--sock", f.selection.SocketPath}) ||
		!reflect.DeepEqual(p.cmd.Env, []string{"HOME=" + f.selection.ScratchRoot, "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "NO_COLOR=1", "TERM=dumb"}) || p.cmd.Cancel != nil {
		t.Fatal("original native child/selection missing or replaced")
	}
	f.record("original child PID=%d argv=%q cwd=%s", p.cmd.Process.Pid, p.cmd.Args, p.cmd.Dir)
	ctx, cancel := context.WithTimeout(f.ctx, 2*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		data, err := os.ReadFile(filepath.Join(f.selection.ScratchRoot, "child.pid"))
		if err == nil && string(data) == strconv.Itoa(p.cmd.Process.Pid)+"\n" {
			return // Trap installed before marker; no PID lookup/signal probe.
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal("child readiness evidence unreadable", err)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("original native child readiness unknown")
		}
	}
}

// Only observe the SAME existing cmd.Wait collector, never another Wait/signal.
func (f *nativeProxyFixture) observeExit(t *testing.T, p *nativeProcess) {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
	defer cancel()
	nativeProxyAwait(t, ctx, p.done)
	state := p.cmd.ProcessState // p.done synchronizes the original cmd.Wait.
	f.record("same child exit state=%v", state)
	data, err := os.ReadFile(filepath.Join(f.selection.ScratchRoot, "term.pid"))
	if state == nil || state.Pid() != p.cmd.Process.Pid || !state.Success() || err != nil || string(data) != strconv.Itoa(state.Pid())+"\n" {
		t.Fatal("exact child exit/TERM proof missing; no cleanup upgrade", err)
	}
}

func (f *nativeProxyFixture) cleanup(t *testing.T) {
	// Close exact test-owned socket handles once; never unlink unknown evidence.
	for _, l := range f.listeners {
		if err := l.Close(); err != nil {
			f.retain.Store(true)
			t.Error("original socket close unknown", err)
		}
	}
	f.mu.Lock()
	p, launched := f.original, f.launched
	f.mu.Unlock()
	exited := !launched
	if p != nil {
		// No cleanup signal. The fixture has its own finite self-exit even if a
		// test aborts before Close. A hard test timeout keeps the root by default.
		select {
		case <-p.done:
			exited = p.cmd.ProcessState != nil
		case <-time.After(12 * time.Second):
		}
	}
	f.record("cleanup same-child-exited=%t complete=%t retained-unknown=%t", exited, f.complete, f.retain.Load())
	f.mu.Lock()
	logFailed := f.logFailed
	f.mu.Unlock()
	if logFailed || !exited {
		t.Error("original evidence/exit collector incomplete; retain root")
	}
	if t.Failed() || !f.complete || f.retain.Load() || logFailed || !exited {
		t.Logf("RETAINED synthetic original evidence: %s; no retry/escalation/replacement", f.root)
		return
	}
	info, err := os.Lstat(f.root)
	real, realErr := filepath.EvalSymlinks(f.root)
	if err != nil || realErr != nil || real != f.root || !os.SameFile(f.rootInfo, info) {
		t.Error("fixture root changed; retain evidence")
		return
	}
	if err := os.RemoveAll(f.root); err != nil {
		t.Error("one owned fixture deletion unconfirmed; no retry", err)
	}
}

// Counting and a Launch RETURN barrier only. Every operation delegates to the
// SAME real nativeProcess, with no substituted result, context or executor.
type nativeProxyCounted struct {
	*nativeProcess
	fixture                      *nativeProxyFixture
	closes, waits, reads, writes atomic.Int32
	waitRemaining                atomic.Int64
	waitDeadline                 atomic.Int64
	waitHasDeadline              atomic.Bool
}

func (p *nativeProxyCounted) Read(b []byte) (int, error) {
	p.reads.Add(1)
	return p.nativeProcess.Read(b)
}
func (p *nativeProxyCounted) Write(b []byte) (int, error) {
	p.writes.Add(1)
	return p.nativeProcess.Write(b)
}
func (p *nativeProxyCounted) Close() error {
	p.closes.Add(1)
	err := p.nativeProcess.Close()
	p.fixture.record("original Process.Close=%v", err)
	if err != nil {
		p.fixture.retain.Store(true)
	}
	return err
}
func (p *nativeProxyCounted) Wait(ctx context.Context) error {
	p.waits.Add(1)
	deadline, ok := ctx.Deadline()
	p.waitHasDeadline.Store(ok)
	p.waitDeadline.Store(deadline.UnixNano())
	if !ok {
		p.fixture.retain.Store(true)
	}
	p.waitRemaining.Store(int64(time.Until(deadline)))
	err := p.nativeProcess.Wait(ctx)
	p.fixture.record("original Process.Wait deadline=%s error=%v", deadline.Format(time.RFC3339Nano), err)
	if err != nil {
		p.fixture.retain.Store(true)
	}
	return err
}

type nativeProxyRegistration struct {
	Boundary
	fixture           *nativeProxyFixture
	started, released chan struct{}
	once              sync.Once
	launches          atomic.Int32
	process           *nativeProxyCounted // Published by started; never replaced.
}

func (b *nativeProxyRegistration) Launch(ctx context.Context, s Selection) (Process, error) {
	if b.launches.Add(1) != 1 {
		b.fixture.retain.Store(true)
		b.fixture.record("unexpected second Launch blocked by counting instrumentation")
		return nil, task.ErrUnknown // Fail the count assertion; never start another child.
	}
	p, err := b.fixture.launch(ctx, s)
	if native, ok := p.(*nativeProcess); ok {
		b.process = &nativeProxyCounted{nativeProcess: native, fixture: b.fixture}
	}
	close(b.started)
	if err != nil || b.process == nil {
		return p, err
	}
	select {
	case <-b.released:
	case <-b.fixture.ctx.Done(): // Finite barrier; does not launch again.
	}
	return b.process, err
}
func (b *nativeProxyRegistration) release() { b.once.Do(func() { close(b.released) }) }

func nativeProxyLateRegistration(t *testing.T, ctx context.Context, expired bool) {
	f := newNativeProxyFixture(t, ctx)
	b := &nativeProxyRegistration{Boundary: f.boundary, fixture: f, started: make(chan struct{}), released: make(chan struct{})}
	t.Cleanup(b.release)
	c, err := New(Options{Selection: f.selection, Boundary: b, Now: func() time.Time { return f.selection.GrantedAt.Add(time.Minute) }, Recheck: func(context.Context, task.Binding) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	read := make(chan struct {
		err       error
		disclosed bool
	}, 1)
	go func() {
		out, err := c.Observe(ctx, f.selection.Binding, task.Reference{ThreadID: "synthetic-thread", TurnID: "synthetic-turn"})
		read <- struct {
			err       error
			disclosed bool
		}{err, out.Result != ""}
	}()
	nativeProxyAwait(t, ctx, b.started)
	if b.process == nil {
		t.Fatal("original native Launch failed; no replacement")
	}
	f.ready(t, b.process.nativeProcess)
	closed := make(chan error, 1)
	started := time.Now()
	go func() {
		err := c.Close(context.Background())
		f.record("original Client.Close=%v expired-registration=%t", err, expired)
		closed <- err
	}()
	nativeProxyAwait(t, ctx, c.lifetime.Done())
	c.mu.Lock()
	expectedDeadline, expectedHasDeadline := c.closeCtx.Deadline()
	c.mu.Unlock()
	var closeErr error
	if expired {
		f.retain.Store(true) // Retain this original unknown even after observed exit.
		select {
		case closeErr = <-closed:
		case <-ctx.Done():
			t.Fatal("original Close did not reach its bound")
		}
		if !errors.Is(closeErr, task.ErrUnknown) || time.Since(started) < 1800*time.Millisecond || time.Since(started) > 3*time.Second {
			t.Fatal("original unregistered cleanup lost its two-second bound", closeErr)
		}
	} else {
		select {
		case err := <-closed:
			t.Fatal("cleanup completed before original registration", err)
		default:
		}
	}
	if b.process.closes.Load() != 0 || b.process.waits.Load() != 0 {
		t.Fatal("cleanup invented a registered child")
	}
	b.release()
	nativeProxyAwait(t, ctx, c.closeDone)
	if !expired {
		select {
		case closeErr = <-closed:
		case <-ctx.Done():
			t.Fatal("original Close incomplete")
		}
		if closeErr != nil {
			t.Fatal("original cleanup unknown; retain evidence", closeErr)
		}
	}
	select {
	case result := <-read:
		if result.err == nil || result.disclosed {
			t.Fatal("closed original read succeeded or disclosed a result")
		}
	case <-ctx.Done():
		t.Fatal("closed read incomplete")
	}
	f.observeExit(t, b.process.nativeProcess)
	for i := 0; i < 2; i++ {
		err := c.Close(context.Background())
		if (!expired && err != nil) || (expired && !errors.Is(err, task.ErrUnknown)) {
			t.Fatal("retained original Close result changed", err)
		}
		if _, err := c.Observe(ctx, f.selection.Binding, task.Reference{ThreadID: "synthetic-thread", TurnID: "synthetic-turn"}); err == nil {
			t.Fatal("closed original admitted another read")
		}
	}
	c.mu.Lock()
	same := false
	if c.connection != nil {
		owned, ok := c.connection.process.(*clientProcess)
		same = ok && owned.Process == b.process && b.process.nativeProcess == f.original && c.attempted && !c.launching
	}
	c.mu.Unlock()
	remaining := time.Duration(b.process.waitRemaining.Load())
	if !same || !expectedHasDeadline || !b.process.waitHasDeadline.Load() || b.process.waitDeadline.Load() != expectedDeadline.UnixNano() || b.launches.Load() != 1 || b.process.closes.Load() != 1 || b.process.waits.Load() != 1 || b.process.reads.Load() != 0 || b.process.writes.Load() != 0 || remaining > 2*time.Second || expired && remaining > 0 {
		t.Fatal("original process replaced, repeated, performed IO or renewed cleanup budget")
	}
	f.complete = true
}

func TestNativeOriginalProxyLifetimeQualification(t *testing.T) {
	if os.Getenv("FAROL_TASK_NATIVE_PROXY_QUALIFICATION") != "1" {
		t.Skip("Lead-only native lane: set FAROL_TASK_NATIVE_PROXY_QUALIFICATION=1 and select this exact target; SKIP is not qualification")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if !t.Run("original-close-wait", func(t *testing.T) {
		f := newNativeProxyFixture(t, ctx)
		process, err := f.launch(ctx, f.selection)
		p, ok := process.(*nativeProcess)
		if err != nil || !ok {
			t.Fatal("original native Launch refused/unknown", err)
		}
		f.ready(t, p)
		err = p.Close()
		f.record("original Process.Close=%v", err)
		if err != nil {
			f.retain.Store(true)
			t.Fatal("original termination unknown", err)
		}
		waitCtx, waitCancel := context.WithTimeout(ctx, 2*time.Second)
		defer waitCancel()
		err = p.Wait(waitCtx)
		f.record("original Process.Wait=%v", err)
		if err != nil {
			f.retain.Store(true)
			t.Fatal("original exit unknown", err)
		}
		f.observeExit(t, p)
		f.complete = true
	}) {
		return
	}
	for _, changed := range []string{"executable", "socket", "root"} {
		if !t.Run("verify-changed-"+changed, func(t *testing.T) {
			f := newNativeProxyFixture(t, ctx)
			s := f.selection
			var err error
			switch changed {
			case "executable":
				err = os.WriteFile(s.ExecutablePath, []byte(nativeProxyFixtureImage+"# changed\n"), 0700)
			case "socket":
				err = os.Rename(s.SocketPath, s.SocketPath+"-original")
				if err == nil {
					f.listen(t)
				}
			case "root":
				err = os.Rename(s.Binding.Project.Path, s.Binding.Project.Path+"-original")
				if err == nil {
					err = os.Mkdir(s.Binding.Project.Path, 0700)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			err = f.boundary.Verify(ctx, s)
			f.record("changed %s Verify=%v; Launch not invoked", changed, err)
			if !errors.Is(err, task.ErrIdentity) {
				t.Fatal("changed physical selection accepted", err)
			}
			if _, err := os.Lstat(filepath.Join(s.ScratchRoot, "child.pid")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("negative Verify launched a child")
			}
			f.complete = true
		}) {
			return
		}
	}
	if !t.Run("late-original-registration", func(t *testing.T) { nativeProxyLateRegistration(t, ctx, false) }) {
		return
	}
	// Last: retained original cleanup uncertainty must never cause another launch.
	t.Run("expired-original-registration-retained", func(t *testing.T) { nativeProxyLateRegistration(t, ctx, true) })
}
