//go:build darwin

package boot

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// Actual in-process command return over disposable Unix pipes and native Go
// repositories/File/Chat. Browser, Settings/consent and initiating host are
// controlled fixtures. No Electron, process closure, attestation or host terminal
// recorder is proved. The shared fixture retains every success/failure directory.
type preservedCommandTerminal struct {
	code        int
	diagnostics string
	elapsed     time.Duration
	closeErr    error
}

type preservedCommandPipe struct {
	input, output, hostInput, hostOutput *os.File
	reader                               *bufio.Reader
	terminal                             chan preservedCommandTerminal
	joined                               bool
}

func preservedCommandNativeArgs(profile ProfileBinding) []string {
	return []string{"--profile", profile.ProfileID, "--profile-root", profile.Root, "--profile-device", strconv.FormatUint(profile.Device, 10), "--profile-inode", strconv.FormatUint(profile.Inode, 10), "--expected-build", BuildID}
}

func newPreservedCommandPipe(t *testing.T) *preservedCommandPipe {
	t.Helper()
	if !*preservedProfileNative {
		t.Skip("requires -preserved-profile-native")
	}
	input, hostInput, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { input.Close(); hostInput.Close() })
	hostOutput, output, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hostOutput.Close(); output.Close() })
	p := &preservedCommandPipe{input: input, output: output, hostInput: hostInput, hostOutput: hostOutput, reader: bufio.NewReader(hostOutput), terminal: make(chan preservedCommandTerminal, 1)}
	// Host-side test bounds do not replace the command's original deadline.
	if err := hostInput.SetWriteDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := hostOutput.SetReadDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	return p
}

func (p *preservedCommandPipe) start(t *testing.T, args []string, deadline time.Time, dispatch bool, output io.Writer) {
	t.Helper()
	t.Cleanup(func() {
		if !p.joined {
			p.hostInput.Close()
			p.hostOutput.Close()
			p.input.Close()
			p.output.Close()
			select {
			case <-p.terminal:
				p.joined = true
			case <-time.After(3 * time.Second):
				t.Error("original command goroutine terminal UNKNOWN")
			}
		}
	})
	go func() {
		var diagnostics bytes.Buffer
		started := time.Now()
		var code int
		if dispatch {
			code = Run(append([]string{"prepare-preserved-recovery"}, args...), p.input, p.output, &diagnostics)
		} else {
			code = runPreservedProfilePreparationDeadline(args, p.input, output, &diagnostics, deadline)
		}
		// Test owns the original descriptors; command owns only its duplicates.
		closeErr := errors.Join(p.input.Close(), p.output.Close())
		p.terminal <- preservedCommandTerminal{code, diagnostics.String(), time.Since(started), closeErr}
	}()
}

func (p *preservedCommandPipe) send(t *testing.T, raw []byte) {
	t.Helper()
	if n, err := p.hostInput.Write(raw); err != nil || n != len(raw) {
		t.Fatal("initiating-host pipe write incomplete", n, len(raw), err)
	}
}

func (p *preservedCommandPipe) finish(t *testing.T, code int) preservedCommandTerminal {
	t.Helper()
	select {
	case terminal := <-p.terminal:
		p.joined = true
		t.Logf("original command terminal: code=%d elapsed=%s original-pipes-closed=%t goroutine=joined", terminal.code, terminal.elapsed, terminal.closeErr == nil)
		if terminal.code != code || terminal.closeErr != nil {
			t.Fatal("unexpected original command return", terminal.code, terminal.closeErr, terminal.diagnostics)
		}
		wantDiagnostic := ""
		if code == 1 {
			wantDiagnostic = "PRESERVED_RECOVERY_PREPARATION_REFUSED_OR_UNKNOWN\n"
		}
		if terminal.diagnostics != wantDiagnostic {
			t.Fatal("unsafe or missing diagnostic", terminal.diagnostics)
		}
		return terminal
	case <-time.After(8 * time.Second):
		t.Fatal("original command terminal UNKNOWN; no replacement launched")
		return preservedCommandTerminal{}
	}
}

