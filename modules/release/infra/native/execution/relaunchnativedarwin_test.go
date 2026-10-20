//go:build darwin

package execution

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	stdruntime "runtime"
	"syscall"
	"testing"
	"time"
)

// Native witnesses for post-launch image verification. They are gated and run
// real kernel observation (sysctl, csops, proc_info) against real scratch
// processes. They never run Farol, Electron or any installed app, and they
// signal only the exact pid they started.
//
// What is NOT exercised here: LaunchServices. The identity policy requires the
// production bundle id, which an owner's running Farol also carries, so a
// scratch bundle launched through /usr/bin/open would collide with it. The
// platform's open is therefore replaced by a direct exec of the scratch
// executable with the very argument open would pass; the verified-image
// derivation, the fence order and every kernel read are the production ones.
func requireNative(t *testing.T) {
	t.Helper()
	if os.Getenv("FAROL_RELAUNCH_NATIVE") != "1" {
		t.Skip("set FAROL_RELAUNCH_NATIVE=1 to run the real-kernel relaunch witnesses")
	}
}

// spawnPlatform is the production native platform with only open replaced.
type spawnPlatform struct {
	nativePlatform
	app     string
	swap    func() // between the first fence and the exec
	restore func() // between the exec and the second fence
	opens   int
	cmd     *exec.Cmd
	reaped  chan struct{}
	t       *testing.T
}

func (p *spawnPlatform) open(ctx context.Context, _ time.Time, arguments []string, fence func(context.Context) error) error {
	p.opens++
	if err := fence(ctx); err != nil {
		return err
	}
	if p.swap != nil {
		p.swap()
	}
	cmd := exec.Command(p.app+"/Contents/MacOS/Sleeper", arguments[4])
	cmd.Dir, cmd.Env = "/", []string{"PATH=/usr/bin:/bin"}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.cmd, p.reaped = cmd, make(chan struct{})
	reaped := p.reaped
	go func() { _ = cmd.Wait(); close(reaped) }()
	p.t.Cleanup(func() {
		// Exact pid only; a no-op once the process is already gone.
		_ = cmd.Process.Kill()
		<-reaped
	})
	if p.restore != nil {
		// Measured: the host kills a just-exec'd process whose executable path
		// vanishes within roughly half a second (about 40% of runs at once).
		// That is a harness artifact of putting the tree back, not a verifier
		// effect, so the restore waits it out.
		time.Sleep(600 * time.Millisecond)
		p.restore()
	}
	return fence(ctx)
}

func (p *spawnPlatform) gone() bool {
	select {
	case <-p.reaped:
	case <-time.After(5 * time.Second):
		return false
	}
	return errors.Is(syscall.Kill(p.cmd.Process.Pid, 0), syscall.ESRCH)
}

func (p *spawnPlatform) alive() bool {
	select {
	case <-p.reaped:
		return false
	default:
		return syscall.Kill(p.cmd.Process.Pid, 0) == nil
	}
}

func rename(t *testing.T, from, to string) {
	t.Helper()
	must(t, os.Rename(from, to))
}

