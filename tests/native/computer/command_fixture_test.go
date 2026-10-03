//go:build darwin

package computer

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const witnessBound = 5 * time.Second
const witnessHelper = "FAROL_COMMAND_WITNESS_HELPER"
const witnessToken = "FAROL_COMMAND_WITNESS_TOKEN"

type witnessMessage struct {
	Token string `json:"token"`
	State string `json:"state"`
	PID   int    `json:"pid"`
	PPID  int    `json:"ppid"`
}

type commandWitness struct {
	root                           *exec.Cmd
	rootControl, descendantControl *os.File
	rootStatus, descendantStatus   *os.File
	token                          string
	descendant                     int
	queue                          int
	rootDone                       chan struct{}
	rootErr                        error
	started                        bool
	registered                     bool
}

func newCommandWitness(t *testing.T) *commandWitness {
	t.Helper()
	fixture := &commandWitness{queue: -1, rootDone: make(chan struct{})}
	var childFiles []*os.File
	t.Cleanup(func() { fixture.cleanup(t) })
	// Parent owns the only control writers. EOF releases helpers even if test
	// setup fails. There is no signal fallback, process scan or detached sleep.
	pipe := func(control bool) (*os.File, *os.File) {
		t.Helper()
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		child, parent := writer, reader
		if control {
			child, parent = reader, writer
		}
		childFiles = append(childFiles, child)
		t.Cleanup(func() { child.Close() })
		return parent, child
	}
	var rootControl, rootStatus, descendantControl, descendantStatus *os.File
	fixture.rootControl, rootControl = pipe(true)
	fixture.rootStatus, rootStatus = pipe(false)
	fixture.descendantControl, descendantControl = pipe(true)
	fixture.descendantStatus, descendantStatus = pipe(false)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	fixture.token = hex.EncodeToString(nonce[:])
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	fixture.root = exec.Command(executable, "-test.run=^TestCommandWitnessHelper$")
	fixture.root.Env = helperEnvironment("root", fixture.token)
	fixture.root.ExtraFiles = []*os.File{rootControl, rootStatus, descendantControl, descendantStatus}
	fixture.root.SysProcAttr = &unix.SysProcAttr{Setpgid: true}
	if err := fixture.root.Start(); err != nil {
		t.Fatalf("owned fixture start unavailable; no retry: %v", err)
	}
	fixture.started = true
	go func() {
		fixture.rootErr = fixture.root.Wait()
		close(fixture.rootDone)
	}()
	for _, file := range childFiles {
		file.Close()
	}
	fixture.receive(t, fixture.rootStatus, "root-ready", fixture.root.Process.Pid, 0)
	ready := fixture.receive(t, fixture.descendantStatus, "descendant-ready", 0, fixture.root.Process.Pid)
	if ready.PID == fixture.root.Process.Pid {
		t.Fatal("descendant readiness named the root")
	}
	fixture.descendant = ready.PID

	queue, err := unix.Kqueue()
	if err != nil {
		t.Fatalf("NATIVE_PROCESS_OBSERVER_UNAVAILABLE before root release: %v", err)
	}
	fixture.queue = queue
	unix.CloseOnExec(queue)
	change := unix.Kevent_t{Ident: uint64(fixture.descendant), Filter: unix.EVFILT_PROC,
		Flags: unix.EV_ADD | unix.EV_ONESHOT | unix.EV_RECEIPT, Fflags: unix.NOTE_EXIT}
	var receipts [1]unix.Kevent_t
	n, err := unix.Kevent(queue, []unix.Kevent_t{change}, receipts[:], nil)
	if err != nil {
		t.Fatalf("NATIVE_PROCESS_OBSERVER_UNAVAILABLE before root release; no fallback: %v", err)
	}
	if err := processRegistration(fixture.descendant, receipts[:n]); err != nil {
		t.Fatalf("NATIVE_PROCESS_OBSERVER_UNAVAILABLE before root release; no fallback: %v", err)
	}
	fixture.registered = true
	// This round trip occurs AFTER registration and BEFORE root release. A
	// receipt from the same held descendant excludes a stale numeric PID
	// being registered after an unexpected early child exit.
	fixture.send(t, fixture.descendantControl, "listener-ready")
	fixture.receive(t, fixture.descendantStatus, "listener-installed", fixture.descendant, fixture.root.Process.Pid)
	return fixture
}

func helperEnvironment(kind, token string) []string {
	// Do not inherit owner config, credentials, HOME or ambient environment.
	return []string{witnessHelper + "=" + kind, witnessToken + "=" + token}
}

