package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Independent consumer DTO. No executable/root/env/lease/deadline or authority
// mutation can be supplied here. Args/stdin are transient, never receipt fields.
type Invocation struct {
	RuntimeID, SessionID, ModelID, AdmissionID string
	Arguments                                  []string
	Input                                      []byte
}
type PrepareRequest struct {
	OperationID string
	Invocation  Invocation
}
type PrepareResponse struct {
	OperationID, RuntimeID, SessionID, ModelID, AdmissionID, Digest string
}

func (c *Contract) Prepare(ctx context.Context, request PrepareRequest) (*PrepareResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_UNAVAILABLE"})
	}
	v := request.Invocation
	out, err := c.service.Prepare(ctx, processsvc.PrepareRequest{OperationID: request.OperationID, Invocation: processsvc.Invocation{RuntimeID: v.RuntimeID, SessionID: v.SessionID, ModelID: v.ModelID, AdmissionID: v.AdmissionID, Arguments: append([]string(nil), v.Arguments...), Input: append([]byte(nil), v.Input...)}})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_PREPARATION_UNKNOWN", Unknown: true})
	}
	return &PrepareResponse{OperationID: out.OperationID, RuntimeID: out.RuntimeID, SessionID: out.SessionID, ModelID: out.ModelID, AdmissionID: out.AdmissionID, Digest: out.Digest}, nil
}
