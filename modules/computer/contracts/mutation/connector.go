package mutation

import (
	"context"

	app "github.com/legrch/farol/modules/computer/app/services/mutation"
)

// Composition selects either one execution facade or a current read-only
// observer. Requests cannot select an owner, origin, generation or write lease.
type ConnectorContract struct {
	executor *app.ConnectorService
	observer *app.ConnectorObserver
}

func NewConnectorExecution(service *app.ConnectorService) *ConnectorContract {
	return &ConnectorContract{executor: service}
}

func NewConnectorObservation(observer *app.ConnectorObserver) *ConnectorContract {
	return &ConnectorContract{observer: observer}
}

type ConnectorRequest struct {
	WorkspaceID string
	Operation   Operation
}

type ConnectorObservation struct{ WorkspaceID, RelativePath string }

// ConnectorOrigin is content-free original host/call correlation, not current
// authority. Its values are independent of the app and domain DTOs.
type ConnectorOrigin struct {
	BuildID, BackendGeneration, RuntimeID            string
	ConnectorGeneration                              uint64
	SessionID, TaskID, ParticipantID, TurnID, CallID string
	TaskEpoch, Generation                            uint64
	Operation                                        string
}

type ConnectorResponse struct {
	OperationID, WorkspaceID, RelativePath string
	ComputerGeneration                     uint64
	Origin                                 ConnectorOrigin
	Phase, Publication                     string
	Receipt                                *Receipt
	Failure                                *OutcomeFailure
}

// ValidateConnectorRequest checks shape only; it selects no execution authority.
func ValidateConnectorRequest(r ConnectorRequest) error {
	if err := app.ValidateOwnerRequest(app.OwnerRequest{WorkspaceID: r.WorkspaceID, Operation: toAppOperation(r.Operation)}); err != nil {
		return ownerBoundary(err)
	}
	return nil
}

func (c *ConnectorContract) Execute(ctx context.Context, r ConnectorRequest) (*ConnectorResponse, error) {
	if c == nil || c.executor == nil {
		return nil, ownerBoundary(nil)
	}
	out, err := c.executor.Execute(ctx, app.ConnectorRequest{WorkspaceID: r.WorkspaceID, Operation: toAppOperation(r.Operation)})
	if err != nil {
		return nil, ownerBoundary(err)
	}
	return connectorResult(out)
}

func (c *ConnectorContract) Observe(ctx context.Context, r ConnectorObservation) (*ConnectorResponse, error) {
	if c == nil || c.observer == nil {
		return nil, ownerBoundary(nil)
	}
	out, err := c.observer.Observe(ctx, app.ConnectorObservation{WorkspaceID: r.WorkspaceID, RelativePath: r.RelativePath})
	if err != nil {
		return nil, ownerBoundary(err)
	}
	return connectorResult(out)
}

func connectorResult(r *app.ConnectorResponse) (*ConnectorResponse, error) {
	if r == nil {
		return nil, ownerBoundary(nil)
	}
	o := r.Origin
	out := &ConnectorResponse{
		OperationID: r.OperationID, WorkspaceID: r.WorkspaceID, RelativePath: r.RelativePath,
		ComputerGeneration: r.ComputerGeneration, Phase: r.Phase, Publication: r.Publication,
		Origin: ConnectorOrigin{
			BuildID: o.BuildID, BackendGeneration: o.BackendGeneration, RuntimeID: o.RuntimeID,
			ConnectorGeneration: o.ConnectorGeneration, SessionID: o.SessionID, TaskID: o.TaskID,
			ParticipantID: o.ParticipantID, TurnID: o.TurnID, CallID: o.CallID,
			TaskEpoch: o.TaskEpoch, Generation: o.Generation, Operation: string(o.Operation),
		},
	}
	if v := r.Receipt; v != nil {
		out.Receipt = &Receipt{Operation: v.Operation, RelativePath: v.RelativePath, Bytes: v.Bytes, Replacements: v.Replacements, BeforeSHA256: cloneHash(v.BeforeSHA256), AfterSHA256: v.AfterSHA256}
	}
	if v := r.Failure; v != nil {
		out.Failure = &OutcomeFailure{Code: v.Code, Source: v.Source, Retry: "never"}
	}
	return out, nil
}