func TestPreservedProfileCommandNativeExchangeRetainsExactSelectionAndArchive(t *testing.T) {
	for _, fault := range []string{"exact", "omitted-profile-limit", "ack-limit", "lost", "changed-digest", "changed-binding", "case", "nested-case", "duplicate", "unknown", "extra-value", "oversize", "late", "final-short", "final-late"} {
		t.Run(fault, func(t *testing.T) {
			in, workspace := preservedProfileFixture(t, true)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var oldChat NativeRoot
			var archiveBefore map[string]emptyRecoveryFile
			if err := inspectPreservedProfile(ctx, in, func(v preservedProfileInspection) error {
				oldChat = v.Chat
				var err error
				archiveBefore, err = emptyRecoveryArchiveFiles(ctx, v.Chat)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			computerBefore := recoverySnapshot(t, in.Profile.Root)
			fileBefore, err := os.ReadFile(filepath.Join(workspace, "note.md"))
			if err != nil {
				t.Fatal(err)
			}
			profile := in.Profile
			request := in
			request.Profile = ProfileBinding{}
			raw, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			if fault == "omitted-profile-limit" {
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(raw, &fields); err != nil {
					t.Fatal(err)
				}
				delete(fields, "Profile")
				raw, err = json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
				raw = append(raw, bytes.Repeat([]byte(" "), 65536-len(raw))...)
			}
			p := newPreservedCommandPipe(t)
			deadline := time.Now().Add(3 * time.Second)
			if fault == "late" || fault == "final-late" {
				deadline = time.Now().Add(700 * time.Millisecond)
			}
			var output io.Writer = p.output
			if fault == "final-short" || fault == "final-late" {
				output = &preservedCommandFinalOutput{File: p.output, deadline: deadline, late: fault == "final-late"}
			}
			p.start(t, preservedCommandNativeArgs(profile), deadline, fault == "exact", output)
			p.send(t, append(raw, '\n'))
			line, err := p.reader.ReadBytes('\n')
			if err != nil {
				t.Fatal("prepared publication unavailable", err)
			}
			var prepared struct {
				Schema      string                      `json:"schema"`
				BuildID     string                      `json:"buildId"`
				Publication chatport.HandoffPublication `json:"publication"`
			}
			if json.Unmarshal(line, &prepared) != nil || prepared.Schema != "farol-preserved-recovery-prepared/1" || prepared.BuildID != BuildID {
				t.Fatal("invalid prepared envelope")
			}
			publication := prepared.Publication
			binding := publication.Binding
			if publication.HandoffID != in.Selection.OperationID || publication.ReceiptDigest == ([32]byte{}) || binding.ProfileID != profile.ProfileID || binding.BuildID != BuildID || binding.BackendGeneration != in.Selection.Next.BackendGeneration || binding.HostLifetimeID != in.Selection.HostLifetimeID || binding.ChildLaunchID != in.Selection.ChildLaunchID || binding.ParentRoot != in.Selection.Current.ParentRoot || binding.ChatRoot == in.Selection.Current.ChatRoot {
				t.Fatal("publication crossed selected identity")
			}
			var fresh unix.Stat_t
			if unix.Lstat(filepath.Join(profile.Root, "chat"), &fresh) != nil || binding.ChatRoot != (chatport.JournalRoot{Device: uint64(fresh.Dev), Inode: fresh.Ino, OwnerUID: fresh.Uid}) {
				t.Fatal("publication did not name actual fresh Chat root")
			}
			if fault == "changed-digest" {
				publication.ReceiptDigest[0]++
			}
			if fault == "changed-binding" {
				publication.Binding.ChildLaunchID = "different-child"
			}
			ackRaw, err := json.Marshal(struct{ Publication chatport.HandoffPublication }{publication})
			if err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "ack-limit":
				ackRaw = append(ackRaw, bytes.Repeat([]byte(" "), 4095-len(ackRaw))...)
			case "case":
				ackRaw = bytes.Replace(ackRaw, []byte("Publication"), []byte("publication"), 1)
			case "nested-case":
				ackRaw = bytes.Replace(ackRaw, []byte("ChildLaunchID"), []byte("childLaunchId"), 1)
			case "duplicate":
				ackRaw = append([]byte(`{"Publication":{},`), ackRaw[1:]...)
			case "unknown":
				ackRaw = append([]byte(`{"Unknown":true,`), ackRaw[1:]...)
			case "extra-value":
				ackRaw = append(ackRaw, []byte(" {}")...)
			case "oversize":
				ackRaw = append(ackRaw, bytes.Repeat([]byte(" "), 4096-len(ackRaw))...)
			}
			if fault == "lost" {
				if err := p.hostInput.Close(); err != nil {
					t.Fatal(err)
				}
			} else if fault == "late" {
				// The original ACK frame remains incomplete on the open pipe until
				// its original deadline; no buffered/stored ACK or replay is used.
				p.send(t, ackRaw[:len(ackRaw)-1])
			} else {
				p.send(t, append(ackRaw, '\n'))
			}
			success := fault == "exact" || fault == "omitted-profile-limit" || fault == "ack-limit"
			wantCode := 1
			if success {
				wantCode = 0
			}
			terminal := p.finish(t, wantCode)
			if (fault == "late" || fault == "final-late") && terminal.elapsed < 650*time.Millisecond {
				t.Fatal("deadline case did not reach original deadline")
			}
			remaining, err := io.ReadAll(p.reader)
			if err != nil {
				t.Fatal("original output terminal unavailable", err)
			}
			if success {
				var acknowledged struct {
					Schema          string                          `json:"schema"`
					BuildID         string                          `json:"buildId"`
					Acknowledgement wire.CoreRetirementAcknowledged `json:"acknowledgement"`
				}
				if json.Unmarshal(remaining, &acknowledged) != nil || bytes.Count(remaining, []byte("\n")) != 1 || acknowledged.Schema != "farol-preserved-recovery-acknowledged/1" || acknowledged.BuildID != BuildID || acknowledged.Acknowledgement.HandoffId != publication.HandoffID || acknowledged.Acknowledgement.ReceiptDigest != hex.EncodeToString(publication.ReceiptDigest[:]) || len(acknowledged.Acknowledgement.AckDigest) != 64 {
					t.Fatal("acknowledged envelope did not correlate exact publication")
				}
			} else if fault != "final-short" && fault != "final-late" && len(remaining) != 0 {
				t.Fatal("unconfirmed ACK emitted success")
			}
			oldChat.Path = filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID)
			archiveAfter, err := emptyRecoveryArchiveFiles(ctx, oldChat)
			if err != nil || !reflect.DeepEqual(archiveBefore, archiveAfter) {
				t.Fatal("original nonempty/UNKNOWN archive changed", err)
			}
			pendingRaw, err := os.ReadFile(emptyRecoveryPendingPath(profile.Root))
			var pending preservedProfileInspectionInput
			if err != nil || json.Unmarshal(pendingRaw, &pending) != nil || !reflect.DeepEqual(pending, in) || refusePendingEmptyRecovery(profile) == nil {
				t.Fatal("permanent pending lost full original selection/mutations/digests", err)
			}
			// Command success still lacks the real host terminal/marker handoff.
			beforeWriter := recoverySnapshot(t, profile.Root)
			writer, err := NewNativeRuntime(context.Background(), NativeLaunch{Profile: profile, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Home: filepath.Dir(workspace), StoreMode: "open", HostLifetimeID: "withheld-host", ChildLaunchID: "withheld-child", PreviousHostDrainConfirmed: true, SettingsMutations: true}, "withheld-generation")
			if writer != nil {
				writer.Close()
				t.Fatal("pending maintenance published a normal writer")
			}
			if err == nil || !reflect.DeepEqual(beforeWriter, recoverySnapshot(t, profile.Root)) {
				t.Fatal("normal writer was not refused without changes", err)
			}
			fileAfter, err := os.ReadFile(filepath.Join(workspace, "note.md"))
			if err != nil || !bytes.Equal(fileBefore, fileAfter) {
				t.Fatal("actual retained File edit changed", err)
			}
			for name, value := range computerBefore {
				if strings.HasPrefix(name, "/computer/") || strings.HasPrefix(name, "/task/") {
					if beforeWriter[name] != value {
						t.Fatal("Computer/Task custody changed", name)
					}
				}
			}
			t.Log("original archive exact; full selected pending exact; normal writer withheld; no terminal recorded")
		})
	}
}

