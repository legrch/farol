package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type StartRequest struct{ OperationID string }
type StartResponse struct{ OperationID, Handle string }

func (c *Contract) Start(ctx context.Context, request StartRequest) (*StartResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_UNAVAILABLE"})
	}
	out, err := c.service.Start(ctx, processsvc.StartRequest{OperationID: request.OperationID})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_OUTCOME_UNKNOWN", Unknown: true})
	}
	return &StartResponse{OperationID: out.OperationID, Handle: out.Handle}, nil
}
