package archive

import "github.com/legrch/farol/modules/chat/app/port"

// RecordedEmptyRetirement contains independently inspected lifecycle metadata.
// It supplies neither a CleanRetirement handle nor historical host drain.
type RecordedEmptyRetirement struct {
	PreviousRevision, Revision uint64
	TurnCount                  int
}

// SelectRetiredEmpty selects preservation of an already retired empty Chat.
// The canonical native chain and lifecycle must agree under retained claims.
// The old namespace is archived unchanged; only a fresh physical Chat may
// publish a NEW retirement/ACK/terminal under the enclosing maintenance gates.
func (Policy) SelectRetiredEmpty(s port.PreservedRecoverySelection, o port.PreservedRecoveryObservation, head *port.HandoffHead, retired *RecordedEmptyRetirement, validator port.EmptyRecoveryRecordValidator) (*port.PreservedRecoveryPlan, error) {
	if !o.RetirementPresent || o.WriteCount != 0 || o.TurnCount != 0 || o.PlanCount != 0 || o.ResultCount != 0 || o.ResultsUnresolved || retired == nil || retired.TurnCount != 0 || head == nil || head.Record == nil || !head.EmptyRetirementChain || validator == nil || validator.Validate(*head.Record) != nil || head.Digest == ([32]byte{}) || head.Digest != s.HandoffDigest || o.HandoffSteps < 3 {
		return nil, Refused
	}
	r := head.Record
	b := r.Publication.Binding
	w := r.Receipt.Write
	if r.Stage != port.HandoffTerminated || r.ACK == nil || r.Terminal == nil || r.Consumption != nil || r.ACK.Publication != r.Publication || r.Terminal.Publication != r.Publication || r.Terminal.KnownACKDigest == ([32]byte{}) || r.Terminal.Kind != port.HandoffNormalExit || r.Terminal.StopMode != port.HandoffGracefulStop || r.Terminal.ExitCode == nil || *r.Terminal.ExitCode != 0 || r.Terminal.Signal != "" ||
		(port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}) != s.Current.Scope || b.ParentRoot != s.Current.ParentRoot || b.ChatRoot != s.Current.ChatRoot ||
		w.Scope != o.Scope || w.Root != o.ChatRoot || len(w.Turns) != 0 || w.PreviousRevision != retired.PreviousRevision || w.Revision != retired.Revision ||
		s.HostLifetimeID == b.HostLifetimeID || s.ChildLaunchID == b.ChildLaunchID {
		return nil, Refused
	}
	return selectMetadata(s, o)
}
