//go:build darwin

package desktop

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	desktopapp "github.com/legrch/farol/modules/release/app/services/desktop"
	"golang.org/x/sys/unix"
)

func TestLifetimeObservationFailureHoldsUntilExplicitTermination(t *testing.T) {
	signals := make(chan os.Signal, 1)
	terminal := make(chan int, 1)
	var diagnostics bytes.Buffer
	started := make(chan struct{})
	go func() { close(started); terminal <- holdUncertain(nil, true, signals, &diagnostics) }()
	<-started
	select {
	case code := <-terminal:
		t.Fatalf("observation failure released custody: %d", code)
	default:
	}
	// This is a channel value, never a signal to the test/host process.
	signals <- syscall.SIGTERM
	if code := <-terminal; code != 143 {
		t.Fatalf("explicit abort code: %d", code)
	}
	if !strings.Contains(diagnostics.String(), "lifetime_held_until_explicit_termination") {
		t.Fatal(diagnostics.String())
	}
}

// Subprocess actors exercise the production lifetime loop with real native
// process events. They have no LaunchServices, updater, profile or GUI claim.
func TestLifetimeActor(t *testing.T) {
	role := os.Getenv("FAROL_LIFETIME_TEST_ACTOR")
	if role == "" {
		return
	}
	root := os.Getenv("FAROL_LIFETIME_TEST_ROOT")
	executable, _ := os.Executable()
	actor := func(role string) *exec.Cmd {
		c := exec.Command(executable, "-test.run=^TestLifetimeActor$")
		c.Env = append(withoutActorEnvironment(os.Environ()), "FAROL_LIFETIME_TEST_ACTOR="+role, "FAROL_LIFETIME_TEST_ROOT="+root)
		c.Stdout, c.Stderr = os.Stdout, os.Stderr
		return c
	}
	if role == "diagnostics" {
		diagnostics, release := nonFatalDiagnostics(os.Stderr)
		_, _ = io.WriteString(diagnostics, "closed diagnostic observer\n")
		release()
		os.Exit(0)
	}
	if role == "helper" {
		// The fixture's Go desktop does not have libuv's spawn fd closure.
		// Model the production helper's explicit fd layout: no guardian channel.
		_ = unix.Close(7)
		_ = unix.Close(8)
		pid, _ := strconv.Atoi(os.Getenv("FAROL_LIFETIME_TEST_PREDECESSOR"))
		q, err := unix.Kqueue()
		if err != nil {
			os.Exit(71)
		}
		defer unix.Close(q)
		if arm(q, pid) != nil {
			os.Exit(72)
		}
		if os.WriteFile(filepath.Join(root, "helper-armed"), nil, 0600) != nil {
			os.Exit(73)
		}
		var event [1]unix.Kevent_t
		until := unix.NsecToTimespec(int64(5 * time.Second))
		n, err := unix.Kevent(q, nil, event[:], &until)
		if err != nil || n != 1 || event[0].Fflags&unix.NOTE_EXIT == 0 {
			os.Exit(74)
		}
		// Test-only delayed completion discriminates a real guardian from an
		// exec launcher. Production lifetime never depends on this sleep.
		time.Sleep(80 * time.Millisecond)
		if os.WriteFile(filepath.Join(root, "helper-finished"), nil, 0600) != nil {
			os.Exit(75)
		}
		os.Exit(0)
	}
	if role == "desktop" {
		helper := actor("helper")
		helper.Env = append(helper.Env, fmt.Sprintf("FAROL_LIFETIME_TEST_PREDECESSOR=%d", os.Getpid()))
		if helper.Start() != nil {
			os.Exit(76)
		}
		until := time.Now().Add(3 * time.Second)
		for {
			if _, err := os.Stat(filepath.Join(root, "helper-armed")); err == nil {
				break
			}
			if time.Now().After(until) {
				os.Exit(77)
			}
			time.Sleep(time.Millisecond)
		}
		_, binding := nativeBinding(t, helper)
		binding.Deadline = until.UnixMilli()
		frame, _ := json.Marshal(binding)
		metadata, ack := os.NewFile(7, "metadata"), os.NewFile(8, "ack")
		if os.Getenv("FAROL_LIFETIME_TEST_DROP_ACK") == "1" {
			ack.Close()
		}
		if _, err := metadata.Write(append(frame, '\n')); err != nil {
			os.Exit(78)
		}
		if os.Getenv("FAROL_LIFETIME_TEST_DROP_ACK") == "1" {
			for {
				if _, err := os.Stat(filepath.Join(root, "ack-lost")); err == nil {
					os.Exit(0)
				}
				if time.Now().After(until) {
					os.Exit(84)
				}
				time.Sleep(time.Millisecond)
			}
		}
		_ = ack.SetReadDeadline(until)
		line, err := bufio.NewReader(ack).ReadBytes('\n')
		if err != nil || !bytes.Equal(line, append(frame, '\n')) {
			os.Exit(79)
		}
		os.Exit(0)
	}
	if strings.HasPrefix(role, "quit-desktop-") {
		// A desktop that announces (or not) a drained Quit, then either hangs
		// ignoring SIGTERM like a stuck exit teardown, or exits on its own.
		signal.Ignore(syscall.SIGTERM)
		metadata := os.NewFile(7, "metadata")
		switch role {
		case "quit-desktop-silent":
		case "quit-desktop-truncated":
			// Body without its newline, then the channel closes: never a frame.
			_, _ = metadata.Write(quitFrame)
			metadata.Close()
		case "quit-desktop-crlf":
			_, _ = metadata.Write(append(append([]byte(nil), quitFrame...), '\r', '\n'))
		default:
			if _, err := metadata.Write(append(quitFrame, '\n')); err != nil {
				os.Exit(85)
			}
		}
		// Witness for the test clock: written after the frame (or its absence).
		_ = os.WriteFile(filepath.Join(root, "announced"), nil, 0600)
		if role == "quit-desktop-hang" || role == "quit-desktop-truncated" || role == "quit-desktop-crlf" {
			time.Sleep(time.Hour)
		}
		// Announced: exit well inside the grace. Silent: outlive the grace, which
		// alone never authorizes a kill.
		if role == "quit-desktop-exit" {
			time.Sleep(50 * time.Millisecond)
			os.Exit(0)
		}
		// Silent: a stuck child that never announced a drained Quit. Elapsed
		// time alone must not kill it; the test ends it via the group.
		time.Sleep(time.Hour)
	}
	if strings.HasPrefix(role, "quit-guardian-") {
		quitExitGrace = 200 * time.Millisecond
		if role == "quit-guardian-exit" {
			// Ample margin: a race-instrumented child exits slowly.
			quitExitGrace = 3 * time.Second
		}
		q, err := unix.Kqueue()
		if err != nil {
			os.Exit(80)
		}
		defer unix.Close(q)
		r, w, _ := os.Pipe()
		ar, aw, _ := os.Pipe()
		c := actor("quit-desktop-" + strings.TrimPrefix(role, "quit-guardian-"))
		c.ExtraFiles = []*os.File{nil, nil, nil, nil, w, ar}
		if c.Start() != nil {
			os.Exit(81)
		}
		w.Close()
		ar.Close()
		desktop, err := snapshot(c.Process.Pid)
		if err != nil || arm(q, c.Process.Pid) != nil {
			c.Process.Kill()
			c.Wait()
			os.Exit(82)
		}
		os.Exit(hold(c, desktop, q, r, aw, os.Stderr, desktopapp.Valid))
	}
	if role == "guardian" || role == "guardian-lost-ack" || role == "guardian-closed-diagnostics" {
		q, err := unix.Kqueue()
		if err != nil {
			os.Exit(80)
		}
		defer unix.Close(q)
		r, w, _ := os.Pipe()
		ar, aw, _ := os.Pipe()
		defer r.Close()
		defer aw.Close()
		c := actor("desktop")
		if role == "guardian-lost-ack" {
			c.Env = append(c.Env, "FAROL_LIFETIME_TEST_DROP_ACK=1")
		}
		c.ExtraFiles = []*os.File{nil, nil, nil, nil, w, ar}
		if c.Start() != nil {
			os.Exit(81)
		}
		w.Close()
		ar.Close()
		desktop, err := snapshot(c.Process.Pid)
		if err != nil || arm(q, c.Process.Pid) != nil {
			c.Process.Kill()
			c.Wait()
			os.Exit(82)
		}
		var diagnostics io.Writer = ackLossReporter{root: root}
		if role == "guardian-closed-diagnostics" {
			diagnostics = os.Stderr
		}
		os.Exit(hold(c, desktop, q, r, aw, diagnostics, desktopapp.Valid))
	}
	os.Exit(83)
}

