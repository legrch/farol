package task

import (
	"github.com/legrch/farol/modules/task/domain"
)

func filesystemPrepare(image *filesystemImage, before, prepared task.Task, i task.Intent) error {
	expected := before
	expected.Admission = prepared.Admission
	if prepared != expected || i.Binding != before.Binding || i.Parent != before.Parent || i.Expected != before.Reference || !filesystemAdmission(prepared.Admission, before.ID) {
		return task.ErrIdentity
	}
	owned := i.Admission != (task.AdmissionBinding{})
	switch i.Action {
	case task.Continue, task.Resume:
		if !before.Allows(i.Action, task.Capabilities{Continue: true, Resume: true}) {
			return task.ErrState
		}
		if owned && (prepared.Admission.State != task.AdmissionActive || !i.Admission.Advances(before.Admission.Binding) || before.Admission.State == task.AdmissionActive) {
			return task.ErrState
		}
	case task.Message, task.Cancel:
		if !before.Allows(i.Action, task.Capabilities{Message: true, Cancel: true}) {
			return task.ErrState
		}
		if prepared.Admission.Binding != before.Admission.Binding {
			return task.ErrIdentity
		}
		if owned {
			state := before.Admission.State
			if i.Action == task.Cancel {
				state = task.AdmissionRevoked
			} else if state != task.AdmissionActive {
				return task.ErrState
			}
			if prepared.Admission.State != state {
				return task.ErrIdentity
			}
		}
	case task.Deliver:
		if !before.Lifecycle.Terminal() || !before.Reference.Complete(before.Binding.Provider) || before.Parent.ThreadID == "" || before.DispatchID == "" || before.DeliveryDispatchID == before.DispatchID || prepared.Admission != before.Admission {
			return task.ErrState
		}
		for _, op := range image.Operations {
			if op.Intent.TaskID == i.TaskID && op.Intent.Action == task.Deliver && op.Intent.Expected == i.Expected {
				return task.ErrState
			}
		}
	default:
		return task.ErrInvalid
	}
	return nil
}
func filesystemFinish(before task.Task, i task.Intent, r task.Receipt, next task.Task) error {
	expected := before
	if r.State == task.Rejected {
		if i.Action == task.Create {
			expected.Lifecycle = task.Refused
		}
		if i.Action == task.Deliver {
			expected.DeliveryDispatchID = before.DispatchID
		}
	} else {
		switch i.Action {
		case task.Create, task.Continue, task.Resume:
			expected.Reference, expected.Lifecycle, expected.Result = r.Reference, r.Lifecycle, r.Result
			expected.DispatchID, expected.DeliveryDispatchID, expected.CancelRequested = i.OperationID, "", false
		case task.Message:
		case task.Cancel:
			expected.CancelRequested = true
		case task.Deliver:
			expected.DeliveryDispatchID = before.DispatchID
		default:
			return task.ErrInvalid
		}
	}
	if expected.Admission.Binding != (task.AdmissionBinding{}) && expected.Admission.State != task.AdmissionRevoked && (expected.Lifecycle.Terminal() || expected.Lifecycle == task.Refused) {
		expected.Admission.State = task.AdmissionClosed
	}
	if next != expected {
		return task.ErrIdentity
	}
	return nil
}
