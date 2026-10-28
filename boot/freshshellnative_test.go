//go:build darwin && farol_native_process

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"github.com/legrch/farol/modules/computer/domain/authority"
	nativeprocess "github.com/legrch/farol/modules/computer/infra/process"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"golang.org/x/sys/unix"
)

type freshShellNativeInput struct {
	Launch                    NativeLaunch
	Bundle, Workspace, Source string
	Generation                int
}
type freshShellNativeResult struct {
	Group, Descendants, Receipt string
	Drained                     bool
}

// Two actual test-owned backend processes run native qualification, Seatbelt,
// watchdog, framed connector calls and real mutation storage. Trusted release
// metadata and workspace consent are explicit fixture inputs, not package or
// Electron/installed acceptance. No provider, Send or live profile is involved.
func TestNativeFreshShellQuitAndWritableReopen(t *testing.T) {
	node := os.Getenv("FAROL_TEST_WATCHDOG_NODE")
	if !filepath.IsAbs(node) {
		t.Fatal("explicit native Node selection required")
	}
	launch, workspace, _ := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	base, err := os.MkdirTemp(filepath.Dir(launch.Profile.Root), "fresh-shell-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !t.Failed() {
			_ = os.RemoveAll(base)
		} else {
			t.Log("retained native Shell evidence:", base)
		}
	})
	bundle := filepath.Join(base, "Farol.app")
	backend := filepath.Join(bundle, "Contents/Resources/app/farol-backend")
	watchdog := filepath.Join(bundle, "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{self, backend}, {node, watchdog}} {
		if err := os.MkdirAll(filepath.Dir(pair[1]), 0700); err != nil {
			t.Fatal(err)
		}
		input, err := os.Open(pair[0])
		if err != nil {
			t.Fatal(err)
		}
		output, err := os.OpenFile(pair[1], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
		if err != nil {
			input.Close()
			t.Fatal(err)
		}
		_, copyErr := io.Copy(output, input)
		e1, e2 := input.Close(), output.Close()
		if copyErr != nil || e1 != nil || e2 != nil {
			t.Fatal("copy exact fixture bytes failed", copyErr, e1, e2)
		}
	}
	_, sourceFile, _, _ := runtime.Caller(0)
	exporter := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../tests/fixtures/watchdog-source.mjs"))
	export := exec.Command(watchdog, exporter)
	export.Env = []string{}
	raw, err := export.Output()
	if err != nil {
		t.Fatal(err)
	}
	var source struct {
		Source string `json:"source"`
	}
	if json.Unmarshal(raw, &source) != nil || source.Source == "" {
		t.Fatal("source export unavailable")
	}
	launch.StartupMode, launch.SettingsMutations = "fresh", true
	for n := 1; n <= 2; n++ {
		request := freshShellNativeInput{launch, bundle, workspace, source.Source, n}
		input := filepath.Join(base, fmt.Sprintf("input-%d.json", n))
		data, _ := json.Marshal(request)
		if err := os.WriteFile(input, data, 0600); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		child := exec.CommandContext(ctx, backend, "-test.run=^TestNativeFreshShellChild$")
		child.Env = []string{"FAROL_TEST_FRESH_SHELL_INPUT=" + input}
		child.WaitDelay = time.Second
		output, err := child.CombinedOutput()
		cancel()
		if err != nil {
			_ = os.WriteFile(filepath.Join(base, fmt.Sprintf("child-%d.log", n)), output, 0600)
			t.Fatalf("native generation %d failed; no retry: %v\n%s", n, err, output)
		}
		var result freshShellNativeResult
		data, err = os.ReadFile(input + ".result")
		if err != nil || json.Unmarshal(data, &result) != nil || !result.Drained || result.Group != "confirmed" || result.Descendants != "unverified" || len(result.Receipt) != 64 {
			t.Fatal("actual Shell receipt/drain absent", result, err)
		}
		for key, old := range before {
			if key != "/workspace" && recoverySnapshot(t, launch.Profile.Root)[key] != old {
				t.Fatal("Shell/reopen changed original UNKNOWN/history", key)
			}
		}
		t.Logf("generation %d: actual exit0, group=%s descendants=%s receipt=%s drained=%v; child exit0", n, result.Group, result.Descendants, result.Receipt, result.Drained)
	}
}

