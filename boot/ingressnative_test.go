//go:build darwin

package boot

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
	"golang.org/x/sys/unix"
)

var ingressNative = flag.Bool("ingress-native", false, "Run the Lead-owned disposable normal CLI composition journey")

// This runs the normal CLI parser and registry with native profile/stores and
// real framing. Consent and workspace are synthetic; no Electron, packaged
// binary, installed state, provider or clean successor/restart is qualified.
func TestNativeCLIComputerPublicationAdmissionAndRead(t *testing.T) {
	if !*ingressNative {
		t.Skip("Requires the exclusive native lane and -ingress-native")
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(cwd, "..", "_output", "tmp")
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(parent, "g1-native-")
	if err != nil {
		t.Fatal(err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Owned disposable fixture: %s", root)
	private := func(name string) string {
		p := filepath.Join(root, name)
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
		return p
	}
	profile, workspace, home := private("profile"), private("workspace"), private("home")
	for _, name := range []string{"computer", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(profile, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	const contents = "Real native Go ingress, synthetic owner consent.\n"
	if err := os.WriteFile(filepath.Join(workspace, "note.md"), []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	var ps, ws unix.Stat_t
	if err := unix.Lstat(profile, &ps); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lstat(workspace, &ws); err != nil {
		t.Fatal(err)
	}
	input, sender := io.Pipe()
	receiver, output := io.Pipe()
	var diagnostics bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- Run([]string{"serve", "--profile", "fixture", "--profile-root", profile, "--profile-device", fmt.Sprint(ps.Dev), "--profile-inode", fmt.Sprint(ps.Ino), "--owner", "owner", "--computer", "computer", "--home", home, "--store-mode", "create"}, input, output, &diagnostics)
	}()
	t.Cleanup(func() {
		_ = sender.Close()
		_ = receiver.Close()
		select {
		case code := <-done:
			if code != 0 {
				t.Errorf("CLI terminal %d: %s", code, diagnostics.String())
			}
			if !t.Failed() {
				if err := os.RemoveAll(root); err != nil {
					t.Error(err)
				}
			}
		case <-time.After(10 * time.Second):
			t.Error("CLI terminal unconfirmed; owned fixture retained")
		}
	})
	var peer *wire.Context
	count := 0
	invoke := func(method string, body any, operation string) *wire.Outcome {
		t.Helper()
		count++
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		call := wire.Request{Jsonrpc: "2.0", Id: fmt.Sprintf("request-%d", count), Method: method, Params: wire.Call{Context: peer, Body: raw}}
		if operation != "" {
			call.Params.OperationId = &operation
		}
		data, err := json.Marshal(call)
		if err != nil {
			t.Fatal(err)
		}
		type response struct {
			data []byte
			err  error
		}
		reply := make(chan response, 1)
		go func() {
			if err := ipc.WriteFrame(sender, data); err != nil {
				reply <- response{err: err}
				return
			}
			data, err := ipc.ReadFrame(receiver)
			reply <- response{data, err}
		}()
		select {
		case got := <-reply:
			if got.err != nil {
				t.Fatal(got.err)
			}
			var r wire.Response
			if err := json.Unmarshal(got.data, &r); err != nil {
				t.Fatal(err)
			}
			if r.Error != nil || r.Result == nil {
				t.Fatalf("protocol %s: %s", method, got.data)
			}
			return r.Result
		case <-time.After(10 * time.Second):
			t.Fatalf("%s response unknown; no replay", method)
		}
		return nil
	}
	ok := func(method string, body any, operation string) *wire.Outcome {
		t.Helper()
		r := invoke(method, body, operation)
		if r.Status != "ok" {
			t.Fatalf("%s: %+v", method, r)
		}
		return r
	}
	hello := ok("core.handshake", wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: BuildID, ProfileId: "fixture"}, "")
	peer = &hello.Context
	r := ok("computer.authority.deactivate", map[string]any{}, "deactivate-1")
	var fence wire.ComputerAuthorityDeactivateResponse
	if err := json.Unmarshal(r.Data, &fence); err != nil {
		t.Fatal(err)
	}
	approval := map[string]any{"ownerId": "owner", "computerId": "computer", "generation": 1, "workspaces": []any{map[string]any{"workspaceId": "work", "root": workspace, "access": "read", "rootIdentity": map[string]string{"device": fmt.Sprint(ws.Dev), "inode": fmt.Sprint(ws.Ino)}}}, "excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read"}, "network": "none", "commands": "none", "expiresAt": time.Now().Add(time.Hour).UnixMilli()}
	encoded, err := json.Marshal(approval)
	if err != nil {
		t.Fatal(err)
	}
	r = ok("computer.authority.publish", wire.ComputerAuthorityPublishRequest{Fence: fence.Fence, ExpectedStoreRevision: fence.StoreRevision, SettingsRevision: "1", Approval: encoded}, "publish-1")
	var published wire.ComputerAuthorityPublication
	if err := json.Unmarshal(r.Data, &published); err != nil {
		t.Fatal(err)
	}
	r = ok("chat.turn", wire.ChatComputerAdmissionRequest{Publication: published, SessionId: "session-1", TaskId: "task-1", TurnId: "turn-1", WorkspaceIds: []string{"work"}}, "admit-1")
	var admitted wire.ChatComputerAdmissionResponse
	if err := json.Unmarshal(r.Data, &admitted); err != nil {
		t.Fatal(err)
	}
	read := wire.ComputerReadRequest{OwnerId: admitted.OwnerId, SessionId: admitted.SessionId, TaskId: admitted.TaskId, TaskEpoch: admitted.TaskEpoch, ParticipantId: admitted.ParticipantId, TurnId: admitted.TurnId, Generation: admitted.Generation, CallId: "read-1", WorkspaceId: "work", RelativePath: "note.md"}
	ok("computer.workspace.catalogue", wire.ComputerCatalogueRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: "catalogue-1"}, "")
	ok("computer.workspace.bootstrap", wire.ComputerBootstrapRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: "bootstrap-1", WorkspaceId: "work", RelativeDirectory: "."}, "")
	r = ok("computer.workspace.read", read, "")
	var result wire.ComputerReadResponse
	if err := json.Unmarshal(r.Data, &result); err != nil || result.Text != contents {
		t.Fatalf("native content mismatch: %v %s", err, r.Data)
	}
	ok("computer.authority.deactivate", map[string]any{}, "deactivate-2")
	read.CallId = "read-after-withdrawal"
	if r := invoke("computer.workspace.read", read, ""); r.Status == "ok" {
		t.Fatal("withdrawn authority disclosed content")
	}
}
