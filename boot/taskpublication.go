package boot

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

// parsePublishedCodex maps the trusted desktop's parsed source-witness projection.
// It issues no Task admission or physical qualification. The selected metadata is
// tied to this SAME Computer publication; restricted native scopes which the
// existing Codex Selection cannot enforce stay unavailable instead of widening.
func (s *ComputerIngress) parsePublishedCodex(in *wire.TaskCodexSource, approval authority.Approval) (*codexclient.AuthoritySnapshot, error) {
	if in == nil {
		return nil, nil
	}
	invalid := func() (*codexclient.AuthoritySnapshot, error) { return nil, task.ErrUnavailable }
	if validateIngress("TaskCodexSource", *in) != nil || !in.ProjectBoundCreateStatus || in.BaseSchemaSha256 == in.HandoffSchemaSha256 {
		return invalid()
	}
	var generations [5]uint64
	for i, v := range []string{in.HostGeneration, in.ComputerGeneration, in.GrantHostGeneration, in.GrantComputerGeneration, in.VerifiedComputerGeneration} {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil || n == 0 || n > 9007199254740991 {
			return invalid()
		}
		generations[i] = n
	}
	if generations[0] != generations[2] || generations[1] != generations[3] || generations[1] != generations[4] || generations[1] != approval.Generation || in.WorkspaceId != in.VerifiedWorkspaceId || in.Project.GitCommonDirectory != in.Writer.GitCommonDirectory {
		return invalid()
	}
	for _, p := range []string{in.Project.Path, in.Writer.Path, in.Project.GitCommonDirectory, in.Writer.GitCommonDirectory, in.ExecutablePath, in.SocketPath, in.ExpectedCodexHome} {
		if !task.Text(p, 4096) || !filepath.IsAbs(p) || p == string(filepath.Separator) || filepath.Clean(p) != p {
			return invalid()
		}
	}
	granted, e1 := time.Parse(time.RFC3339Nano, in.GrantedAt)
	expires, e2 := time.Parse(time.RFC3339Nano, in.ExpiresAt)
	if e1 != nil || e2 != nil || granted.Nanosecond()%1000000 != 0 || expires.Nanosecond()%1000000 != 0 || !expires.After(granted) || expires.Sub(granted) > 12*time.Hour || expires.After(approval.ExpiresAt) {
		return invalid()
	}
	matched := 0
	for _, w := range approval.Workspaces {
		if w.WorkspaceID != in.WorkspaceId {
			continue
		}
		matched++
		if w.Root != in.Writer.Path || w.RootIdentity.Device != in.Writer.Device || w.RootIdentity.Inode != in.Writer.Inode || w.GitMetadata == nil || w.GitMetadata.CommonDirectory != in.Writer.GitCommonDirectory || !w.GitHistoryApproved || string(w.Access) != in.Access || (in.Sandbox == "workspace-write" && w.Access != authority.WriteAccess) {
			return invalid()
		}
	}
	if matched != 1 {
		return invalid()
	}
	for _, x := range approval.ExcludedPaths {
		if x.WorkspaceID == in.WorkspaceId {
			return invalid()
		}
	}
	root := func(r wire.TaskSourceRoot) task.Root {
		return task.Root{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	x := codexclient.Selection{
		Binding: task.Binding{Provider: task.Codex, ProfileID: s.peer.ProfileId,
			ProjectID: in.ProjectId, WorkspaceID: in.WorkspaceId, Project: root(in.Project), Writer: root(in.Writer),
			ModelAlias: in.ModelAlias, Model: in.Model, ConfigDigest: in.ConfigDigest},
		ExecutablePath: in.ExecutablePath, ExecutableSHA256: in.ExecutableSha256,
		SocketPath: in.SocketPath, ExpectedCodexHome: in.ExpectedCodexHome,
		Protocol: in.Protocol, SchemaSHA256: in.HandoffSchemaSha256,
		Sandbox: in.Sandbox, ApprovalPolicy: in.ApprovalPolicy, GrantedAt: granted.UTC(), ExpiresAt: expires.UTC(),
	}
	if in.Effort != nil {
		x.Binding.Effort = *in.Effort
	}
	a := codexclient.AuthoritySnapshot{
		State: codexclient.AuthorityReady, Selection: x,
		HostGeneration: generations[0], ComputerGeneration: generations[1],
		GrantHostGeneration: generations[2], GrantComputerGeneration: generations[3],
		Approved: true, Access: codexclient.WorkspaceAccess(in.Access),
		VerifiedWorkspaceID: in.VerifiedWorkspaceId, VerifiedComputerGeneration: generations[4],
		Handoff: codexclient.HandoffQualification{ExecutablePath: in.ExecutablePath, ExecutableSHA256: in.ExecutableSha256,
			Protocol: in.Protocol, SchemaSHA256: in.HandoffSchemaSha256, HostGeneration: generations[0], ProjectBoundCreateStatus: true},
	}
	if q := in.Followup; q != nil {
		if q.Protocol != x.Protocol || q.BaseSchemaSha256 != x.SchemaSHA256 || q.SchemaSha256 == x.SchemaSHA256 || q.SchemaSha256 == in.BaseSchemaSha256 {
			return invalid()
		}
		a.Followup = codexclient.FollowupQualification{Selection: x, Witness: codexclient.FollowupSchemaWitness{
			Kind: q.Kind, Protocol: q.Protocol, BaseSchemaSHA256: q.BaseSchemaSha256, SchemaSHA256: q.SchemaSha256,
		}}
	}
	return &a, nil
}

// Current reads take only the existing negative fence and publication mutexes,
// in that order. They perform no IO, clock callback, Task/Chat reentry or wait on
// the effects lock. The Computer active bit and journal/publication revisions
// are NOT the Task selection identity. Known identical metadata may be republished
// without replacing a retained Task client; a withdrawn/unknown owner cannot.
func (s *ComputerIngress) currentCodexAuthority(ctx context.Context, hostID, scratch string) (codexclient.AuthoritySnapshot, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !validIngressID(hostID) || !task.Text(scratch, 4096) || strings.TrimSpace(scratch) != scratch || !filepath.IsAbs(scratch) || scratch == string(filepath.Separator) || filepath.Clean(scratch) != scratch {
		return codexclient.AuthoritySnapshot{}, task.ErrUnavailable
	}
	s.guard.mu.Lock()
	defer s.guard.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unknown {
		return codexclient.AuthoritySnapshot{}, task.ErrUnknown
	}
	p := s.publication
	if s.guard.exhausted || p == nil || p.taskCodex == nil || p.receipt.Fence != strconv.FormatUint(s.guard.revision, 10) || s.guard.revision == 0 {
		return codexclient.AuthoritySnapshot{}, task.ErrUnavailable
	}
	a := *p.taskCodex
	a.Selection.Binding.HostID, a.Selection.ScratchRoot = hostID, scratch
	if a.Followup != (codexclient.FollowupQualification{}) {
		a.Followup.Selection = a.Selection
	}
	return a, nil
}

// PublishedCodexTaskSource contains trusted Root-held lifetime inputs, not wire
// authority. HostID and private scratch must remain fixed for the selected host;
// actual native qualification and exclusive journal handoff are still required.
type PublishedCodexTaskSource struct {
	Current             *ComputerIngress
	HostID, ScratchRoot string
	Verifier            codexclient.SelectionVerifier
	Now                 func() time.Time
	Delivery            port.Delivery
	ChatHandle          string
	Parent              controlct.Parent
}

// BeginPublishedCodex feeds the existing current-source selector from the exact
// live publication owner. It introduces no engine, reverse RPC or disk cache.
func (s *TaskSelector) BeginPublishedCodex(ctx context.Context, input PublishedCodexTaskSource) (*wire.TaskHandle, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	p := s.surface.profile
	if input.Current == nil || input.Current.peer != p.peer || input.Current.ownerID != p.owner {
		return nil, taskRuntimeError(task.ErrIdentity)
	}
	read := func(ctx context.Context) (codexclient.AuthoritySnapshot, error) {
		if err := p.available(ctx); err != nil {
			return codexclient.AuthoritySnapshot{}, err
		}
		return input.Current.currentCodexAuthority(ctx, input.HostID, input.ScratchRoot)
	}
	selected, err := read(ctx)
	if err != nil {
		return nil, taskRuntimeError(err)
	}
	return s.BeginCurrentCodex(ctx, CurrentCodexTaskSource{Authority: codexclient.SelectionAuthorityOptions{
		Selected: selected, ReadCurrent: read, Verifier: input.Verifier, Now: input.Now,
	}, Delivery: input.Delivery, ChatHandle: input.ChatHandle, Parent: input.Parent})
}
