package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	browsect "github.com/legrch/farol/modules/computer/contracts/browse"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func (s *ComputerIngress) settingsSearch(ctx context.Context, in wire.ComputerSettingsSearchRequest) (*wire.ComputerSettingsSearchResponse, error) {
	if ctx == nil || ctx.Err() != nil || validateIngress("ComputerSettingsSearchRequest", in) != nil || s.native == nil {
		return nil, computerUnavailable()
	}
	if err := s.refreshCurrentApproval(ctx); err != nil {
		return nil, err
	}
	contract, err := s.settingsContract(ctx, in.Publication)
	if err != nil {
		return nil, err
	}
	out, err := contract.Search(ctx, browsect.SearchRequest{WorkspaceID: in.WorkspaceId, RelativePath: in.RelativePath, Pattern: in.Pattern})
	if err != nil {
		return nil, err
	}
	if out == nil || len(out.Matches) > 100 {
		return nil, computerUnavailable()
	}
	matches := make([]wire.ComputerSearchMatch, len(out.Matches))
	for i, match := range out.Matches {
		matches[i] = wire.ComputerSearchMatch{Path: match.Path, Line: strconv.FormatUint(match.Line, 10), Text: match.Text, Truncated: match.Truncated}
	}
	encoded, err := json.Marshal(matches)
	if err != nil {
		return nil, err
	}
	return &wire.ComputerSettingsSearchResponse{Publication: in.Publication, WorkspaceId: out.WorkspaceID, RelativePath: out.RelativePath, Pattern: out.Pattern,
		Root: wire.ComputerSettingsRoot{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode}, Matches: encoded,
		ResultLimited: out.ResultLimited, ScanLimited: out.ScanLimited}, nil
}

func (s *ComputerIngress) settingsSearchMethod() desktop.Method {
	return desktop.Method{Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSettingsSearchRequest", r.Body) != nil {
			return invalidIngress()
		}
		var body wire.ComputerSettingsSearchRequest
		if json.Unmarshal(r.Body, &body) != nil {
			return invalidIngress()
		}
		value, err := s.settingsSearch(ctx, body)
		var failure *browsect.Failure
		if errors.As(err, &failure) {
			return &desktop.Outcome{Status: "refused", Code: failure.Code}, nil
		}
		return ingressOutcome(value, err)
	}}
}
