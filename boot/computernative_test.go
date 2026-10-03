//go:build darwin || linux

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	chatadmission "github.com/legrch/farol/modules/chat/app/services/admission"
	chatlifecycle "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/chat/infra/gate"
	chatrepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

var computerNativeEnabled = flag.Bool("computer-root-native", false, "Run Lead-reserved native Computer/Chat root composition tests")

// Actual native stores, Chat owner/gate/known journal receipt, Computer policy,
// per-operation lease, canonical transport and filesystem run together. Roots
// and consent are disposable test inputs: no Electron startup, installed state,
// real owner consent, provider/browser or crash/reopen acceptance is claimed.
func TestComputerNativeSelectedChatJournalToWorkspace(t *testing.T) {
	if !*computerNativeEnabled {
		t.Skip("Requires Lead native lane and -computer-root-native")
	}
	ctx := context.Background()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	private := func(name string) string {
		p := filepath.Join(base, name)
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
		return p
	}
	state, journal, workspace, home := private("computer-state"), private("chat-journal"), private("workspace"), private("home")
	const contents = "Disposable Computer read through the actual Chat owner.\n"
	if err := os.WriteFile(filepath.Join(workspace, "note.md"), []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "AGENTS.md"), []byte("Disposable instructions; no authority.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var js, ws unix.Stat_t
	if err := unix.Lstat(journal, &js); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lstat(workspace, &ws); err != nil {
		t.Fatal(err)
	}
	profile, backend := "disposable-profile", "actual-fixture-backend"
	repo, err := chatrepo.New(ctx, chatrepo.Root{Path: journal, ProfileID: profile, Device: uint64(js.Dev), Inode: uint64(js.Ino), OwnerUID: uint32(os.Geteuid())}, chatrepo.Limits{Bytes: 1024 * 1024, Records: 256})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := repo.Close(); err != nil {
			t.Error(err)
		}
	})
	owner, err := chatlifecycle.New(ctx, chatport.JournalScope{ProfileID: profile, BackendGeneration: backend}, chatlifecycle.Dependencies{Gate: gate.New(), Journal: repo})
	if err != nil {
		t.Fatal(err)
	}
	binding := chatport.TurnBinding{ProfileID: profile, BackendGeneration: backend, OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "participant", TurnID: "turn", OperationID: "admit-turn", TurnGeneration: 11}
	intent := sha256.Sum256([]byte("bounded-native-fixture"))
	handle, err := owner.Admit(ctx, binding, hex.EncodeToString(intent[:]))
	if err != nil || handle == nil {
		t.Fatalf("known Chat admission: %v", err)
	}
	admitted, err := chatadmission.New(handle)
	if err != nil {
		t.Fatal(err)
	}
	store, err := accessrepo.Create(state, accessrepo.Binding{ProfileID: profile, OwnerID: binding.OwnerID, ComputerID: "computer"}, accessrepo.Clock{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	approval := authority.Approval{OwnerID: binding.OwnerID, ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: workspace, Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: fmt.Sprint(ws.Dev), Inode: fmt.Sprint(ws.Ino)}}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: time.Now().Truncate(time.Millisecond).Add(time.Hour)}
	if err := store.UpdateApproval(ctx, 0, approval); err != nil {
		t.Fatal(err)
	}
	participant, err := store.Admit(ctx, 1, authority.Admission{Identity: authority.Identity{OwnerID: binding.OwnerID, SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch}, AuthorityID: "authority", ComputerID: approval.ComputerID, ComputerGeneration: approval.Generation, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: workspace, Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: approval.ExpiresAt}}, authority.ParticipantAdmission{ParticipantID: binding.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	route, err := ComputerForChat(store, chatct.New(admitted), execution.Ceiling{Participant: *participant, Approval: approval}, filesystem.New(home))
	if err != nil {
		t.Fatal(err)
	}
	methods := route.Methods(wire.Context{ProfileId: profile, BackendGeneration: backend})
	read := wire.ComputerReadRequest{OwnerId: binding.OwnerID, SessionId: binding.SessionID, TaskId: binding.TaskID, TaskEpoch: "7", ParticipantId: binding.ParticipantID, TurnId: binding.TurnID, Generation: "11", CallId: "read-note", WorkspaceId: "work", RelativePath: "note.md"}
	invoke := func(method string, body any) *desktop.Outcome {
		t.Helper()
		out := computerInvoke(t, methods[method], body)
		if out.Status != "ok" {
			t.Fatalf("%s: %+v", method, out)
		}
		return out
	}
	out := invoke("computer.workspace.read", read)
	var decoded map[string]any
	if json.Unmarshal(out.Data, &decoded) != nil || decoded["text"] != contents {
		t.Fatalf("native read payload: %s", out.Data)
	}
	invoke("computer.workspace.catalogue", wire.ComputerCatalogueRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: "catalogue"})
	invoke("computer.workspace.bootstrap", wire.ComputerBootstrapRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: "bootstrap", WorkspaceId: "work", RelativeDirectory: "."})
	if err := store.RevokeParticipant(ctx, 2, binding.ParticipantID); err != nil {
		t.Fatal(err)
	}
	out = computerInvoke(t, methods["computer.workspace.read"], read)
	if out.Status != "refused" || out.Code != "COMPUTER_PARTICIPANT_NOT_FOUND" {
		t.Fatalf("revoked native owner disclosed: %+v", out)
	}
}
