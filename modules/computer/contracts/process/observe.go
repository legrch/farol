package process

import (
	"context"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Observer publishes only retained reads. Trusted composition selects current
// authority separately from the unchanged body DTO, using the SAME Contract.
// It cannot Prepare, Start, Cancel, restore or look up another operation.
type Observer struct{ observer *processsvc.Observer }

func (c *Contract) Observer(current processsvc.ObservationAuthority, workspace processsvc.ObservationWorkspace) (*Observer, error) {
	if c == nil || c.service == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_UNAVAILABLE"})
	}
	observer, err := c.service.Observer(current, workspace)
	if err != nil {
		return nil, failure(err)
	}
	return &Observer{observer: observer}, nil
}

func (o *Observer) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	if o == nil || o.observer == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_UNAVAILABLE"})
	}
	out, err := o.observer.Read(ctx, processsvc.ReadRequest{Handle: request.Handle, StdoutOffset: request.StdoutOffset, StderrOffset: request.StderrOffset})
	return readResponse(out, err)
}
