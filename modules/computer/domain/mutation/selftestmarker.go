package mutation

import "errors"

// SelfTestMarker records the host's original selection and settlement intent.
// It conveys no authority to run the selected operation.
type SelfTestMarker struct {
	binding SelfTestBinding
	phase   SelfTestMarkerPhase
}

type SelfTestMarkerPhase string

const (
	SelfTestMarkerSelected SelfTestMarkerPhase = "selected"
	SelfTestMarkerSettling SelfTestMarkerPhase = "settling"
	SelfTestMarkerSettled  SelfTestMarkerPhase = "settled"
)

var errSelfTestMarker = errors.New("invalid self-test marker transition")

// Restore describes only persisted facts; callers must separately verify any
// referenced terminal against the original journal before using settled state.
func RestoreSelfTestMarker(binding SelfTestBinding, phase SelfTestMarkerPhase) (*SelfTestMarker, error) {
	if !binding.Valid() || (phase != SelfTestMarkerSelected && phase != SelfTestMarkerSettling && phase != SelfTestMarkerSettled) {
		return nil, errSelfTestMarker
	}
	return &SelfTestMarker{binding: binding, phase: phase}, nil
}

func (m *SelfTestMarker) Binding() SelfTestBinding   { return m.binding }
func (m *SelfTestMarker) Phase() SelfTestMarkerPhase { return m.phase }

// BeginSettlement is a one-shot intent. A restored settling marker must never
// be interpreted as permission to repeat the settlement effect.
func (m *SelfTestMarker) BeginSettlement() (*SelfTestMarker, error) {
	if m == nil || !m.binding.Valid() || m.phase != SelfTestMarkerSelected {
		return nil, errSelfTestMarker
	}
	return &SelfTestMarker{binding: m.binding, phase: SelfTestMarkerSettling}, nil
}

// ConfirmSettlement requires the original validated terminal, not a phase or
// response supplied by the caller. UNKNOWN and Prepared cannot be settled.
func (m *SelfTestMarker) ConfirmSettlement(original *SelfTestState) (*SelfTestMarker, error) {
	if m == nil || m.phase != SelfTestMarkerSettling || original == nil || original.Binding() != m.binding || (original.Phase() != Completed && original.Phase() != Failed) {
		return nil, errSelfTestMarker
	}
	return &SelfTestMarker{binding: m.binding, phase: SelfTestMarkerSettled}, nil
}
