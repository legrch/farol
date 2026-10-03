package task

// AdmissionBinding identifies the existing trusted Farol task admission. It
// carries no scopes, permissions or provider lineage and issues no grant.
type AdmissionBinding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}

func (b AdmissionBinding) Valid() bool {
	return ID(b.OwnerID) && ID(b.SessionID) && ID(b.TaskID) && b.TaskEpoch != 0 && ID(b.ParticipantID) && ID(b.TurnID)
}
func (b AdmissionBinding) Advances(old AdmissionBinding) bool {
	return b.Valid() && b.OwnerID == old.OwnerID && b.SessionID == old.SessionID && b.TaskID == old.TaskID && b.ParticipantID == old.ParticipantID && b.TaskEpoch > old.TaskEpoch && b.TurnID != old.TurnID
}

type AdmissionState string

const (
	AdmissionActive  AdmissionState = "active"
	AdmissionClosed  AdmissionState = "closed"
	AdmissionRevoked AdmissionState = "revoked"
)

// ExecutionAdmission is persisted in the existing Task aggregate/journal. Only
// a new trusted launch intent can make it active; observations can only close it.
type ExecutionAdmission struct {
	Binding AdmissionBinding
	State   AdmissionState
}

func (s AdmissionState) Valid() bool {
	return s == AdmissionActive || s == AdmissionClosed || s == AdmissionRevoked
}
