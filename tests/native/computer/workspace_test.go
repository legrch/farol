//go:build darwin

package computer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"golang.org/x/sys/unix"
)

type clock struct{ at time.Time }

func (c clock) Now() time.Time { return c.at }

type revokeAfterRead struct {
	native *filesystem.Workspace
	revoke func()
}

func (w revokeAfterRead) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	out, err := w.native.Read(ctx, r)
	w.revoke()
	return out, err
}
func (w revokeAfterRead) List(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
	return w.native.List(ctx, r)
}

func admittedFixture(t *testing.T) (string, *accessrepo.Repository, clock, workspacect.ReadRequest) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	var stat unix.Stat_t
	if err := unix.Lstat(root, &stat); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 2, 20, 0, 0, 0, time.UTC)
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 17,
		Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "workspace", Root: root, Access: authority.ReadAccess,
			RootIdentity: authority.RootIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(uint64(stat.Ino), 10)}}},
		Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	grant, err := authority.Derive(a, authority.Admission{AuthorityID: "authority", Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, ComputerID: "computer", ComputerGeneration: 17,
		Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "workspace", Root: root, Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}}, now)
	if err != nil {
		t.Fatal(err)
	}
	participant, err := authority.Create(*grant, authority.ParticipantAdmission{ParticipantID: "participant", Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	request := workspacect.ReadRequest{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993, ParticipantID: "participant", TurnID: "turn", Generation: 9007199254740995, CallID: "call", WorkspaceID: "workspace", RelativePath: "note.md"}
	store := accessrepo.New()
	store.PutParticipant(*participant)
	store.PutApproval(a)
	return root, store, clock{at: now}, request
}

func TestPublishedReadUsesNativeBytesAndPreservesLosslessCorrelation(t *testing.T) {
	root, access, clock, request := admittedFixture(t)
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("# Native 🌊"), 0600); err != nil {
		t.Fatal(err)
	}
	contract := workspacect.New(workspacesvc.New(access, filesystem.New(root+"-home"), clock))
	out, err := contract.Read(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "# Native 🌊" || out.Bytes != 13 || len(out.SHA256) != 64 || out.TaskEpoch != request.TaskEpoch || out.Generation != request.Generation || out.CallID != "call" || out.WorkspaceID != "workspace" {
		t.Fatalf("wrong native/correlation result %+v", out)
	}
	request.Range = &workspacect.Range{Offset: 0, Length: 4}
	ranged, err := contract.Read(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if ranged.SHA256 != "" || ranged.Page == nil || ranged.Page.NextOffset == nil || *ranged.Page.NextOffset != 4 {
		t.Fatalf("wrong window %+v", ranged)
	}
	listed, err := contract.List(context.Background(), workspacect.ListRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: "."})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Entries) != 1 || listed.Entries[0] != "note.md" {
		t.Fatalf("wrong native list %+v", listed)
	}
}
func TestNativeOutputCannotDiscloseAfterGrantRevocation(t *testing.T) {
	root, access, clock, request := admittedFixture(t)
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	native := revokeAfterRead{native: filesystem.New(root + "-home"), revoke: func() { access.RevokeParticipant("participant") }}
	contract := workspacect.New(workspacesvc.New(access, native, clock))
	out, err := contract.Read(context.Background(), request)
	if out != nil {
		t.Fatal("revoked native result disclosed")
	}
	var failure *workspacect.Failure
	if !errors.As(err, &failure) || failure.Code != "COMPUTER_PARTICIPANT_NOT_FOUND" || failure.Retry != "never" {
		t.Fatalf("wrong revocation %v", err)
	}
}
