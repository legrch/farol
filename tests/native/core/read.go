//go:build darwin

// Test-only executable: trusted startup supplies a disposable root and authority.
// This is neither a production mode nor installed approval/persistence wiring.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

type clock struct{ at time.Time }

func (c clock) Now() time.Time { return c.at }

type observedWorkspace struct {
	*filesystem.Workspace
	access *accessrepo.Repository
	revoke bool
	race   bool
}

func (w observedWorkspace) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	if w.race {
		// Synthetic route-classification proof only; Computer owns real FS races.
		return nil, &authority.Failure{Code: "WORKSPACE_RACE_DETECTED", Source: "native-workspace", Retry: "never"}
	}
	out, err := w.Workspace.Read(ctx, r)
	// Deterministic trusted test seam, after native IO and before disclosure.
	if w.revoke {
		w.access.RevokeParticipant("participant")
	}
	fmt.Fprintln(os.Stderr, "native-read")
	return out, err
}

type lostResponse struct {
	writes int
	target io.WriteCloser
}

func (w *lostResponse) Write(p []byte) (int, error) {
	w.writes++
	if w.writes > 2 {
		return len(p), nil
	} // Keep handshake; drop the read frame only.
	return w.target.Write(p)
}

func (w *lostResponse) Close() error { return w.target.Close() }

func run() error {
	rootArg := flag.String("root", "", "trusted disposable physical workspace")
	revoke := flag.Bool("revoke-after-read", false, "trusted revocation seam")
	loss := flag.Bool("drop-read-response", false, "trusted response loss seam")
	race := flag.Bool("race-refusal", false, "trusted synthetic native refusal seam")
	flag.Parse()
	if *rootArg == "" || flag.NArg() != 0 {
		return fmt.Errorf("disposable root required")
	}
	root, err := filepath.EvalSymlinks(*rootArg)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(root) {
		return fmt.Errorf("absolute root required")
	}
	var stat unix.Stat_t
	if err := unix.Lstat(root, &stat); err != nil {
		return err
	}
	now := time.Now().UTC()
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 17, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "workspace", Root: root, Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(uint64(stat.Ino), 10)}}}, Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	grant, err := authority.Derive(approval, authority.Admission{AuthorityID: "authority", Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, ComputerID: "computer", ComputerGeneration: 17, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "workspace", Root: root, Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}}, now)
	if err != nil {
		return err
	}
	participant, err := authority.Create(*grant, authority.ParticipantAdmission{ParticipantID: "participant", Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		return err
	}
	access := accessrepo.New()
	access.PutApproval(approval)
	access.PutParticipant(*participant)
	native := observedWorkspace{Workspace: filesystem.New(root + "-home"), access: access, revoke: *revoke, race: *race}
	contract := workspacect.New(workspacesvc.New(access, native, clock{at: now}))
	peer := wire.Context{ProfileId: "k1-disposable", BackendGeneration: "k1-incarnation"}
	server, err := desktop.New(desktop.Config{BuildID: "k1-test", ProfileID: peer.ProfileId, Generation: peer.BackendGeneration, Methods: map[string]desktop.Method{"computer.workspace.read": desktop.ReadMethod(contract, peer)}})
	if err != nil {
		return err
	}
	var out io.WriteCloser = os.Stdout
	if *loss {
		out = &lostResponse{target: out}
	}
	return server.Serve(context.Background(), os.Stdin, out)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fixture failed")
		os.Exit(1)
	}
}
