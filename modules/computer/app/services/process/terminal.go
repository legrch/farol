package process

import "context"

// Bound both retained bytes and calls. Normal retained children return full
// windows; smaller valid windows remain readable, but cannot force an unbounded
// terminal capture loop under a clock-controlled authority implementation.
const maximumTerminalPages = 2*(MaximumOutput/WindowBytes) + 2

// CaptureTerminal reads the SAME retained connector child under ONE independently
// admitted READ lifetime. It neither publishes a result nor establishes clean
// retirement. Root must retain this exact value through the existing repository
// and distinguish a known publication from a lost/late acknowledgement.
// Original execution admission/deadline, intent and native ownership never change.
func (s *Service) CaptureTerminal(ctx context.Context, current ConnectorObservationAuthority, workspace ObservationWorkspace) (*TerminalResult, error) {
	if ctx == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	observer, err := s.ConnectorObserver(current, workspace)
	if err != nil {
		return nil, err
	}
	s.gate.Lock()
	original, scope, handle := s.intent, *s.connector, s.handle
	s.gate.Unlock()
	var captured *Observation
	var stdout, stderr []byte
	request := ReadRequest{Handle: handle}
	for page := 0; page < maximumTerminalPages; page++ {
		out, err := observer.Read(ctx, request)
		if err != nil {
			return nil, err
		}
		if out.State == Unknown {
			return nil, fail("PROCESS_OUTCOME_UNKNOWN", true)
		}
		if out.State != Terminal {
			if captured != nil {
				return nil, s.terminalCaptureUnknown()
			}
			return nil, fail("PROCESS_RESULT_NOT_TERMINAL", false)
		}
		observed := out.Observation
		if captured == nil {
			copy := observed
			copy.Stdout, copy.Stderr = nil, nil
			captured = &copy
		} else if !sameTerminalFacts(*captured, observed) {
			return nil, s.terminalCaptureUnknown()
		}
		stdout = append(stdout, observed.Stdout...)
		stderr = append(stderr, observed.Stderr...)
		if observed.StdoutNext == observed.StdoutBytes && observed.StderrNext == observed.StderrBytes {
			captured.Stdout, captured.Stderr = stdout, stderr
			captured.StdoutOffset, captured.StderrOffset = 0, 0
			captured.StdoutNext, captured.StderrNext = uint64(len(stdout)), uint64(len(stderr))
			result := TerminalResult{Scope: scope, Intent: original, Observation: *captured}
			if !ValidTerminalResult(result) {
				return nil, s.terminalCaptureUnknown()
			}
			// This includes fresh physical qualification and a final coherent
			// current-owner check after all pages, before disclosing complete bytes.
			err = observer.withCurrent(ctx, func() error {
				s.gate.Lock()
				defer s.gate.Unlock()
				if s.uncertain || !s.terminal || s.pending || !s.started || s.handle != handle ||
					!sameIntent(s.intent, original) || *s.connector != scope {
					return fail("PROCESS_OUTCOME_UNKNOWN", true)
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
			return &result, nil
		}
		if observed.StdoutNext == request.StdoutOffset && observed.StderrNext == request.StderrOffset {
			return nil, s.terminalCaptureUnknown()
		}
		request.StdoutOffset, request.StderrOffset = observed.StdoutNext, observed.StderrNext
	}
	return nil, fail("PROCESS_RESULT_WINDOW_LIMIT", false)
}

func (s *Service) terminalCaptureUnknown() error {
	s.gate.Lock()
	s.uncertain = true
	s.gate.Unlock()
	return fail("PROCESS_OBSERVATION_UNKNOWN", true)
}

func sameTerminalFacts(a, b Observation) bool {
	sameCode := a.ExitCode == nil && b.ExitCode == nil || a.ExitCode != nil && b.ExitCode != nil && *a.ExitCode == *b.ExitCode
	return a.Handle == b.Handle && a.Root == b.Root && a.Waited == b.Waited && sameCode && a.ExitSignal == b.ExitSignal &&
		a.GroupCleanup == b.GroupCleanup && a.DescendantCleanup == b.DescendantCleanup && a.OutputDrained == b.OutputDrained &&
		a.StdoutBytes == b.StdoutBytes && a.StderrBytes == b.StderrBytes && a.OutputLimitReached == b.OutputLimitReached &&
		a.CancelRequested == b.CancelRequested && a.TimedOut == b.TimedOut && a.AuthorityLost == b.AuthorityLost
}
