//go:build darwin

// Package desktop owns only the LaunchServices root's lifetime. The
// Electron child remains the updater predecessor and the single desktop owner.
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
	"strings"
	"syscall"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"golang.org/x/sys/unix"
)

const frameLimit = 4096
const bindingLimit = 64

type identity struct {
	pid     int
	parent  int
	seconds int64
	micros  int32
}

func snapshot(pid int) (identity, error) {
	p, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || p == nil || int(p.Proc.P_pid) != pid {
		return identity{}, errors.New("desktop_launcher_identity_unknown")
	}
	return identity{pid: pid, parent: int(p.Eproc.Ppid), seconds: p.Proc.P_starttime.Sec, micros: p.Proc.P_starttime.Usec}, nil
}

func (p identity) start() string {
	return time.Unix(p.seconds, int64(p.micros)*1000).Local().Format("Mon Jan _2 15:04:05 2006")
}

// The kernel queue observes without reaping. Only the event-loop owner may
// signal or Wait the retained child: Go 1.26's Darwin Signal/Wait race otherwise
// permits a reused PID to receive the forwarded signal.
func arm(queue, pid int) error {
	change := unix.Kevent_t{Ident: uint64(pid), Filter: unix.EVFILT_PROC,
		Flags:  unix.EV_ADD | unix.EV_ONESHOT | unix.EV_RECEIPT,
		Fflags: unix.NOTE_EXIT | unix.NOTE_EXITSTATUS | unix.NOTE_EXIT_DETAIL}
	var receipt [1]unix.Kevent_t
	n, err := unix.Kevent(queue, []unix.Kevent_t{change}, receipt[:], nil)
	if err != nil || n != 1 || receipt[0].Ident != uint64(pid) || receipt[0].Filter != unix.EVFILT_PROC || receipt[0].Flags&unix.EV_ERROR == 0 || receipt[0].Data != 0 {
		return errors.New("desktop_launcher_observation_unavailable")
	}
	return nil
}

func parse(line []byte, desktop int, now int64, validate func(port.DesktopLifetimeBinding, int, int64) bool) (port.DesktopLifetimeBinding, error) {
	var b port.DesktopLifetimeBinding
	d := json.NewDecoder(bytes.NewReader(line))
	d.DisallowUnknownFields()
	if validate == nil || len(line) > frameLimit || d.Decode(&b) != nil || !validate(b, desktop, now) {
		return b, errors.New("desktop_launcher_binding_invalid")
	}
	// One canonical frame excludes duplicate keys, trailing values and silent
	// field normalization. The inherited channel is never renderer-controlled.
	canonical, err := json.Marshal(b)
	if err != nil || !bytes.Equal(line, canonical) {
		return b, errors.New("desktop_launcher_binding_noncanonical")
	}
	return b, nil
}

func enroll(queue int, desktop identity, b port.DesktopLifetimeBinding) error {
	current, err := snapshot(desktop.pid)
	if err != nil || current != desktop || b.Predecessor.Start != desktop.start() {
		return errors.New("desktop_launcher_predecessor_changed")
	}
	helper, err := snapshot(b.Helper.PID)
	if err != nil || helper.parent != desktop.pid || helper.start() != b.Helper.Start {
		return errors.New("desktop_launcher_helper_changed")
	}
	if err := arm(queue, helper.pid); err != nil {
		return err
	}
	// Check the kernel microsecond start as well as the legacy lstart token.
	// An exit/reuse during registration cannot acquire observation custody.
	current, err = snapshot(helper.pid)
	if err != nil || current != helper || time.Now().UnixMilli() >= b.Deadline {
		return errors.New("desktop_launcher_helper_changed")
	}
	return nil
}

// Run starts the already packaged runtime. executable is captured before any
// update can replace canonical bundle paths. No path is executed after Quit.
func Run(executable string, args []string, input, output *os.File, diagnostics io.Writer, validate func(port.DesktopLifetimeBinding, int, int64) bool) int {
	if validate == nil {
		return 78
	}
	contents := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	if filepath.Base(executable) != "farol-backend" || !filepath.IsAbs(executable) || filepath.Base(filepath.Dir(executable)) != "app" || filepath.Base(filepath.Dir(filepath.Dir(executable))) != "Resources" || filepath.Base(contents) != "Contents" {
		_, _ = io.WriteString(diagnostics, "desktop_launcher_location_invalid\n")
		return 78
	}
	queue, err := unix.Kqueue()
	if err != nil {
		return 78
	}
	unix.CloseOnExec(queue)
	defer unix.Close(queue)
	metadata, childMetadata, err := os.Pipe()
	if err != nil {
		return 78
	}
	defer metadata.Close()
	defer childMetadata.Close()
	childACK, ack, err := os.Pipe()
	if err != nil {
		return 78
	}
	defer childACK.Close()
	defer ack.Close()
	runtime := filepath.Join(contents, "Frameworks", "Electron Runtime.app", "Contents", "MacOS", "Electron")
	command := exec.Command(runtime, append([]string{filepath.Join(contents, "Resources", "app")}, args...)...)
	command.Stdin, command.Stdout, command.Stderr = input, output, diagnostics
	command.Env = append(withoutLifetimeEnvironment(os.Environ()), "ELECTRON_FORCE_IS_PACKAGED=true", "FAROL_DESKTOP_LIFETIME=1")
	// Electron fd7/8 are this private metadata/ACK channel. Helper fd3/4 and
	// borrowed promotion lease/continue fd5/6 keep their existing meanings.
	command.ExtraFiles = []*os.File{nil, nil, nil, nil, childMetadata, childACK}
	if command.Start() != nil {
		return 78
	}
	childMetadata.Close()
	childACK.Close()
	desktop, err := snapshot(command.Process.Pid)
	if err != nil || desktop.parent != os.Getpid() || arm(queue, command.Process.Pid) != nil {
		// No updater request can have been accepted. Kill this retained, unreaped
		// child once, then reap synchronously; never look it up after Wait.
		_ = command.Process.Kill()
		_ = command.Wait()
		return 78
	}
	return hold(command, desktop, queue, metadata, ack, diagnostics, validate)
}

