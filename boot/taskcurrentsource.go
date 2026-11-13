package boot

import (
	"context"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	taskport "github.com/legrch/farol/modules/task/app/port"
	sourceapp "github.com/legrch/farol/modules/task/app/services/currentsource"
	modelapp "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	sourcect "github.com/legrch/farol/modules/task/contracts/currentsource"
	"github.com/legrch/farol/modules/task/domain"
	settingsnative "github.com/legrch/farol/modules/task/infra/currentsettings"
	modelnative "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

// This private composition port has no desktop override. Saved facts are parsed
// at the host boundary; the Task owner derives eligibility and exact metadata.
// Computer then joins that result to the same original approval publication.
type taskCurrentSourceResolver interface {
	Resolve(context.Context, sourcect.Request) (*sourcect.Response, error)
}

func newTaskCurrentSource() *sourcect.Contract {
	policy := modelapp.New(modelnative.JSONDecoder{}, modelnative.SHA256Digester{}, []string{"codex"})
	return sourcect.New(sourceapp.New(settingsnative.JSONDecoder{}, taskSourceModelResolver{policy}))
}

// Consumer-owned port mapping; neither application service imports its sibling.
type taskSourceModelResolver struct{ policy *modelapp.Service }

func (a taskSourceModelResolver) ResolveTaskSourceModel(ctx context.Context, raw []byte) (taskport.TaskSourceModelResolution, error) {
	if ctx == nil || ctx.Err() != nil || a.policy == nil {
		return taskport.TaskSourceModelResolution{}, task.ErrUnavailable
	}
	resolved := a.policy.Resolve(raw, []byte(`{"harness":"codex"}`))
	if ctx.Err() != nil {
		return taskport.TaskSourceModelResolution{}, task.ErrUnavailable
	}
	out := taskport.TaskSourceModelResolution{Status: string(resolved.Status)}
	if resolved.Selection != nil {
		x := resolved.Selection
		out.Selection = &taskport.TaskSourceModelSelection{Harness: x.Harness, ModelAlias: x.ModelAlias, Model: x.Model, ConfigSHA256: resolved.ConfigSHA256}
		if x.Effort != nil {
			value := *x.Effort
			out.Selection.Effort = &value
		}
	}
	return out, nil
}

func (s *ComputerIngress) deriveTaskCurrentSource(ctx context.Context, facts *wire.TaskCurrentSourceFacts) (*wire.TaskCodexSource, *wire.TaskCodexReadSelection, error) {
	// Computer-only producers may explicitly omit Task metadata. Omission clears
	// it; no positive TS-derived selection or fallback is admitted on the wire.
	if facts == nil {
		return nil, nil, nil
	}
	if s.taskCurrentSource == nil || ctx == nil || ctx.Err() != nil {
		return nil, nil, task.ErrUnavailable
	}
	now, err := strconv.ParseInt(facts.NowMillis, 10, 64)
	if err != nil || strconv.FormatInt(now, 10) != facts.NowMillis || now < -9007199254740991 || now > 9007199254740991 {
		return nil, nil, task.ErrUnavailable
	}
	result, err := s.taskCurrentSource.Resolve(ctx, sourcect.Request{Settings: []byte(facts.Snapshot), NowMillis: now})
	if ctx.Err() != nil || err != nil || result == nil {
		return nil, nil, task.ErrUnavailable
	}
	switch result.Status {
	case sourceapp.Absent:
		if result.Source != nil || result.Read != nil {
			return nil, nil, task.ErrUnavailable
		}
		return nil, nil, nil
	case sourceapp.Available:
		if result.Source == nil {
			return nil, nil, task.ErrUnavailable
		}
	default:
		return nil, nil, task.ErrUnavailable
	}
	x := result.Source
	root := func(r sourcect.Root) wire.TaskSourceRoot {
		return wire.TaskSourceRoot{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	out := &wire.TaskCodexSource{
		ProjectId: x.ProjectID, WorkspaceId: x.WorkspaceID, Project: root(x.Project), Writer: root(x.Writer),
		ModelAlias: x.ModelAlias, Model: x.Model, ConfigDigest: x.ConfigDigest,
		ExecutablePath: x.ExecutablePath, ExecutableSha256: x.ExecutableSHA256, Protocol: x.Protocol,
		BaseSchemaSha256: x.BaseSchemaSHA256, HandoffSchemaSha256: x.HandoffSchemaSHA256,
		SocketPath: x.SocketPath, ExpectedCodexHome: x.ExpectedCodexHome, Sandbox: x.Sandbox, ApprovalPolicy: x.ApprovalPolicy,
		GrantedAt: x.GrantedAt, ExpiresAt: x.ExpiresAt, HostGeneration: x.HostGeneration, ComputerGeneration: x.ComputerGeneration,
		GrantHostGeneration: x.GrantHostGeneration, GrantComputerGeneration: x.GrantComputerGeneration,
		VerifiedWorkspaceId: x.VerifiedWorkspaceID, VerifiedComputerGeneration: x.VerifiedComputerGeneration,
		Access: x.Access, ProjectBoundCreateStatus: x.ProjectBoundCreateStatus,
	}
	if x.Effort != nil {
		value := *x.Effort
		out.Effort = &value
	}
	if x.Followup != nil {
		q := x.Followup
		out.Followup = &wire.TaskSourceFollowup{Kind: q.Kind, Protocol: q.Protocol, BaseSchemaSha256: q.BaseSchemaSHA256, SchemaSha256: q.SchemaSHA256}
	}
	var read *wire.TaskCodexReadSelection
	if result.Read != nil {
		read = &wire.TaskCodexReadSelection{ThreadId: result.Read.ThreadID, TurnId: result.Read.TurnID}
	}
	return out, read, nil
}