type ackLossReporter struct{ root string }

func (w ackLossReporter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("desktop_launcher_ack_unknown")) {
		if err := os.WriteFile(filepath.Join(w.root, "ack-lost"), nil, 0600); err != nil {
			return 0, err
		}
	}
	return os.Stderr.Write(p)
}

func withoutActorEnvironment(env []string) []string {
	var out []string
	for _, v := range env {
		if !strings.HasPrefix(v, "FAROL_LIFETIME_TEST_ACTOR=") {
			out = append(out, v)
		}
	}
	return out
}

func TestLifetimeNativeGuardianWaitsForHelperAfterDesktopExit(t *testing.T) {
	testGuardianActor(t, "guardian")
}

func TestLifetimeNativeLostACKKeepsOriginalHelperCustody(t *testing.T) {
	testGuardianActor(t, "guardian-lost-ack")
}

func TestLifetimeNativeClosedDiagnosticsKeepsHelperCustody(t *testing.T) {
	testGuardianActor(t, "guardian-closed-diagnostics")
}

func TestLifetimeNativeClosedDiagnosticsDoesNotRaiseSIGPIPE(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	defer w.Close()
	executable, _ := os.Executable()
	c := exec.Command(executable, "-test.run=^TestLifetimeActor$")
	c.Env = append(os.Environ(), "FAROL_LIFETIME_TEST_ACTOR=diagnostics")
	c.Stderr = w
	if err := c.Run(); err != nil {
		t.Fatalf("closed diagnostics terminated the original child: %v", err)
	}
}

