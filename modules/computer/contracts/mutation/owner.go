package mutation

import (
	"context"
	"errors"

	app "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// The root constructs either a selected one-attempt executor or a read-only
// retained observer. A request cannot choose owner/profile/computer/generation.
type OwnerContract struct {
	executor *app.OwnerService
	observer *app.OwnerObserver
}

func NewOwnerExecution(service *app.OwnerService) *OwnerContract {
	return &OwnerContract{executor: service}
}
func NewOwnerObservation(observer *app.OwnerObserver) *OwnerContract {
	return &OwnerContract{observer: observer}
}

type OwnerRequest struct {
	WorkspaceID string
	Operation   Operation
}
type OwnerObservation struct{ WorkspaceID, RelativePath string }
type OwnerResponse struct {
	OperationID, WorkspaceID string
	ComputerGeneration       uint64
	Phase, Publication       string
	Receipt                  *Receipt
	Failure                  *OutcomeFailure
}

func ValidateOwnerRequest(r OwnerRequest) error {
	if err := app.ValidateOwnerRequest(app.OwnerRequest{WorkspaceID: r.WorkspaceID, Operation: toAppOperation(r.Operation)}); err != nil {
		return ownerBoundary(err)
	}
	return nil
}

func (c *OwnerContract) Execute(ctx context.Context, r OwnerRequest) (*OwnerResponse, error) {
	if c == nil || c.executor == nil {
		return nil, ownerBoundary(nil)
	}
	out, err := c.executor.Execute(ctx, app.OwnerRequest{WorkspaceID: r.WorkspaceID, Operation: toAppOperation(r.Operation)})
	if err != nil || out == nil {
		return nil, ownerBoundary(err)
	}
	return ownerResult(out), nil
}
func (c *OwnerContract) Observe(ctx context.Context, r OwnerObservation) (*OwnerResponse, error) {
	if c == nil {
		return nil, ownerBoundary(nil)
	}
	var out *app.OwnerResponse
	var err error
	request := app.OwnerObservation{WorkspaceID: r.WorkspaceID, RelativePath: r.RelativePath}
	switch {
	case c.executor != nil:
		out, err = c.executor.Observe(ctx, request)
	case c.observer != nil:
		out, err = c.observer.Observe(ctx, request)
	default:
		return nil, ownerBoundary(nil)
	}
	if err != nil || out == nil {
		return nil, ownerBoundary(err)
	}
	return ownerResult(out), nil
}
func ownerResult(r *app.OwnerResponse) *OwnerResponse {
	out := &OwnerResponse{OperationID: r.OperationID, WorkspaceID: r.WorkspaceID, ComputerGeneration: r.ComputerGeneration, Phase: r.Phase, Publication: r.Publication}
	if v := r.Receipt; v != nil {
		out.Receipt = &Receipt{Operation: v.Operation, RelativePath: v.RelativePath, Bytes: v.Bytes, Replacements: v.Replacements, BeforeSHA256: cloneHash(v.BeforeSHA256), AfterSHA256: v.AfterSHA256}
	}
	if v := r.Failure; v != nil {
		out.Failure = &OutcomeFailure{Code: v.Code, Source: v.Source, Retry: "never"}
	}
	return out
}
func ownerBoundary(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) && f != nil && f.Source == "computer-approval" {
		switch f.Code {
		case "COMPUTER_APPROVAL_INVALID", "COMPUTER_PATH_INVALID", "COMPUTER_APPROVAL_STORE_UNAVAILABLE":
			return &Failure{Code: f.Code, Source: f.Source, Retry: "never"}
		}
	}
	return boundary(err)
}