func TestNativeFreshShellChild(t *testing.T) {
	input := os.Getenv("FAROL_TEST_FRESH_SHELL_INPUT")
	if input == "" {
		t.Skip("only selected disposable parent starts this child")
	}
	raw, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var f freshShellNativeInput
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("invalid input")
	}
	pin := func(path string) nativeprocess.ExecutablePin {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			t.Fatal(err)
		}
		path = resolved
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		return nativeprocess.ExecutablePin{Path: path, SHA256: hex.EncodeToString(sum[:])}
	}
	hash := sha256.Sum256([]byte(f.Source))
	sourceSHA := hex.EncodeToString(hash[:])
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	build, err := unix.Sysctl("kern.osversion")
	if err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	if err := unix.Lstat(f.Bundle, &st); err != nil {
		t.Fatal(err)
	}
	watchdog := pin(filepath.Join(f.Bundle, "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron"))
	support := nativeprocess.RootScopedPlatformSupport{ReleaseID: "native-fixture-not-release", QualificationSHA256: sourceSHA, CompilerSHA256: sourceSHA,
		OS: "darwin", OSBuild: build, Architecture: runtime.GOARCH, Compiler: "approved-roots-seatbelt-v1", FilesystemClass: "system-apfs-kernel-mount-boundaries-v1", HostTrust: "protected-host-pathnames-v1",
		Backend: pin(self), Watchdog: watchdog, Mechanism: pin("/usr/bin/sandbox-exec"), WatchdogSourceSHA256: sourceSHA,
		Imports: []nativeprocess.ExecutablePin{pin("/System/Library/Sandbox/Profiles/dyld-support.sb")}, Executables: []nativeprocess.ExecutablePin{pin("/bin/bash"), pin("/bin/sleep")},
		ProtectedBundle: &nativeprocess.ProtectedBundle{Path: f.Bundle, Identity: authority.RootIdentity{Device: fmt.Sprint(st.Dev), Inode: fmt.Sprint(st.Ino)}}}
	f.Launch.HostLifetimeID, f.Launch.ChildLaunchID = fmt.Sprintf("shell-host-%d", f.Generation), fmt.Sprintf("shell-child-%d", f.Generation)
	f.Launch.shell = &connectorShellConfig{runtimeID: f.Launch.ChildLaunchID, home: f.Launch.Home, support: support, watchdog: nativeprocess.WatchdogSelection{Executable: watchdog, Source: []byte(f.Source), SourceSHA256: sourceSHA}}
	if _, err := nativeprocess.NewRootScopedPlatformStrategy(context.Background(), support, accessrepo.Clock{}); err != nil {
		t.Fatal("native platform facts refused before any Shell admission", err)
	}
	q, err := QualifyProfile(f.Launch.Profile)
	if err != nil {
		t.Fatal(err)
	}
	computer, _, err := q.Roots()
	if err != nil {
		t.Fatal(err)
	}
	_ = q.Close()
	if _, err := newConnectorShellFactory(context.Background(), *f.Launch.shell, accessrepo.Clock{}, protectedComputerRoot(computer)); err != nil {
		t.Fatal("native Shell factory preflight refused before dispatch", err)
	}

	r, err := NewNativeRuntime(context.Background(), f.Launch, fmt.Sprintf("shell-backend-%d", f.Generation))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := r.Close(); err != nil {
			t.Error(err)
		}
	}()
	if r.connector.processes == nil || r.mutations == nil {
		t.Fatal("full fresh native Shell/mutation composition absent")
	}
	// Explicit disposable workspace consent, through the production publisher.
	var ws unix.Stat_t
	if err := unix.Lstat(f.Workspace, &ws); err != nil {
		t.Fatal(err)
	}
	fence, err := r.ingress.Deactivate(context.Background(), "shell-deactivate")
	if err != nil {
		t.Fatal(err)
	}
	generation := f.Generation + 1
	// Electron's saved Settings peer is explicit input in this Go-only fixture.
	// Shell execution, journal receipt and process terminal remain native.
	r.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: f.Launch.Profile.ProfileID, OwnerID: f.Launch.OwnerID, ComputerID: f.Launch.ComputerID, Generation: uint64(generation)}}}
	approval, _ := json.Marshal(map[string]any{"ownerId": f.Launch.OwnerID, "computerId": f.Launch.ComputerID, "generation": generation, "filePolicy": "approved-roots-v1", "workspaces": []any{map[string]any{"workspaceId": "00000000-0000-4000-8000-000000000004", "root": f.Workspace, "access": "write", "shellVerified": true, "rootIdentity": map[string]string{"device": fmt.Sprint(ws.Dev), "inode": fmt.Sprint(ws.Ino)}}}, "excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read", "workspace.write", "workspace.shell"}, "network": "none", "commands": authority.WorkspaceCommands, "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
	publication, err := r.ingress.Publish(context.Background(), "shell-publish", wire.ComputerAuthorityPublishRequest{Fence: fence.Fence, ExpectedStoreRevision: fence.StoreRevision, SettingsRevision: strconv.Itoa(generation), Approval: approval})
	if err != nil {
		t.Fatal(err)
	}
	peer := openNativeMutationPeer(t, r, *publication, strconv.Itoa(generation))
	checkNativeSelfTestShell(t, r, f.Generation)
	op := fmt.Sprintf("00000000-0000-4000-8000-%012d", f.Generation+100)
	command := fmt.Sprintf("printf native > shell-%d.txt", f.Generation)
	if f.Generation == 2 {
		command += "; /bin/sleep 8 &"
	}
	started := peer.call(t, "computer.process.start", op, wire.ComputerConnectorProcessStart{Execution: peer.opened.Execution, CallId: "shell-call", WorkspaceId: "00000000-0000-4000-8000-000000000004", RelativeCwd: ".", Command: command, Write: true})
	var start wire.ComputerConnectorProcessStarted
	if started.Status != "ok" || json.Unmarshal(started.Data, &start) != nil {
		t.Fatal("native Shell start refused", started.Status, started.Code)
	}
	end := time.Now().Add(10 * time.Second)
	var result wire.ComputerConnectorProcessResult
	for {
		read := peer.call(t, "computer.process.read", "", wire.ComputerConnectorProcessRead{Execution: peer.opened.Execution, CallId: "shell-read", OperationId: op, Handle: start.Handle, StdoutOffset: "0", StderrOffset: "0"})
		if read.Status != "ok" || json.Unmarshal(read.Data, &result) != nil || result.State == "unknown" {
			t.Fatal("native Shell observation unconfirmed; no retry", read.Status, read.Code)
		}
		if result.State != "running" {
			break
		}
		if !time.Now().Before(end) {
			t.Fatal("original Shell deadline; no retry")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 || result.GroupCleanup != "confirmed" || result.DescendantCleanup != "unverified" {
		t.Fatal("native Shell closure facts unavailable", result)
	}
	done := processCollectionDone(r.connector, op)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("original terminal publication missing")
	}
	r.mutations.mu.Lock()
	receipt := r.mutations.operations[op].process.publication
	r.mutations.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(f.Workspace, fmt.Sprintf("shell-%d.txt", f.Generation)))
	if err != nil || string(data) != "native" {
		t.Fatal("actual Shell write absent", err)
	}
	if err := peer.stream.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := r.connector.Close(context.Background(), "native-close", wire.ComputerConnectorClose{Binding: peer.opened.Endpoint.Binding}); err != nil {
		t.Fatal(err)
	}
	close := nativeSettingsCall(t, r, "core.fresh.close", "native-fresh-close", wire.CoreFreshClose{})
	if close.Status != "ok" || !strings.Contains(string(close.Data), `"drained":true`) {
		t.Fatal("actual current drain unconfirmed", close.Status, close.Code)
	}
	report, _ := json.Marshal(freshShellNativeResult{result.GroupCleanup, result.DescendantCleanup, receipt, true})
	if err := os.WriteFile(input+".result", report, 0600); err != nil {
		t.Fatal(err)
	}
}