func (f *commandWitness) send(t *testing.T, file *os.File, state string) {
	t.Helper()
	if err := file.SetWriteDeadline(time.Now().Add(witnessBound)); err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(file).Encode(witnessMessage{Token: f.token, State: state}); err != nil {
		t.Fatalf("owned barrier write unavailable; no retry: %v", err)
	}
}

func (f *commandWitness) receive(t *testing.T, file *os.File, state string, pid, ppid int) witnessMessage {
	t.Helper()
	if err := file.SetReadDeadline(time.Now().Add(witnessBound)); err != nil {
		t.Fatal(err)
	}
	var message witnessMessage
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&message); err != nil {
		t.Fatalf("missing owned barrier receipt %s: %v", state, err)
	}
	if err := validateWitnessMessage(message, f.token, state, pid, ppid); err != nil {
		t.Fatal(err)
	}
	return message
}

func validateWitnessMessage(message witnessMessage, token, state string, pid, ppid int) error {
	if token == "" || message.Token != token || message.State != state || message.PID <= 0 ||
		(pid != 0 && message.PID != pid) || (ppid != 0 && message.PPID != ppid) {
		return errors.New("wrong owned barrier receipt")
	}
	return nil
}

func (f *commandWitness) waitRoot() error {
	select {
	case <-f.rootDone:
		return f.rootErr
	case <-time.After(witnessBound):
		return errors.New("owned root terminal receipt unavailable; no retry")
	}
}

func (f *commandWitness) requireSurvivingDescendant(t *testing.T) {
	t.Helper()
	f.send(t, f.descendantControl, "witness")
	f.receive(t, f.descendantStatus, "alive-after-root", f.descendant, 0)
}

func (f *commandWitness) cleanup(t *testing.T) {
	t.Helper()
	// EOF requests cooperative exit on the retained channels, once. No numeric
	// process identity is consulted during cleanup, even on registration error.
	for _, file := range []*os.File{f.descendantControl, f.rootControl} {
		if file != nil {
			file.Close()
		}
	}
	if f.started {
		select {
		case <-f.rootDone:
		case <-time.After(witnessBound):
			t.Error("owned root cleanup terminal receipt unavailable; no retry")
		}
	}
	if f.queue >= 0 {
		defer unix.Close(f.queue)
	}
	if f.registered {
		var events [1]unix.Kevent_t
		timeout := unix.NsecToTimespec(witnessBound.Nanoseconds())
		n, err := unix.Kevent(f.queue, nil, events[:], &timeout)
		if err != nil {
			t.Errorf("NATIVE_PROCESS_EXIT_UNQUALIFIED on retained listener; no fallback: %v", err)
		} else if err := processExit(f.descendant, events[:n]); err != nil {
			t.Errorf("NATIVE_PROCESS_EXIT_UNQUALIFIED: %v", err)
		}
	} else if f.descendant != 0 {
		t.Error("NATIVE_PROCESS_EXIT_UNQUALIFIED: descendant listener was not installed")
	}
	for _, file := range []*os.File{f.rootStatus, f.descendantStatus} {
		if file != nil {
			file.Close()
		}
	}
}

func processRegistration(pid int, receipts []unix.Kevent_t) error {
	if pid <= 0 || len(receipts) != 1 || receipts[0].Ident != uint64(pid) ||
		receipts[0].Filter != unix.EVFILT_PROC || receipts[0].Flags&unix.EV_ERROR == 0 {
		return errors.New("missing exact process listener registration receipt")
	}
	if receipts[0].Data != 0 {
		return fmt.Errorf("process listener refused: %w", unix.Errno(receipts[0].Data))
	}
	return nil
}

func processExit(pid int, events []unix.Kevent_t) error {
	if pid <= 0 || len(events) != 1 || events[0].Ident != uint64(pid) ||
		events[0].Filter != unix.EVFILT_PROC || events[0].Flags&unix.EV_ERROR != 0 ||
		events[0].Fflags&unix.NOTE_EXIT == 0 {
		return errors.New("missing exact registered process NOTE_EXIT")
	}
	return nil
}

