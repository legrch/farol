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
	if o.Supervisor != "" && o.Supervisor != SupervisorRunning && o.Supervisor != SupervisorExited && o.Supervisor != SupervisorUnknown {
		return false
	}
	if o.Supervisor == SupervisorExited && (o.Root != RootExited || !o.Waited || !o.OutputDrained) {
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
	return s.read(ctx, request, s.withCurrent)
}

// Both readers retain the SAME child and sticky fences. The guard is selected
// internally by the service/observer, never supplied in a request body.
func (s *Service) read(ctx context.Context, request ReadRequest, current func(context.Context, func() error) error) (*ReadResponse, error) {
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
	if err := current(ctx, nil); err != nil {
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
	// Missing descendant proof on an explicitly selected live supervisor is
	// not an unknown dispatch. Its final Wait may still establish root result
	// preservation. Legacy and actual unknown observations retain sticky fences.
	if out.Supervisor == SupervisorUnknown ||
		out.Supervisor == "" && (out.GroupCleanup == CleanupUnverified || out.DescendantCleanup == CleanupUnverified) ||
		out.Root == RootExited && !out.OutputDrained && out.Supervisor != SupervisorRunning {
		s.uncertain = true
	}
	s.gate.Unlock()
	var response *ReadResponse
	// Final response construction observes sticky state while under the current
	// authority gates. No native IO or authority-owner mutation occurs here.
	err = current(ctx, func() error {
		s.gate.Lock()
		state := Running
		if s.uncertain {
			state = Unknown
		} else if out.Root == RootExited && out.Supervisor == SupervisorRunning {
			// Running describes the original execution lifecycle. A known root
			// exit can precede supervisor Wait/output drain; keep it observable
			// without claiming completion or converting progress into UNKNOWN.
			state = Running
		} else if completedState(out) != Unknown {
			state = completedState(out)
		} else if out.Root == RootExited || out.GroupCleanup == CleanupUnverified || out.DescendantCleanup == CleanupUnverified {
			state = Unknown
		}
		response = &ReadResponse{State: state, Observation: out}
		s.gate.Unlock()
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.gate.Lock()
	if (response.State == Terminal || response.State == Exited) && !s.uncertain {
		s.terminal = true
	}
	s.gate.Unlock()
	return response, nil
}

// Completion of the execution owner and cleanup of descendants are independent.
// Only the old positive cohort witness yields Terminal. Exited preserves actual
// code/output after known supervisor exit, leaving cleanup explicitly unverified.
func completedState(o Observation) State {
	if o.Root != RootExited || !o.Waited || !o.OutputDrained ||
		o.Supervisor == SupervisorRunning || o.Supervisor == SupervisorUnknown {
		return Unknown
	}
	if o.GroupCleanup == CleanupConfirmed && o.DescendantCleanup == CleanupConfirmed {
		return Terminal
	}
	final := func(c Cleanup) bool { return c == CleanupConfirmed || c == CleanupUnverified }
	if o.Supervisor == SupervisorExited && final(o.GroupCleanup) && final(o.DescendantCleanup) {
		return Exited
	}
	return Unknown
}