// The publication uses a real pipe; only final-write fault injection differs.
// This supplements, rather than qualifies, the real native pipe exchanges.
type preservedCommandFinalOutput struct {
	*os.File
	deadline time.Time
	late     bool
	writes   int
}

func (w *preservedCommandFinalOutput) Write(raw []byte) (int, error) {
	w.writes++
	if w.writes == 2 {
		if w.late {
			time.Sleep(time.Until(w.deadline) + time.Millisecond)
			return w.File.Write(raw)
		}
		return len(raw) - 1, nil
	}
	return w.File.Write(raw)
}

func TestPreservedProfileCommandNativeBlockedRequestUsesOriginalPipeDeadline(t *testing.T) {
	p := newPreservedCommandPipe(t)
	p.start(t, preservedCommandArgs(), time.Now().Add(100*time.Millisecond), false, p.output)
	p.send(t, []byte("{"))
	terminal := p.finish(t, 1)
	if terminal.elapsed < 90*time.Millisecond {
		t.Fatal("incomplete request did not await original read deadline")
	}
}

func TestPreservedProfileCommandNativeUnsupportedFileBeforeEffects(t *testing.T) {
	in, workspace := preservedProfileFixture(t, true)
	before := recoverySnapshot(t, in.Profile.Root)
	file, err := os.Open(filepath.Join(workspace, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var diagnostics bytes.Buffer
	if code := runPreservedProfilePreparation(preservedCommandNativeArgs(in.Profile), file, preservedCommandUntouched{}, &diagnostics); code != 2 || !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
		t.Fatal("regular file stream reached preparation", code)
	}
}

func TestPreservedProfileCommandNativeBlockedPublicationKeepsPendingAndArchive(t *testing.T) {
	in, _ := preservedProfileFixture(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var oldChat NativeRoot
	var before map[string]emptyRecoveryFile
	if err := inspectPreservedProfile(ctx, in, func(v preservedProfileInspection) error {
		oldChat = v.Chat
		var err error
		before, err = emptyRecoveryArchiveFiles(ctx, oldChat)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	p := newPreservedCommandPipe(t)
	// Fill the actual pipe without File.Fd (which changes Go poller behavior).
	rawFD, err := p.output.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	full := false
	var fillErr error
	if err := rawFD.Control(func(fd uintptr) {
		if fillErr = unix.SetNonblock(int(fd), true); fillErr != nil {
			return
		}
		for n := 0; n < 1024; n++ {
			_, fillErr = unix.Write(int(fd), bytes.Repeat([]byte("x"), 4096))
			if fillErr == unix.EAGAIN {
				full, fillErr = true, nil
				return
			}
			if fillErr != nil {
				return
			}
		}
	}); err != nil || fillErr != nil || !full {
		t.Fatal("actual publication pipe backpressure unavailable", err, fillErr, full)
	}
	request := in
	request.Profile = ProfileBinding{}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	p.start(t, preservedCommandNativeArgs(in.Profile), time.Now().Add(700*time.Millisecond), false, p.output)
	p.send(t, append(raw, '\n'))
	terminal := p.finish(t, 1)
	if terminal.elapsed < 650*time.Millisecond {
		t.Fatal("publication write did not await original deadline")
	}
	oldChat.Path = filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)
	after, err := emptyRecoveryArchiveFiles(ctx, oldChat)
	if err != nil || !reflect.DeepEqual(before, after) || refusePendingEmptyRecovery(in.Profile) == nil {
		t.Fatal("blocked publication lost archive/pending", err)
	}
	t.Log("blocked publication: original archive exact; pending retained; command goroutine joined")
}

func TestPreservedProfileCommandNativeRejectsChangedIndependentSelectionsWithoutEffects(t *testing.T) {
	for _, changed := range []string{"access-digest", "mutation-digest", "handoff-digest", "selected-profile"} {
		t.Run(changed, func(t *testing.T) {
			in, _ := preservedProfileFixture(t, true)
			before := recoverySnapshot(t, in.Profile.Root)
			profile := in.Profile
			in.Profile = ProfileBinding{}
			switch changed {
			case "access-digest":
				in.AccessDigest[0]++
			case "mutation-digest":
				in.Mutations[0].SHA256 = strings.Repeat("0", 64)
			case "handoff-digest":
				in.Selection.HandoffDigest[0]++
			case "selected-profile":
				in.Selection.Next.ProfileID = "different-selected-profile"
			}
			raw, err := json.Marshal(in)
			if err != nil {
				t.Fatal(err)
			}
			p := newPreservedCommandPipe(t)
			p.start(t, preservedCommandNativeArgs(profile), time.Now().Add(3*time.Second), false, p.output)
			p.send(t, append(raw, '\n'))
			p.finish(t, 1)
			output, err := io.ReadAll(p.reader)
			if err != nil || len(output) != 0 || !reflect.DeepEqual(before, recoverySnapshot(t, profile.Root)) {
				t.Fatal("changed selection reached effects/publication", err)
			}
			if _, err := os.Lstat(emptyRecoveryPendingPath(profile.Root)); !os.IsNotExist(err) {
				t.Fatal("changed selection created pending", err)
			}
		})
	}
}