func TestNativeLaunchVerification(t *testing.T) {
	requireNative(t)
	good := scratchExecutable(t, "good", stdruntime.GOARCH, "")
	impostor := scratchExecutable(t, "impostor", stdruntime.GOARCH, "")
	for _, tc := range []struct {
		name     string
		bundle   string // executable of the bundle swapped in; empty means no swap
		mismatch bool
	}{
		{"control without a swap", "", false},
		{"swapped bundle with different code", impostor, true},
		{"swapped bundle with identical code on another object", good, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			platform := &spawnPlatform{t: t}
			fx := newRelaunchFixture(t, platform, good)
			platform.app = fx.app
			aside, intruder := fx.app+".verified", fx.app+".intruder"
			if tc.bundle != "" {
				platform.swap = func() {
					// The verified bundle moves away; a differently built one is
					// installed at the same path just before the exec.
					rename(t, fx.app, aside)
					writeBundle(t, fx.app, tc.bundle)
				}
				platform.restore = func() {
					// The writer puts the verified tree back before the second
					// held-tree check, so only the process itself differs.
					rename(t, fx.app, intruder)
					rename(t, aside, fx.app)
				}
			}
			method, _ := fx.launch(t)
			if platform.opens != 1 || platform.cmd == nil {
				t.Fatal("expected exactly one launch", platform.opens)
			}
			if !tc.mismatch {
				if method != nil {
					t.Fatal("control harness refused an unmutated launch", method)
				}
				if !platform.alive() {
					t.Fatal("the verified process was not left running")
				}
				return
			}
			failure := recoveryFailure(t, method)
			if failure.Code != "launch_image_mismatch" || failure.Uncertain || failure.Internal {
				t.Fatalf("not a definite mismatch: code=%s uncertain=%v cause=%#v", failure.Code, failure.Uncertain, failure.Cause)
			}
			if !platform.gone() {
				t.Fatal("the substituted process is still running")
			}
			if digest := treeDigest(t, fx.app); digest != fx.config.Request.Target.Digest {
				t.Fatal("the verified image was not retained intact")
			}
			if _, err := os.Stat(intruder); err != nil {
				t.Fatal("the substituted bundle was not retained", err)
			}
			if fx.phase(t) != "launch_requested" {
				t.Fatal("mismatch moved the journal")
			}
		})
	}
}

// The OS primitives alone: a real process found by its exact argument, and its
// kernel identity equal to the identity derived from the executable on disk.
func TestNativePlatformObservesARealProcess(t *testing.T) {
	requireNative(t)
	good := scratchExecutable(t, "good", stdruntime.GOARCH, "")
	nonce := make([]byte, 12)
	_, err := rand.Read(nonce)
	must(t, err)
	hint := "--farol-installed-update-relaunch=native-" + hex.EncodeToString(nonce)
	start := func() *exec.Cmd {
		cmd := exec.Command(good, hint)
		cmd.Dir, cmd.Env = "/", []string{"PATH=/usr/bin:/bin"}
		must(t, cmd.Start())
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		t.Cleanup(func() { _ = cmd.Process.Kill(); <-done })
		return cmd
	}
	p := nativeLaunchPlatform()
	if pids, err := p.candidates(context.Background(), hint); err != nil || len(pids) != 0 {
		t.Fatal("candidates before any launch", pids, err)
	}
	first := start()
	pid := first.Process.Pid
	var pids []int
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if pids, err = p.candidates(context.Background(), hint); err != nil || len(pids) == 1 {
			break
		}
	}
	if err != nil || len(pids) != 1 || pids[0] != pid {
		t.Fatal("exact argument not found", pids, err)
	}
	if pids, _ := p.candidates(context.Background(), hint+"x"); len(pids) != 0 {
		t.Fatal("a longer argument matched", pids)
	}
	held, err := os.Open(good)
	must(t, err)
	defer held.Close()
	st, err := fstat(held)
	must(t, err)
	expected, err := imageOf(held, stdruntime.GOARCH)
	must(t, err)
	live, err := p.image(pid)
	must(t, err)
	if live.Image != expected || live.Image.Inode != uint64(st.Ino) {
		t.Fatalf("kernel identity %+v differs from the executable's %+v", live.Image, expected)
	}
	again, err := p.start(pid)
	must(t, err)
	if again != live.Start || live.Start.Seconds == 0 {
		t.Fatal("birth time unstable", again, live.Start)
	}
	// A second process with the same argument makes the nonce ambiguous.
	second := start()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if pids, err = p.candidates(context.Background(), hint); err != nil || len(pids) == 2 {
			break
		}
	}
	if err != nil || len(pids) != 2 {
		t.Fatal("two holders not both found", pids, err)
	}
	if err := p.kill(second.Process.Pid); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if _, err := p.start(second.Process.Pid); errors.Is(err, errProcessGone) {
			return
		}
	}
	t.Fatal("killed process still has a start time")
}

// compile-time check that the native seam satisfies the private port
var _ launchPlatform = (*spawnPlatform)(nil)
