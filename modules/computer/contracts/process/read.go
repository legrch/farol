package process

import (
	"context"
	"encoding/base64"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type ReadRequest struct {
	Handle                     string
	StdoutOffset, StderrOffset uint64
}
type ReadResponse struct {
	Handle                                                                       string
	State                                                                        State
	RootState                                                                    RootState
	RootWaited                                                                   bool
	ExitCode                                                                     *int
	ExitSignal                                                                   int
	GroupCleanup, DescendantCleanup                                              Cleanup
	StdoutBase64, StderrBase64                                                   string
	StdoutOffset, StderrOffset, StdoutNext, StderrNext, StdoutBytes, StderrBytes uint64
	OutputLimitReached, OutputDrained, CancelRequested, TimedOut, AuthorityLost  bool
}

func (c *Contract) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_UNAVAILABLE"})
	}
	out, err := c.service.Read(ctx, processsvc.ReadRequest{Handle: request.Handle, StdoutOffset: request.StdoutOffset, StderrOffset: request.StderrOffset})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(&processsvc.Failure{Code: "PROCESS_OBSERVATION_UNKNOWN", Unknown: true})
	}
	o := out.Observation
	var code *int
	if o.ExitCode != nil {
		copy := *o.ExitCode
		code = &copy
	}
	return &ReadResponse{Handle: o.Handle, State: State(out.State), RootState: RootState(o.Root), RootWaited: o.Waited,
		ExitCode: code, ExitSignal: o.ExitSignal, GroupCleanup: Cleanup(o.GroupCleanup), DescendantCleanup: Cleanup(o.DescendantCleanup),
		StdoutBase64: base64.StdEncoding.EncodeToString(o.Stdout), StderrBase64: base64.StdEncoding.EncodeToString(o.Stderr),
		StdoutOffset: o.StdoutOffset, StderrOffset: o.StderrOffset, StdoutNext: o.StdoutNext, StderrNext: o.StderrNext,
		StdoutBytes: o.StdoutBytes, StderrBytes: o.StderrBytes, OutputLimitReached: o.OutputLimitReached, OutputDrained: o.OutputDrained, CancelRequested: o.CancelRequested, TimedOut: o.TimedOut, AuthorityLost: o.AuthorityLost}, nil
}
