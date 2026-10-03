package process

import "context"

type ReadRequest struct {
	Handle                     string
	StdoutOffset, StderrOffset uint64
}
type ReadResponse struct {
	State       State
	Observation Observation
}

func validObservation(o *Observation, handle string, w Window) bool {
	if o == nil || o.Handle != handle || o.StdoutOffset != w.StdoutOffset || o.StderrOffset != w.StderrOffset ||
		o.StdoutBytes > MaximumOutput || o.StderrBytes > MaximumOutput || o.StdoutBytes+o.StderrBytes > MaximumOutput ||
		len(o.Stdout) > WindowBytes || len(o.Stderr) > WindowBytes || o.StdoutNext != o.StdoutOffset+uint64(len(o.Stdout)) || o.StderrNext != o.StderrOffset+uint64(len(o.Stderr)) ||
		o.StdoutNext > o.StdoutBytes || o.StderrNext > o.StderrBytes {
		return false
	}
	validCleanup := func(v Cleanup) bool { return v == CleanupPending || v == CleanupConfirmed || v == CleanupUnverified }
	if !validCleanup(o.GroupCleanup) || !validCleanup(o.DescendantCleanup) {
		return false
	}
	switch o.Root {
	case RootRunning:
		return !o.Waited && o.ExitCode == nil && o.ExitSignal == 0 && o.GroupCleanup != CleanupConfirmed && o.DescendantCleanup != CleanupConfirmed
	case RootExited:
		return o.Waited && (o.ExitCode != nil && *o.ExitCode >= 0 && *o.ExitCode <= 255 && o.ExitSignal == 0 || o.ExitCode == nil && o.ExitSignal > 0 && o.ExitSignal <= 128) && o.GroupCleanup != CleanupPending && o.DescendantCleanup != CleanupPending
	default:
		return false
	}
}
func (s *Service) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	if s == nil || ctx == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	s.gate.Lock()
	child, handle := s.child, s.handle
	s.gate.Unlock()
	if child == nil || request.Handle != handle {
		return nil, fail("PROCESS_HANDLE_MISMATCH", false)
	}
	if child.Handle() != handle {
		s.gate.Lock()
		s.uncertain = true
		s.gate.Unlock()
		return nil, fail("PROCESS_OBSERVATION_UNKNOWN", true)
	}
	if request.StdoutOffset > MaximumOutput || request.StderrOffset > MaximumOutput {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	if err := s.current(ctx); err != nil {
		return nil, err
	}
	window := Window{request.StdoutOffset, request.StderrOffset}
	observed, err := child.Read(ctx, window)
	if err != nil {
		classified := boundary(err)
		if failure, ok := classified.(*Failure); ok && failure.Unknown {
			s.gate.Lock()
			s.uncertain = true
			s.gate.Unlock()
		}
		return nil, classified
	}
	if child.Handle() != handle || !validObservation(observed, handle, window) {
		s.gate.Lock()
		s.uncertain = true
		s.gate.Unlock()
		return nil, fail("PROCESS_OBSERVATION_UNKNOWN", true)
	}
	out := *observed
	out.Stdout = append([]byte(nil), observed.Stdout...)
	out.Stderr = append([]byte(nil), observed.Stderr...)
	if observed.ExitCode != nil {
		code := *observed.ExitCode
		out.ExitCode = &code
	}
	// Native observations and sticky uncertainty are recorded outside owner gates.
	s.gate.Lock()
	if out.GroupCleanup == CleanupUnverified || out.DescendantCleanup == CleanupUnverified || out.Root == RootExited && !out.OutputDrained {
		s.uncertain = true
	}
	s.gate.Unlock()
	var response *ReadResponse
	// Final response construction observes sticky state while under the current
	// authority gates. No native IO or authority-owner mutation occurs here.
	err = s.withCurrent(ctx, func() error {
		s.gate.Lock()
		state := Running
		if s.uncertain {
			state = Unknown
		} else if out.Root == RootExited && out.GroupCleanup == CleanupConfirmed && out.DescendantCleanup == CleanupConfirmed && out.OutputDrained {
			state = Terminal
		}
		response = &ReadResponse{State: state, Observation: out}
		s.gate.Unlock()
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.gate.Lock()
	if response.State == Terminal && !s.uncertain {
		s.terminal = true
	}
	s.gate.Unlock()
	return response, nil
}
