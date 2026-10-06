package process

import "context"

// ownedSelection captures local ownership, never current external authority.
// A comparable child identity is required to detect replacement even if another
// child reports the same handle. Production children are retained pointers.
type ownedSelection struct {
	child     Child
	handle    string
	intent    Intent
	connector *ConnectorReservationScope
}

// A boundary implementation may contain an uncomparable dynamic value or an
// invalid receiver. Keep recovery confined to this pure identity/handle check;
// unverifiable ownership fails closed before lifecycle or output calls.
func sameOwnedChild(child, original Child, handle string) (same bool) {
	defer func() {
		if recover() != nil {
			same = false
		}
	}()
	return child != nil && child == original && child.Handle() == handle
}

func (s *Service) ownedSelectionLocked() (*ownedSelection, error) {
	if s.child == nil || !s.started || s.pending {
		return nil, fail("PROCESS_COMPLETION_UNAVAILABLE", false)
	}
	if !identifier(s.handle) || !sameOwnedChild(s.child, s.child, s.handle) {
		s.uncertain = true
		return nil, fail("PROCESS_OUTCOME_UNKNOWN", true)
	}
	selected := &ownedSelection{child: s.child, handle: s.handle, intent: s.intent}
	if s.connector != nil {
		scope := *s.connector
		selected.connector = &scope
	}
	if err := s.ownedCurrentLocked(selected); err != nil {
		return nil, err
	}
	return selected, nil
}

// Only pure identity and sticky local state are inspected under the app gate.
// No lease, admission, workspace or current connector authority is consulted.
func (s *Service) ownedCurrentLocked(selected *ownedSelection) error {
	sameConnector := s.connector == nil && selected.connector == nil ||
		s.connector != nil && selected.connector != nil && *s.connector == *selected.connector
	if !sameOwnedChild(s.child, selected.child, selected.handle) ||
		s.handle != selected.handle || !sameIntent(s.intent, selected.intent) || !sameConnector {
		s.uncertain = true
		return fail("PROCESS_OUTCOME_UNKNOWN", true)
	}
	if s.uncertain || s.refusal != nil {
		return fail("PROCESS_OUTCOME_UNKNOWN", true)
	}
	if s.pending || !s.started {
		return fail("PROCESS_COMPLETION_UNAVAILABLE", false)
	}
	if s.cancelAttempted {
		if s.cancelFailure != nil || s.cancellation != nil && (s.cancellation.Handle != selected.handle ||
			(s.cancellation.Status != CancelRequested && s.cancellation.Status != AlreadyTerminal)) {
			s.uncertain = true
			return fail("PROCESS_CANCEL_UNKNOWN", true)
		}
	}
	return nil
}

// WaitForCompletion waits once, outside all gates, for the original started
// child. It records notification only, not terminal or cleanup proof. Failed,
// unknown or cancelled notifications cannot be retried through this service.
func (s *Service) WaitForCompletion(ctx context.Context) error {
	if s == nil || ctx == nil {
		return fail("PROCESS_INPUT_INVALID", false)
	}
	s.gate.Lock()
	selected, err := s.ownedSelectionLocked()
	if err != nil {
		s.gate.Unlock()
		return err
	}
	if ctx.Err() != nil {
		s.gate.Unlock()
		return fail("PROCESS_CANCELLED", false)
	}
	if s.completionAttempted {
		defer s.gate.Unlock()
		if err := s.ownedCurrentLocked(s.completionOwner); err != nil {
			return err
		}
		if s.completionPending {
			return fail("PROCESS_COMPLETION_PENDING", false)
		}
		if s.completionFailure != nil {
			return s.completionFailure
		}
		if s.completed {
			return nil
		}
		return fail("PROCESS_COMPLETION_UNAVAILABLE", false)
	}
	s.completionAttempted, s.completionPending, s.completionOwner = true, true, selected
	notification, ok := selected.child.(ChildCompletion)
	if !ok {
		s.completionPending = false
		s.completionFailure = fail("PROCESS_COMPLETION_UNAVAILABLE", false)
		err := s.completionFailure
		s.gate.Unlock()
		return err
	}
	s.gate.Unlock()
	err = notification.WaitForCompletion(ctx)
	s.gate.Lock()
	defer s.gate.Unlock()
	s.completionPending = false
	if ownerErr := s.ownedCurrentLocked(selected); ownerErr != nil {
		s.completionFailure = ownerErr
	} else if ctx.Err() != nil {
		s.completionFailure = fail("PROCESS_CANCELLED", false)
	} else if err != nil {
		s.completionFailure = boundary(err)
		if failure := s.completionFailure.(*Failure); failure.Unknown {
			s.uncertain = true
		}
	} else {
		s.completed = true
	}
	return s.completionFailure
}

