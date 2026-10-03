package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type CancelRequest struct{ Handle string }
type CancelResponse struct{ Status CancelStatus }

func (c *Contract) Cancel(ctx context.Context, request CancelRequest) (*CancelResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_UNAVAILABLE"})
	}
	out, err := c.service.Cancel(ctx, processsvc.CancelRequest{Handle: request.Handle})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_CANCEL_UNKNOWN", Unknown: true})
	}
	return &CancelResponse{Status: CancelStatus(out.Status)}, nil
}
