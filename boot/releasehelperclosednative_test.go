//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"github.com/legrch/farol/modules/release/infra/native/processprobe"
	"golang.org/x/sys/unix"
)

// Root alone enables this fresh disposable process lane. It is a declared
// inherited-role fixture, never production role authentication or helper selection.
// Every directory and actual Wait/diagnostic result is retained, including failure.
const closedHelperNativeEnv = "FAROL_CLOSED_HELPER_NATIVE"
const closedHelperNativeChildEnv = "FAROL_CLOSED_HELPER_NATIVE_CHILD"

type closedHelperNativeLease struct {
	Device, Inode  uint64
	Mode           uint32
	Size           int64
	Flags, FDFlags int
}

func closedHelperNativeSnapshot(file *os.File) (snapshot closedHelperNativeLease, err error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return snapshot, err
	}
	var inner error
	err = raw.Control(func(fd uintptr) {
		var st unix.Stat_t
		if inner = unix.Fstat(int(fd), &st); inner != nil {
			return
		}
		var flags, fdflags int
		flags, inner = unix.FcntlInt(fd, unix.F_GETFL, 0)
		if inner != nil {
			return
		}
		fdflags, inner = unix.FcntlInt(fd, unix.F_GETFD, 0)
		if inner != nil {
			return
		}
		snapshot = closedHelperNativeLease{uint64(st.Dev), uint64(st.Ino), uint32(st.Mode), st.Size, flags, fdflags}
	})
	return snapshot, errors.Join(err, inner)
}
func closedHelperNativeIdentity(file *os.File) (map[string]any, error) {
	st, err := closedHelperNativeSnapshot(file)
	return map[string]any{"device": fmt.Sprint(st.Device), "inode": fmt.Sprint(st.Inode)}, err
}

type closedHelperNativeTerminal struct {
	Mode          string
	Callback      bool
	Error         string
	Before, After closedHelperNativeLease
}

func TestClosedHelperNativeChild(t *testing.T) {
	mode := os.Getenv(closedHelperNativeChildEnv)
	if mode == "" {
		t.Skip("declared inherited fixture child only")
	}
	input, ack, lease, continuation := os.NewFile(3, "fixture-request"), os.NewFile(4, "fixture-ACK"), os.NewFile(5, "fixture-BORROWED-lease"), os.NewFile(6, "fixture-continuation")
	until := time.Now().Add(3 * time.Second)
	before, snapshotErr := closedHelperNativeSnapshot(lease)
	if snapshotErr != nil {
		t.Fatal(snapshotErr)
	}
	receipt := closedHelperNativeTerminal{Mode: mode, Before: before}
	err := withClosedReleaseHelper(context.Background(), closedHelperFiles{input, ack, lease, continuation}, until, func(scope closedReleaseHelper) error {
		receipt.Callback = true
		return scope.withFiles(context.Background(), func(ctx context.Context, files helperroutes.Files, request releaseport.HelperRequest, bound time.Time) error {
			if !bound.Equal(until) {
				return errors.New("fixture bound changed")
			}
			if err := files.Reverify(ctx); err != nil {
				return err
			}
			if err := scope.reverify(ctx, request); err != nil {
				return err
			}
			updateLock := filepath.Join(request.Home, "Library", "Application Support", "Farol Next Preview", "installed-updates", "lock")
			if err := closedHelperNativeContention(updateLock); err != nil {
				return err
			}
			return nil // No journal, app tree or installation effect is composed.
		})
	})
	if err != nil {
		receipt.Error = err.Error()
	}
	receipt.After, snapshotErr = closedHelperNativeSnapshot(lease)
	if snapshotErr != nil {
		t.Error(snapshotErr)
	}
	if !reflect.DeepEqual(receipt.Before, receipt.After) {
		t.Error("borrowed fd5 metadata or flags changed")
	}
	data, marshalErr := json.Marshal(receipt)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	fmt.Println("CLOSED_HELPER_FIXTURE_TERMINAL " + string(data))
	// This wrapper is BORROWED. Never Close, seek, change flags, or unlock it.
	// The fixture process's eventual exit is observed separately by the parent.
	runtime.KeepAlive(lease)
}

type closedHelperNativeCommand struct {
	cmd            *exec.Cmd
	stdout, stderr bytes.Buffer
	name, dir      string
	waited         bool
}