func (s *Service) ownedCaptureCurrent(ctx context.Context, selected *ownedSelection) error {
	s.gate.Lock()
	defer s.gate.Unlock()
	return s.ownedCaptureCurrentLocked(ctx, selected)
}

func (s *Service) ownedCaptureCurrentLocked(ctx context.Context, selected *ownedSelection) error {
	if err := s.ownedCurrentLocked(selected); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return fail("PROCESS_CANCELLED", false)
	}
	if s.cancelAttempted && s.cancellation == nil {
		return fail("PROCESS_CANCEL_PENDING", true)
	}
	if !s.completed || s.completionPending || s.completionFailure != nil || s.completionOwner != selected {
		return fail("PROCESS_COMPLETION_UNAVAILABLE", false)
	}
	return nil
}

// CaptureOwnedTerminal is INTERNAL retention of an already-owned connector
// result, never a public read/disclosure API. Completion notification is required
// before bounded reads of the SAME child. Expired/closed execution does not lose
// terminal facts, but no admission, renewal, workspace probe or effect is allowed.
// Root must serialize publication/cancel and retain its single publication attempt.
func (s *Service) CaptureOwnedTerminal(ctx context.Context) (*TerminalResult, error) {
	if s == nil || ctx == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	s.gate.Lock()
	selected := s.completionOwner
	if s.connector == nil || selected == nil || selected.connector == nil {
		s.gate.Unlock()
		return nil, fail("PROCESS_COMPLETION_UNAVAILABLE", false)
	}
	err := s.ownedCaptureCurrentLocked(ctx, selected)
	s.gate.Unlock()
	if err != nil {
		return nil, err
	}
	var captured *Observation
	var stdout, stderr []byte
	w := Window{}
	for page := 0; page < maximumTerminalPages; page++ {
		if err := s.ownedCaptureCurrent(ctx, selected); err != nil {
			return nil, err
		}
		observed, err := selected.child.Read(ctx, w)
		if err != nil {
			classified := boundary(err)
			if classified.(*Failure).Unknown {
				return nil, s.terminalCaptureUnknown()
			}
			if ownerErr := s.ownedCaptureCurrent(ctx, selected); ownerErr != nil {
				return nil, ownerErr
			}
			return nil, classified
		}
		if err := s.ownedCaptureCurrent(ctx, selected); err != nil {
			return nil, err
		}
		if !validObservation(observed, selected.handle, w) || observed.Root != RootExited ||
			!observed.OutputDrained || observed.GroupCleanup != CleanupConfirmed || observed.DescendantCleanup != CleanupConfirmed {
			return nil, s.terminalCaptureUnknown()
		}
		if captured == nil {
			copy := *observed
			copy.Stdout, copy.Stderr = nil, nil
			if observed.ExitCode != nil {
				code := *observed.ExitCode
				copy.ExitCode = &code
			}
			captured = &copy
		} else if !sameTerminalFacts(*captured, *observed) {
			return nil, s.terminalCaptureUnknown()
		}
		stdout = append(stdout, observed.Stdout...)
		stderr = append(stderr, observed.Stderr...)
		if observed.StdoutNext == observed.StdoutBytes && observed.StderrNext == observed.StderrBytes {
			captured.Stdout, captured.Stderr = stdout, stderr
			captured.StdoutOffset, captured.StderrOffset = 0, 0
			captured.StdoutNext, captured.StderrNext = uint64(len(stdout)), uint64(len(stderr))
			result := TerminalResult{Scope: *selected.connector, Intent: selected.intent, Observation: *captured}
			if !ValidTerminalResult(result) {
				return nil, s.terminalCaptureUnknown()
			}
			s.gate.Lock()
			err := s.ownedCaptureCurrentLocked(ctx, selected)
			if err == nil {
				s.terminal = true
			}
			s.gate.Unlock()
			if err != nil {
				return nil, err
			}
			return &result, nil
		}
		if observed.StdoutNext == w.StdoutOffset && observed.StderrNext == w.StderrOffset {
			return nil, s.terminalCaptureUnknown()
		}
		w = Window{observed.StdoutNext, observed.StderrNext}
	}
	return nil, fail("PROCESS_RESULT_WINDOW_LIMIT", false)
}