func withoutLifetimeEnvironment(env []string) []string {
	result := make([]string, 0, len(env))
	for _, v := range env {
		if !strings.HasPrefix(v, "FAROL_DESKTOP_LIFETIME=") && !strings.HasPrefix(v, "ELECTRON_FORCE_IS_PACKAGED=") {
			result = append(result, v)
		}
	}
	return result
}

func hold(command *exec.Cmd, desktop identity, queue int, metadata, ack *os.File, diagnostics io.Writer, validate func(port.DesktopLifetimeBinding, int, int64) bool) int {
	frames := make(chan []byte)
	done := make(chan struct{})
	readerDone := make(chan struct{})
	defer func() { metadata.Close(); close(done); <-readerDone }()
	go func() {
		defer close(readerDone)
		defer close(frames)
		s := bufio.NewScanner(metadata)
		s.Buffer(make([]byte, frameLimit+1), frameLimit+1)
		for s.Scan() {
			line := append([]byte(nil), s.Bytes()...)
			select {
			case frames <- line:
			case <-done:
				return
			}
		}
	}()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	seen := make(map[string]bool)
	helpers := make(map[int]string)
	exited, status := false, 0
	for {
		select {
		case sig := <-signals:
			if exited {
				// An explicit termination of this root after desktop exit aborts
				// lifetime custody. It is not helper completion or OTA success.
				_, _ = io.WriteString(diagnostics, "desktop_launcher_terminated_with_helper\n")
				return 128 + int(sig.(syscall.Signal))
			}
			_ = command.Process.Signal(sig) // same owner, before the sole Wait
		case line, ok := <-frames:
			if !ok {
				frames = nil
				break
			}
			b, err := parse(line, desktop.pid, time.Now().UnixMilli(), validate)
			if err == nil && (exited || len(seen) >= bindingLimit || seen[b.OperationID] || helpers[b.Helper.PID] != "") {
				err = errors.New("desktop_launcher_binding_repeated")
			}
			if err == nil {
				err = enroll(queue, desktop, b)
			}
			if err != nil {
				_, _ = io.WriteString(diagnostics, "desktop_launcher_binding_refused\n")
				// Close admission, not lifetime: existing observed helpers remain.
				frames = nil
				metadata.Close()
				ack.Close()
				break
			}
			seen[b.OperationID] = true
			helpers[b.Helper.PID] = b.OperationID
			// Registration precedes ACK, which precedes the original fd3 request.
			// A lost ACK never releases the already observed original helper.
			_ = ack.SetWriteDeadline(time.UnixMilli(b.Deadline))
			if _, err := ack.Write(append(line, '\n')); err != nil {
				_, _ = io.WriteString(diagnostics, "desktop_launcher_ack_unknown\n")
				frames = nil
				metadata.Close()
				ack.Close()
			}
		default:
		}
		var events [8]unix.Kevent_t
		// Bounded kernel wait serves signals and new frames; it does not decide
		// lifetime by elapsed time. Only original process exit events do that.
		timeout := unix.NsecToTimespec(int64(25 * time.Millisecond))
		n, err := unix.Kevent(queue, nil, events[:], &timeout)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			// Losing the observer must not release an already ACKed helper into
			// loginwindow cleanup. Close admission and retain this original root.
			// There is no replacement observer, PID absence guess or TTL. An
			// explicit root termination is an abort, never terminal evidence.
			frames = nil
			metadata.Close()
			ack.Close()
			return holdUncertain(command, exited, signals, diagnostics)
		}
		for _, event := range events[:n] {
			if event.Filter != unix.EVFILT_PROC || event.Fflags&unix.NOTE_EXIT == 0 || event.Flags&unix.EV_ERROR != 0 {
				continue
			}
			pid := int(event.Ident)
			if pid == desktop.pid && !exited {
				exited = true // disable all signal forwarding BEFORE reaping
				err := command.Wait()
				if err != nil {
					status = 79
					if command.ProcessState != nil && command.ProcessState.ExitCode() >= 0 {
						status = command.ProcessState.ExitCode()
					}
				}
				_, _ = fmt.Fprintf(diagnostics, "desktop_launcher_desktop_exit pid=%d code=%d\n", pid, status)
			} else if operation := helpers[pid]; operation != "" {
				_, _ = fmt.Fprintf(diagnostics, "desktop_launcher_helper_exit operation=%s pid=%d waitStatus=%d\n", operation, pid, event.Data)
				delete(helpers, pid)
			}
		}
		if exited && len(helpers) == 0 {
			return status
		}
	}
}

func holdUncertain(command *exec.Cmd, reaped bool, signals <-chan os.Signal, diagnostics io.Writer) int {
	_, _ = io.WriteString(diagnostics, "desktop_launcher_observation_unknown lifetime_held_until_explicit_termination\n")
	sig := <-signals
	if !reaped {
		// The retained child has not been reaped, so its PID cannot have been
		// reused. This explicit abort is the only remaining signaling owner.
		_ = command.Process.Signal(sig)
	}
	return 128 + int(sig.(syscall.Signal))
}