func (c *closedHelperNativeCommand) wait(t *testing.T) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	var err error
	forced := false
	select {
	case err = <-done:
	case <-time.After(8 * time.Second):
		forced = true
		killErr := c.cmd.Process.Kill() // The exact retained fixture child only.
		err = errors.Join(<-done, killErr, errors.New("fixture forced cleanup; not accepted"))
	}
	c.waited = true
	for suffix, data := range map[string][]byte{"stdout": c.stdout.Bytes(), "stderr": c.stderr.Bytes()} {
		if e := os.WriteFile(filepath.Join(c.dir, c.name+"."+suffix), data, 0600); e != nil {
			t.Error(e)
		}
	}
	receipt := map[string]any{"actualWaitReturned": true, "pid": c.cmd.Process.Pid, "forcedCleanup": forced, "diagnosticProducersJoinedByWait": err == nil, "at": time.Now().UTC().Format(time.RFC3339Nano)}
	if c.cmd.ProcessState != nil {
		receipt["exited"] = c.cmd.ProcessState.Exited()
		receipt["exitCode"] = c.cmd.ProcessState.ExitCode()
	}
	if err != nil {
		receipt["error"] = err.Error()
	}
	b, _ := json.MarshalIndent(receipt, "", "  ")
	if e := os.WriteFile(filepath.Join(c.dir, c.name+".wait.json"), append(b, '\n'), 0600); e != nil {
		t.Error(e)
	}
	return err
}
func closedHelperNativeStart(t *testing.T, dir, name, mode string, extra []*os.File) (*closedHelperNativeCommand, io.WriteCloser, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	c := &closedHelperNativeCommand{name: name, dir: dir}
	if mode == "predecessor" {
		c.cmd = exec.Command("/bin/cat")
	} else {
		c.cmd = exec.Command(executable, "-test.run=^TestClosedHelperNativeChild$", "-test.count=1")
		c.cmd.ExtraFiles = extra
	}
	c.cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8", closedHelperNativeEnv + "=1", closedHelperNativeChildEnv + "=" + mode}
	c.cmd.Dir = dir
	c.cmd.WaitDelay = time.Second
	c.cmd.Stdout = &c.stdout
	c.cmd.Stderr = &c.stderr
	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	if err = c.cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, nil, err
	}
	t.Cleanup(func() {
		if c.waited {
			return
		}
		_ = stdin.Close()
		if mode != "predecessor" {
			_ = c.cmd.Process.Kill()
		}
		waitErr := c.wait(t)
		t.Error("fixture ended through abnormal retained-handle cleanup", waitErr)
	})
	return c, stdin, nil
}
func closedHelperNativeContention(path string) error {
	contender, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	raw, err := contender.SyscallConn()
	var lockErr error
	if err == nil {
		err = raw.Control(func(fd uintptr) { lockErr = unix.Flock(int(fd), unix.LOCK_EX|unix.LOCK_NB) })
	}
	closeErr := contender.Close()
	if lockErr != unix.EWOULDBLOCK && lockErr != unix.EAGAIN {
		return errors.Join(err, closeErr, errors.New("borrowed exclusive lock was not held"))
	}
	return errors.Join(err, closeErr)
}
func TestClosedHelperNativeInheritedCustody(t *testing.T) {
	if os.Getenv(closedHelperNativeEnv) != "1" {
		t.Skip("Root must allocate the native lane explicitly")
	}
	for _, mode := range []string{"sealed", "partial", "withheld-eof", "replaced-slot", "replaced-lease", "replaced-route", "live", "reused", "stale-quit", "unconfirmed-quit"} {
		t.Run(mode, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "farol-closed-helper-native-")
			if err != nil {
				t.Fatal(err)
			}
			t.Log("RETAINED fixture:", dir)
			if e := os.Chmod(dir, 0700); e != nil {
				t.Fatal(e)
			}
			home := filepath.Join(dir, "home")
			statePath := filepath.Join(home, "Library", "Application Support", "Farol Next Preview", "farol-next-state")
			update := filepath.Join(home, "Library", "Application Support", "Farol Next Preview", "installed-updates")
			operation := filepath.Join(update, strings.Repeat("1", 32))
			for _, path := range []string{filepath.Join(home, "Applications"), statePath, operation} {
				if e := os.MkdirAll(path, 0700); e != nil {
					t.Fatal(e)
				}
			}
			state, err := os.Open(statePath)
			if err != nil {
				t.Fatal(err)
			}
			stateID, err := closedHelperNativeIdentity(state)
			if e := state.Close(); e != nil {
				t.Error(e)
			}
			if err != nil {
				t.Fatal(err)
			}
			leasePath := filepath.Join(statePath, "promotion.lease")
			lease, err := os.OpenFile(leasePath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				t.Fatal(err)
			}
			leaseClosed := false
			closeLease := func() error {
				if leaseClosed {
					return nil
				}
				leaseClosed = true
				return lease.Close()
			}
			t.Cleanup(func() {
				if e := closeLease(); e != nil {
					t.Error(e)
				}
			})
			payload := []byte("parent-owned-fixture-lease")
			if _, err = lease.Write(payload); err != nil {
				t.Fatal(err)
			}
			raw, err := lease.SyscallConn()
			if err != nil {
				t.Fatal(err)
			}
			var lockErr error
			err = raw.Control(func(fd uintptr) { lockErr = unix.Flock(int(fd), unix.LOCK_EX|unix.LOCK_NB) })
			if err != nil || lockErr != nil {
				_ = closeLease()
				t.Fatal(errors.Join(err, lockErr))
			}
			before, err := closedHelperNativeSnapshot(lease)
			if err != nil {
				t.Fatal(err)
			}
			leaseID, err := closedHelperNativeIdentity(lease)
			if err != nil {
				t.Fatal(err)
			}
			if err = closedHelperNativeContention(leasePath); err != nil {
				t.Fatal(err)
			}
			startedAt := time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano)
			predecessor, stop, err := closedHelperNativeStart(t, dir, "predecessor", "predecessor", nil)
			if err != nil {
				t.Fatal(err)
			}
			// Only the existing bound native observer reads this disposable PID. No scan.
			probe, err := processprobe.New(predecessor.cmd.Process.Pid)
			var observed releaseport.ProcessObservation
			if err == nil {
				observed, err = probe.Observe(context.Background(), time.Now().Add(2*time.Second))
			}
			if err != nil || observed.Presence != releaseport.ProcessPresent || observed.Start == "" {
				_ = stop.Close()
				waitErr := predecessor.wait(t)
				_ = closeLease()
				t.Fatal("predecessor identity unavailable", err, waitErr)
			}
			live := mode == "live" || mode == "reused"
			if !live {
				_ = stop.Close()
				if err = predecessor.wait(t); err != nil {
					_ = closeLease()
					t.Fatal(err)
				}
			}
			quitAt := time.Now().UTC().Format(time.RFC3339Nano)
			if mode == "stale-quit" {
				quitAt = startedAt
			}
			quit := map[string]any{"schema": 1, "at": quitAt, "drained": mode != "unconfirmed-quit", "unconfirmed": []string{}}
			quitData := closedHelperJSON(t, quit)
			if e := os.WriteFile(filepath.Join(statePath, "last-quit.json"), quitData, 0600); e != nil {
				t.Fatal(e)
			}
			digest := sha256.Sum256(quitData)
			request := closedHelperRequestFixture()
			request["home"] = home
			request["pid"] = predecessor.cmd.Process.Pid
			request["processStart"] = observed.Start
			if mode == "reused" {
				request["processStart"] = "different opaque birth"
			}
			request["predecessor"] = map[string]any{"kind": "confirmed_closed", "startedAt": startedAt, "lastQuitSha256": hex.EncodeToString(digest[:]), "stateIdentity": stateID}
			request["leaseIdentity"] = leaseID
			requestBytes := closedHelperJSON(t, request)
			protocol, err := protocolapp.Bind(context.Background(), requestBytes, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
			if err != nil {
				t.Fatal(err)
			}
			slot, err := protocol.BuildSlotBinding(context.Background(), protocolnative.JSONCodec{})
			if err != nil {
				t.Fatal(err)
			}
			slotPath := filepath.Join(operation, "slot-binding.json")
			if err = os.WriteFile(slotPath, slot, 0600); err != nil {
				t.Fatal(err)
			}
			requestRead, requestWrite, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			ackRead, ackWrite, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			contRead, contWrite, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			helper, helperStdin, err := closedHelperNativeStart(t, dir, "helper", mode, []*os.File{requestRead, ackWrite, lease, contRead})
			if err != nil {
				t.Fatal(err)
			}
			_ = helperStdin.Close()
			_ = requestRead.Close()
			_ = ackWrite.Close()
			_ = contRead.Close()
			var runErrors []error
			if _, e := requestWrite.Write(requestBytes); e != nil {
				runErrors = append(runErrors, e)
			}
			if e := requestWrite.Close(); e != nil {
				runErrors = append(runErrors, e)
			}
			_ = ackRead.SetReadDeadline(time.Now().Add(5 * time.Second))
			ready, readErr := io.ReadAll(io.LimitReader(ackRead, 4097))
			_ = ackRead.Close()
			if readErr != nil {
				runErrors = append(runErrors, readErr)
			}
			preRefusal := live || mode == "stale-quit" || mode == "unconfirmed-quit"
			if preRefusal {
				if len(ready) != 0 {
					runErrors = append(runErrors, errors.New("pre-readiness refusal exposed ACK"))
				}
			} else {
				expected, e := protocol.BuildHandoff(context.Background(), protocolapp.ClosedPredecessorReady, nil)
				if e != nil || !bytes.Equal(ready, expected) {
					runErrors = append(runErrors, errors.New("correlated bounded ACK/EOF missing"))
				}
			}
			retainedLeasePath := leasePath
			switch mode {
			case "replaced-slot":
				if e := os.Rename(slotPath, slotPath+".retained"); e != nil {
					runErrors = append(runErrors, e)
				}
				if e := os.WriteFile(slotPath, []byte("{}\n"), 0600); e != nil {
					runErrors = append(runErrors, e)
				}
			case "replaced-lease":
				retainedLeasePath = leasePath + ".retained"
				if e := os.Rename(leasePath, retainedLeasePath); e != nil {
					runErrors = append(runErrors, e)
				}
				if e := os.WriteFile(leasePath, []byte("replacement"), 0600); e != nil {
					runErrors = append(runErrors, e)
				}
			case "replaced-route":
				if e := os.Rename(operation, operation+".retained"); e != nil {
					runErrors = append(runErrors, e)
				}
				if e := os.Mkdir(operation, 0700); e != nil {
					runErrors = append(runErrors, e)
				}
			}
			continuation := closedHelperJSON(t, closedHelperContinuation(request))
			if mode == "partial" {
				continuation = continuation[:len(continuation)-1]
			}
			if !preRefusal {
				if _, e := contWrite.Write(continuation); e != nil && (mode == "sealed" || !errors.Is(e, unix.EPIPE)) {
					runErrors = append(runErrors, e)
				}
			}
			if mode != "withheld-eof" {
				_ = contWrite.Close()
			}
			waitErr := helper.wait(t)
			if mode == "withheld-eof" {
				_ = contWrite.Close()
			}
			if live {
				_ = stop.Close()
				if e := predecessor.wait(t); e != nil {
					runErrors = append(runErrors, e)
				}
			}
			if waitErr != nil {
				runErrors = append(runErrors, waitErr)
			}
			if err = closedHelperNativeContention(retainedLeasePath); err != nil {
				runErrors = append(runErrors, err)
			}
			after, e := closedHelperNativeSnapshot(lease)
			if e != nil {
				runErrors = append(runErrors, e)
			}
			if before != after {
				runErrors = append(runErrors, errors.New("parent borrowed flags/metadata changed"))
			}
			// Prove the shared offset by a parent-owned append AFTER actual child Wait;
			// never query/change fd5's offset or seek any alias. Pread does not move it.
			if _, e := lease.Write([]byte("-after-wait")); e != nil {
				runErrors = append(runErrors, e)
			}
			contents := make([]byte, len(payload)+len("-after-wait"))
			_, e = lease.ReadAt(contents, 0)
			if e != nil || !bytes.Equal(contents, append(payload, []byte("-after-wait")...)) {
				runErrors = append(runErrors, errors.New("shared offset/content changed"))
			}
			if e := closeLease(); e != nil {
				runErrors = append(runErrors, e)
			}
			leaseClosed = true
			var terminal closedHelperNativeTerminal
			found := false
			for _, line := range strings.Split(helper.stdout.String(), "\n") {
				if strings.HasPrefix(line, "CLOSED_HELPER_FIXTURE_TERMINAL ") {
					found = json.Unmarshal([]byte(strings.TrimPrefix(line, "CLOSED_HELPER_FIXTURE_TERMINAL ")), &terminal) == nil
				}
			}
			wantSuccess := mode == "sealed"
			if wantSuccess {
				released, openErr := os.OpenFile(filepath.Join(update, "lock"), os.O_RDWR, 0)
				if openErr != nil {
					runErrors = append(runErrors, openErr)
				} else {
					conn, connErr := released.SyscallConn()
					var flockErr error
					if connErr == nil {
						connErr = conn.Control(func(fd uintptr) { flockErr = unix.Flock(int(fd), unix.LOCK_EX|unix.LOCK_NB) })
					}
					runErrors = append(runErrors, connErr, flockErr, released.Close())
				}
			}
			if !found || terminal.Callback != wantSuccess || (terminal.Error == "") != wantSuccess {
				runErrors = append(runErrors, errors.New("fixture terminal outcome mismatch"))
			}
			if !helper.waited || !predecessor.waited {
				runErrors = append(runErrors, errors.New("actual Wait receipt missing"))
			}
			if err = errors.Join(runErrors...); err != nil {
				t.Fatal(err)
			}
		})
	}
}
