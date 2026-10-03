package task

import (
	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// NewOwned is the production constructor seam. Boot supplies a selected route
// from the same concrete owner used by contracts/admission. New remains an
// unowned policy/retained-observation constructor and cannot produce admission.
func NewOwned(j port.SelectedJournal, a port.Authority, providers map[task.Provider]port.Provider, d port.Delivery, fingerprint port.Fingerprint, progress port.ProgressFactory) (*Service, error) {
	if j == nil {
		return nil, task.ErrUnavailable
	}
	selected := j.Selection()
	binding := task.AdmissionBinding{OwnerID: selected.OwnerID, SessionID: selected.SessionID, TaskID: selected.TaskID,
		TaskEpoch: selected.TaskEpoch, ParticipantID: selected.ParticipantID, TurnID: selected.TurnID}
	if !binding.Valid() {
		return nil, task.ErrInvalid
	}
	s, err := New(j, a, providers, d, fingerprint, progress)
	if err != nil {
		return nil, err
	}
	s.owned, s.selected = j, binding
	return s, nil
}

func (s *Service) prepareAdmission(before task.Task, intent *task.Intent) (task.Task, error) {
	if s.owned == nil {
		return before, nil
	}
	if before.ID != s.selected.TaskID || intent.TaskID != s.selected.TaskID {
		return before, task.ErrIdentity
	}
	intent.Admission = s.selected
	switch intent.Action {
	case task.Create:
		if before.Admission != (task.ExecutionAdmission{}) {
			return before, task.ErrState
		}
		before.Admission = task.ExecutionAdmission{Binding: s.selected, State: task.AdmissionActive}
	case task.Continue, task.Resume:
		if !s.selected.Advances(before.Admission.Binding) || before.Admission.State == task.AdmissionActive {
			return before, task.ErrState
		}
		before.Admission = task.ExecutionAdmission{Binding: s.selected, State: task.AdmissionActive}
	default:
		if before.Admission.Binding != s.selected {
			return before, task.ErrIdentity
		}
		if intent.Action == task.Message && before.Admission.State != task.AdmissionActive {
			return before, task.ErrState
		}
		if intent.Action == task.Cancel {
			before.Admission.State = task.AdmissionRevoked
		}
	}
	return before, nil
}

func (s *Service) fence() {
	if s.owned != nil {
		s.owned.Fence()
	}
}
func closeAdmission(next *task.Task) {
	if next.Admission.Binding == (task.AdmissionBinding{}) {
		return
	}
	if next.Admission.State != task.AdmissionRevoked && (next.Lifecycle.Terminal() || next.Lifecycle == task.Refused) {
		next.Admission.State = task.AdmissionClosed
	}
}