func testGuardianActor(t *testing.T, role string) {
	t.Helper()
	root, err := os.MkdirTemp("", "farol-lifetime-loop-")
	if err != nil {
		t.Fatal(err)
	}
	// Unknown actor cleanup retains its evidence, rather than deleting a live
	// actor's directory in t.TempDir teardown.
	t.Log("native actor evidence:", root)
	executable, _ := os.Executable()
	c := exec.Command(executable, "-test.run=^TestLifetimeActor$")
	c.Env = append(os.Environ(), "FAROL_LIFETIME_TEST_ACTOR="+role, "FAROL_LIFETIME_TEST_ROOT="+root)
	var out bytes.Buffer
	c.Stdout, c.Stderr = &out, &out
	if role == "guardian-closed-diagnostics" {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		r.Close()
		defer w.Close()
		c.Stderr = w
	}
	if err := c.Run(); err != nil {
		t.Fatalf("guardian actor: %v %s", err, out.String())
	}
	if _, err := os.Stat(filepath.Join(root, "helper-finished")); err != nil {
		t.Fatalf("guardian retired before helper: %v %s", err, out.String())
	}
	if role != "guardian-closed-diagnostics" && (!strings.Contains(out.String(), "desktop_launcher_desktop_exit") || !strings.Contains(out.String(), "desktop_launcher_helper_exit") || !strings.Contains(out.String(), "waitStatus=0")) {
		t.Fatal(out.String())
	}
	if role == "guardian-lost-ack" && !strings.Contains(out.String(), "desktop_launcher_ack_unknown") {
		t.Fatal("ACK loss was not observed", out.String())
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
}

func nativeBinding(t *testing.T, helper *exec.Cmd) (identity, port.DesktopLifetimeBinding) {
	t.Helper()
	desktop, err := snapshot(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	h, err := snapshot(helper.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	return desktop, port.DesktopLifetimeBinding{Schema: "farol.desktop-helper-lifetime/1", OperationID: strings.Repeat("a", 32), Action: "apply", Location: "shared",
		Source:      port.DesktopLifetimeBuild{BuildID: strings.Repeat("b", 64), Digest: strings.Repeat("c", 64), Version: "0.5.2"},
		Target:      port.DesktopLifetimeBuild{BuildID: strings.Repeat("d", 64), Digest: strings.Repeat("e", 64), Version: "0.5.3"},
		Predecessor: port.DesktopLifetimeProcess{PID: desktop.pid, Start: desktop.start()}, Helper: port.DesktopLifetimeProcess{PID: h.pid, Start: h.start()}, Deadline: time.Now().Add(time.Second).UnixMilli()}
}

func child(t *testing.T) *exec.Cmd {
	t.Helper()
	c := exec.Command("/bin/cat")
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	c.Stdin = r
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	r.Close()
	t.Cleanup(func() {
		w.Close()
		if c.ProcessState == nil {
			if err := c.Wait(); err != nil {
				t.Error(err)
			}
		}
	})
	return c
}

func TestLifetimeCanonicalFrameAndDeadline(t *testing.T) {
	c := child(t)
	desktop, b := nativeBinding(t, c)
	line, _ := json.Marshal(b)
	if _, err := parse(line, desktop.pid, time.Now().UnixMilli(), desktopapp.Valid); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]byte{
		append(append([]byte(nil), line...), line...),
		[]byte(strings.Replace(string(line), `"action":"apply"`, `"action":"apply","action":"apply"`, 1)),
		[]byte(strings.Replace(string(line), `"action":"apply"`, `"action":"apply","extra":1`, 1)),
		append(make([]byte, frameLimit), line...),
	} {
		if _, err := parse(invalid, desktop.pid, time.Now().UnixMilli(), desktopapp.Valid); err == nil {
			t.Fatal("malformed frame accepted")
		}
	}
	if _, err := parse(line, desktop.pid, b.Deadline, desktopapp.Valid); err == nil {
		t.Fatal("late binding accepted")
	}
}

func TestLifetimeNativeEnrollmentObservesOriginalTerminal(t *testing.T) {
	c := child(t)
	desktop, b := nativeBinding(t, c)
	queue, err := unix.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(queue)
	if err := enroll(queue, desktop, b); err != nil {
		t.Fatal(err)
	}
	// No production process is controlled. This is the retained test child,
	// still unreaped, terminated once to witness its actual kernel event.
	if err := c.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	var events [1]unix.Kevent_t
	timeout := unix.NsecToTimespec(int64(time.Second))
	n, err := unix.Kevent(queue, nil, events[:], &timeout)
	if err != nil || n != 1 || int(events[0].Ident) != c.Process.Pid || events[0].Fflags&unix.NOTE_EXIT == 0 {
		t.Fatalf("original terminal missing: %d %v", n, err)
	}
	// Cleanup's Wait observes the deliberate signal; this is not helper success.
	if err := c.Wait(); err == nil {
		t.Fatal("expected signaled fixture")
	}
}

func TestLifetimeNativeEnrollmentRefusesBirthAndPredecessorDrift(t *testing.T) {
	c := child(t)
	desktop, b := nativeBinding(t, c)
	queue, err := unix.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(queue)
	b.Helper.Start = "wrong"
	if enroll(queue, desktop, b) == nil {
		t.Fatal("helper birth drift accepted")
	}
	b.Helper.Start, b.Predecessor.Start = desktop.start(), "wrong"
	if enroll(queue, desktop, b) == nil {
		t.Fatal("predecessor drift accepted")
	}
	desktop.micros++
	if enroll(queue, desktop, b) == nil {
		t.Fatal("kernel predecessor drift accepted")
	}
}

// A drained desktop that hangs in exit is killed by its own launcher after the
// grace; an announced or silent desktop that exits by itself is never killed,
// and a silent hang is never touched by elapsed time alone.
func TestLifetimeNativeQuitExitWatchdog(t *testing.T) {
	executable, _ := os.Executable()
	run := func(role string, limit time.Duration) (string, error, time.Duration) {
		root := t.TempDir()
		c := exec.Command(executable, "-test.run=^TestLifetimeActor$")
		c.Env = append(os.Environ(), "FAROL_LIFETIME_TEST_ACTOR="+role, "FAROL_LIFETIME_TEST_ROOT="+root)
		// Own group: the timeout path ends guardian and desktop together and
		// releases the inherited output pipe.
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		var out bytes.Buffer
		c.Stdout, c.Stderr = &out, &out
		start := time.Now()
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- c.Wait() }()
		announced := func() time.Duration {
			info, err := os.Stat(filepath.Join(root, "announced"))
			if err != nil {
				t.Fatalf("%s: desktop never reached its announcement: %s", role, out.String())
			}
			return time.Since(info.ModTime())
		}
		_ = start
		select {
		case err := <-done:
			return out.String(), err, announced()
		case <-time.After(limit):
			// Kill the whole guardian group: the silent hang must survive.
			_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
			_ = c.Process.Kill()
			<-done
			return out.String(), errors.New("timeout"), announced()
		}
	}
	out, err, took := run("quit-guardian-hang", 10*time.Second)
	if err != nil || !strings.Contains(out, "watchdog=true") {
		t.Fatalf("hung drained desktop was not finished: %v\n%s", err, out)
	}
	if took < 200*time.Millisecond {
		t.Fatalf("killed before the grace measured from the frame: %v", took)
	}
	out, err, _ = run("quit-guardian-exit", 10*time.Second)
	if err != nil || strings.Contains(out, "watchdog=true") {
		t.Fatalf("a desktop that exited on its own was killed: %v\n%s", err, out)
	}
	for _, role := range []string{"quit-guardian-silent", "quit-guardian-truncated", "quit-guardian-crlf"} {
		out, err, _ = run(role, 1500*time.Millisecond)
		if err == nil || err.Error() != "timeout" || strings.Contains(out, "watchdog=true") {
			t.Fatalf("%s: a desktop without an exact frame was killed: %v\n%s", role, err, out)
		}
	}
}
