package currentsource

import (
	"context"

	app "github.com/legrch/farol/modules/task/app/services/currentsource"
)

type Request struct {
	Settings  []byte
	NowMillis int64
}
type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Contract struct{ service *app.Service }

func New(service *app.Service) *Contract { return &Contract{service: service} }

func (c *Contract) Resolve(ctx context.Context, in Request) (*Response, error) {
	if c == nil || c.service == nil || ctx == nil || ctx.Err() != nil {
		return nil, &Failure{Code: app.Unavailable}
	}
	if len(in.Settings) > app.MaxSnapshotBytes {
		return nil, &Failure{Code: app.Invalid}
	}
	out, err := c.service.Resolve(ctx, append([]byte(nil), in.Settings...), in.NowMillis)
	if ctx.Err() != nil {
		return nil, &Failure{Code: app.Unavailable}
	}
	if err != nil {
		if failure, ok := err.(*app.Failure); ok && failure.Code == app.Invalid {
			return nil, &Failure{Code: app.Invalid}
		}
		return nil, &Failure{Code: app.Unavailable}
	}
	if out == nil || (out.Status != app.Available && out.Status != app.Absent) || (out.Status == app.Available) != (out.Source != nil) || (out.Status == app.Absent && out.Read != nil) {
		return nil, &Failure{Code: app.Unavailable}
	}
	response := &Response{Status: out.Status}
	if out.Source != nil {
		response.Source = mapSource(out.Source)
	}
	if out.Read != nil {
		response.Read = &ReadReference{ThreadID: out.Read.ThreadID, TurnID: out.Read.TurnID}
	}
	if ctx.Err() != nil {
		return nil, &Failure{Code: app.Unavailable}
	}
	return response, nil
}
func mapRoot(in app.Root) Root {
	return Root{Path: in.Path, Device: in.Device, Inode: in.Inode, GitCommonDirectory: in.GitCommonDirectory}
}
func mapSource(in *app.CodexSource) *CodexSource {
	out := &CodexSource{
		ProjectID:                  in.ProjectID,
		WorkspaceID:                in.WorkspaceID,
		ModelAlias:                 in.ModelAlias,
		Model:                      in.Model,
		ConfigDigest:               in.ConfigDigest,
		ExecutablePath:             in.ExecutablePath,
		ExecutableSHA256:           in.ExecutableSHA256,
		Protocol:                   in.Protocol,
		BaseSchemaSHA256:           in.BaseSchemaSHA256,
		HandoffSchemaSHA256:        in.HandoffSchemaSHA256,
		SocketPath:                 in.SocketPath,
		ExpectedCodexHome:          in.ExpectedCodexHome,
		Sandbox:                    in.Sandbox,
		ApprovalPolicy:             in.ApprovalPolicy,
		GrantedAt:                  in.GrantedAt,
		ExpiresAt:                  in.ExpiresAt,
		HostGeneration:             in.HostGeneration,
		ComputerGeneration:         in.ComputerGeneration,
		GrantHostGeneration:        in.GrantHostGeneration,
		GrantComputerGeneration:    in.GrantComputerGeneration,
		VerifiedWorkspaceID:        in.VerifiedWorkspaceID,
		VerifiedComputerGeneration: in.VerifiedComputerGeneration,
		Access:                     in.Access,
		ProjectBoundCreateStatus:   in.ProjectBoundCreateStatus,
		Project:                    mapRoot(in.Project),
		Writer:                     mapRoot(in.Writer),
	}
	if in.Effort != nil {
		value := *in.Effort
		out.Effort = &value
	}
	if in.Followup != nil {
		out.Followup = &Followup{Kind: in.Followup.Kind, Protocol: in.Followup.Protocol, BaseSchemaSHA256: in.Followup.BaseSchemaSHA256, SchemaSHA256: in.Followup.SchemaSHA256}
	}
	return out
}