// Re-exec only this test in a fresh disposable child. It spawns exactly one
// descendant, with no shell, inherited owner environment, helper installation
// or hidden process-group lookup. Helper role/token come only from test-owned
// environment; the helper is not a shipping executable or product executor.
func TestCommandWitnessHelper(t *testing.T) {
	kind := os.Getenv(witnessHelper)
	if kind == "" {
		return
	}
	token := os.Getenv(witnessToken)
	if len(token) != 32 || (kind != "root" && kind != "descendant") {
		os.Exit(2)
	}
	control := os.NewFile(3, "owned-control")
	status := os.NewFile(4, "owned-status")
	unix.CloseOnExec(3)
	unix.CloseOnExec(4)
	var descendant *exec.Cmd
	if kind == "root" {
		executable, err := os.Executable()
		if err != nil {
			os.Exit(2)
		}
		childControl := os.NewFile(5, "descendant-control")
		childStatus := os.NewFile(6, "descendant-status")
		unix.CloseOnExec(5)
		unix.CloseOnExec(6)
		descendant = exec.Command(executable, "-test.run=^TestCommandWitnessHelper$")
		descendant.Env = helperEnvironment("descendant", token)
		descendant.ExtraFiles = []*os.File{childControl, childStatus}
		if err := descendant.Start(); err != nil {
			os.Exit(2)
		}
		childControl.Close()
		childStatus.Close()
	}
	state := "descendant-ready"
	if kind == "root" {
		state = "root-ready"
	}
	emit := func(state string) {
		if err := json.NewEncoder(status).Encode(witnessMessage{Token: token, State: state, PID: os.Getpid(), PPID: os.Getppid()}); err != nil {
			os.Exit(2)
		}
	}
	emit(state)
	decoder := json.NewDecoder(control)
	decoder.DisallowUnknownFields()
	for {
		var message witnessMessage
		err := decoder.Decode(&message)
		if errors.Is(err, io.EOF) {
			if descendant != nil && descendant.Wait() != nil {
				os.Exit(2)
			}
			os.Exit(0)
		}
		if err != nil || message.Token != token || message.PID != 0 || message.PPID != 0 {
			os.Exit(2)
		}
		switch {
		case kind == "root" && message.State == "exit-root":
			os.Exit(0) // Deliberately do not Wait the still-held descendant.
		case kind == "descendant" && message.State == "listener-ready":
			emit("listener-installed")
		case kind == "descendant" && message.State == "witness":
			emit("alive-after-root")
		default:
			os.Exit(2)
		}
	}
}

func TestCommandWitnessEventValidation(t *testing.T) {
	registration := unix.Kevent_t{Ident: 41, Filter: unix.EVFILT_PROC, Flags: unix.EV_ERROR}
	if err := processRegistration(41, []unix.Kevent_t{registration}); err != nil {
		t.Fatal(err)
	}
	refused := registration
	refused.Data = int64(unix.EPERM)
	if err := processRegistration(41, []unix.Kevent_t{refused}); !errors.Is(err, unix.EPERM) {
		t.Fatalf("refusal lost: %v", err)
	}
	if err := processRegistration(42, []unix.Kevent_t{registration}); err == nil {
		t.Fatal("foreign listener accepted")
	}
	exit := unix.Kevent_t{Ident: 41, Filter: unix.EVFILT_PROC, Fflags: unix.NOTE_EXIT}
	if err := processExit(41, []unix.Kevent_t{exit}); err != nil {
		t.Fatal(err)
	}
	for name, events := range map[string][]unix.Kevent_t{
		"root-wait-only": nil,
		"foreign-pid":    {{Ident: 42, Filter: unix.EVFILT_PROC, Fflags: unix.NOTE_EXIT}},
		"pipe-eof":       {{Ident: 41, Filter: unix.EVFILT_READ}},
		"missing-exit":   {{Ident: 41, Filter: unix.EVFILT_PROC}},
		"refused":        {{Ident: 41, Filter: unix.EVFILT_PROC, Flags: unix.EV_ERROR, Fflags: unix.NOTE_EXIT}},
		"ambiguous":      {exit, exit},
	} {
		t.Run(name, func(t *testing.T) {
			if err := processExit(41, events); err == nil {
				t.Fatal("unqualified terminal evidence accepted")
			}
		})
	}
}

func TestCommandWitnessBarrierValidation(t *testing.T) {
	message := witnessMessage{Token: "owned-token", State: "alive-after-root", PID: 41, PPID: 40}
	if err := validateWitnessMessage(message, "owned-token", "alive-after-root", 41, 40); err != nil {
		t.Fatal(err)
	}
	for name, candidate := range map[string]witnessMessage{
		"foreign-token":             {Token: "foreign", State: message.State, PID: 41, PPID: 40},
		"readiness-is-not-survival": {Token: message.Token, State: "descendant-ready", PID: 41, PPID: 40},
		"root-is-not-descendant":    {Token: message.Token, State: message.State, PID: 40, PPID: 40},
		"wrong-parent":              {Token: message.Token, State: message.State, PID: 41, PPID: 39},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateWitnessMessage(candidate, message.Token, message.State, 41, 40); err == nil {
				t.Fatal("foreign or wrong-phase barrier receipt accepted")
			}
		})
	}
}
