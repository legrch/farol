package task

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// FilesystemRoot is an existing, canonical, private Task-only directory approved
// and measured by boot for its selected ProfileID. Device/Inode bind the opened directory, not a caller's
// path assertion. This adapter creates no parents, migrates no legacy state and
// discovers no HOME, profile, credentials, provider or installed application.
type FilesystemRoot struct {
	ProfileID     string
	Path          string
	Device, Inode uint64
}

// Filesystem implements the existing Task journal through one atomic image and
// an OS-held exclusive lease. Every task Owner for this profile must share this
// instance; direct writers are prohibited. No retry, marker removal, stale-lock
// stealing or automatic corruption recovery occurs after unknown publication.
// A retained canonical receipt remains readable while writes are fenced; missing
// IDs in that state are unknown, never proof that another dispatch is safe.
// Boot must Fence all selected Task routes before closing the journal/backend.
// Native durability/locking needs separate host acceptance; logic fakes are not
// evidence of fsync, physical ownership, crash persistence or process isolation.
type Filesystem struct {
	profile        string
	mu             sync.Mutex
	storage        filesystemStorage
	fenced, closed bool
}

var _ port.AdmissionJournal = (*Filesystem)(nil)

// OpenFilesystem takes one exclusive lease of the approved root. Existing
// partial publication is inspected without repair; a valid canonical image may
// be returned for retained queries with all writes fenced. Invalid/missing data
// is an error. A fresh empty directory is initialized durably before return.
func OpenFilesystem(root FilesystemRoot) (*Filesystem, error) {
	storage, err := openFilesystemStorage(root)
	if err != nil {
		return nil, err
	}
	j, err := newFilesystem(storage, root.ProfileID)
	if err != nil {
		if storage.Close() != nil {
			return nil, task.ErrUnknown
		}
		return nil, err
	}
	return j, nil
}

// The unexported storage seam supports hermetic logic/fault tests; production
// OpenFilesystem always supplies the native private-root implementation.
type filesystemStorage interface {
	Read() ([]byte, bool, error)
	Publish([]byte) error
	Close() error
}

func newFilesystem(storage filesystemStorage, profile string) (*Filesystem, error) {
	if storage == nil || !task.ID(profile) {
		return nil, task.ErrUnavailable
	}
	j := &Filesystem{storage: storage, profile: profile}
	_, err := j.load(context.Background())
	if err != nil {
		return nil, err
	}
	return j, nil
}
func (j *Filesystem) load(ctx context.Context) (*filesystemImage, error) {
	if j.closed {
		return nil, task.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	bytes, uncertain, err := j.storage.Read()
	if uncertain {
		j.fenced = true
	}
	if err != nil {
		j.fenced = true
		return nil, task.ErrUnknown
	}
	image, err := filesystemDecode(bytes)
	if err != nil || image.ProfileID != j.profile {
		j.fenced = true
		return nil, task.ErrUnknown
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return image, nil
}
func (j *Filesystem) update(ctx context.Context, change func(*filesystemImage) (bool, error)) error {
	image, err := j.load(ctx)
	if err != nil {
		return err
	}
	if j.fenced {
		return task.ErrUnknown
	}
	changed, err := change(image)
	if err != nil || !changed {
		return err
	}
	if image.Revision == ^uint64(0) {
		return task.ErrUnavailable
	}
	image.Revision++
	bytes, err := filesystemEncode(image)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := j.storage.Publish(bytes); err != nil {
		j.fenced = true
		return task.ErrUnknown
	}
	if ctx.Err() != nil {
		j.fenced = true
		return task.ErrUnknown
	}
	return nil
}
func (j *Filesystem) Lookup(ctx context.Context, id string) (*port.Operation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !task.ID(id) {
		return nil, task.ErrInvalid
	}
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	op, found := image.Operations[id]
	if !found {
		if j.fenced {
			return nil, task.ErrUnknown
		}
		return nil, nil
	}
	return &op, nil
}
func (j *Filesystem) Read(ctx context.Context, id string) (*port.Snapshot, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !task.ID(id) {
		return nil, task.ErrInvalid
	}
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	snapshot, found := image.Tasks[id]
	if !found {
		if j.fenced {
			return nil, task.ErrUnknown
		}
		return nil, nil
	}
	return &snapshot, nil
}
func (j *Filesystem) Admit(ctx context.Context, i task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	image, err := j.load(ctx)
	if err != nil {
		return nil, err
	}
	if op, found := image.Operations[i.OperationID]; found {
		if op.Intent != i {
			return nil, task.ErrConflict
		}
		return &port.Admission{Operation: op, Snapshot: image.Tasks[i.TaskID]}, nil
	}
	var admitted *port.Admission
	err = j.update(ctx, func(image *filesystemImage) (bool, error) {
		if !filesystemIntent(i) || prepared.ID != i.TaskID || prepared.Binding != i.Binding || prepared.Parent != i.Parent || prepared.Admission.Binding != i.Admission {
			return false, task.ErrInvalid
		}
		if op, found := image.Operations[i.OperationID]; found {
			if op.Intent != i {
				return false, task.ErrConflict
			}
			admitted = &port.Admission{Operation: op, Snapshot: image.Tasks[i.TaskID]}
			return false, nil
		}
		if len(image.Operations) >= filesystemMaxOperations {
			return false, task.ErrUnavailable
		}
		before, found := image.Tasks[i.TaskID]
		if before.Revision != revision {
			return false, task.ErrConflict
		}
		if before.Pending != "" {
			return false, task.ErrUnknown
		}
		if i.Action == task.Create {
			if found {
				return false, task.ErrConflict
			}
			if len(image.Tasks) >= filesystemMaxTasks || revision != 0 || prepared.Reference != (task.Reference{}) || prepared.Lifecycle != task.Unknown || prepared.Result != "" || prepared.DispatchID != "" || prepared.CancelRequested || prepared.DeliveryDispatchID != "" || !filesystemAdmission(prepared.Admission, i.TaskID) || (i.Admission != (task.AdmissionBinding{}) && prepared.Admission.State != task.AdmissionActive) {
				return false, task.ErrInvalid
			}
		} else {
			if !found {
				return false, task.ErrNotFound
			}
			if err := filesystemPrepare(image, before.Task, prepared, i); err != nil {
				return false, err
			}
		}
		if before.Revision == ^uint64(0) {
			return false, task.ErrUnavailable
		}
		op := port.Operation{Intent: i, Receipt: task.Receipt{State: task.Uncertain}}
		before.Task, before.Pending = prepared, i.OperationID
		before.Revision++
		image.Tasks[i.TaskID], image.Operations[i.OperationID] = before, op
		admitted = &port.Admission{Operation: op, Snapshot: before, Claimed: true}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return admitted, nil
}
func (j *Filesystem) Progress(ctx context.Context, id string, ref task.Reference) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.update(ctx, func(image *filesystemImage) (bool, error) {
		op, _, err := filesystemPending(image, id)
		if err != nil {
			return false, err
		}
		if !filesystemProgress(op.Intent, ref) || !op.Lineage.Extend(ref, op.Intent.Binding.Provider) {
			return false, task.ErrIdentity
		}
		if op.Lineage == ref {
			return false, nil
		}
		op.Lineage = ref
		image.Operations[id] = op
		return true, nil
	})
}
func (j *Filesystem) Finish(ctx context.Context, id string, receipt task.Receipt, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.update(ctx, func(image *filesystemImage) (bool, error) {
		op, snapshot, err := filesystemPending(image, id)
		if err != nil {
			return false, err
		}
		if receipt.State == task.Uncertain || (receipt.State == task.Rejected && op.Lineage != (task.Reference{})) {
			return false, task.ErrUnknown
		}
		if !filesystemReceipt(op.Intent, op.Lineage, receipt) {
			return false, task.ErrIdentity
		}
		if err := filesystemFinish(snapshot.Task, op.Intent, receipt, next); err != nil {
			return false, err
		}
		if snapshot.Revision == ^uint64(0) {
			return false, task.ErrUnavailable
		}
		op.Receipt, op.Settled = receipt, true
		snapshot.Task, snapshot.Pending = next, ""
		snapshot.Revision++
		image.Operations[id], image.Tasks[next.ID] = op, snapshot
		return true, nil
	})
}
func (j *Filesystem) Observe(ctx context.Context, before port.Snapshot, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.update(ctx, func(image *filesystemImage) (bool, error) {
		current, found := image.Tasks[before.Task.ID]
		if !found || current != before {
			return false, task.ErrConflict
		}
		if current.Pending != "" {
			return false, task.ErrUnknown
		}
		if current.Task.Lifecycle != task.Running {
			return false, task.ErrState
		}
		if !next.Lifecycle.Valid() || next.Lifecycle == task.Unknown || next.Lifecycle == task.Refused || !filesystemText(next.Result) {
			return false, task.ErrInvalid
		}
		expected := current.Task
		expected.Lifecycle, expected.Result = next.Lifecycle, next.Result
		if expected.Admission.Binding != (task.AdmissionBinding{}) && next.Lifecycle.Terminal() && expected.Admission.State != task.AdmissionRevoked {
			expected.Admission.State = task.AdmissionClosed
		}
		if next != expected {
			return false, task.ErrIdentity
		}
		if current.Revision == ^uint64(0) {
			return false, task.ErrUnavailable
		}
		current.Task, current.Revision = next, current.Revision+1
		image.Tasks[next.ID] = current
		if next.Lifecycle.Terminal() {
			op := image.Operations[next.DispatchID]
			op.Receipt.Lifecycle, op.Receipt.Result = next.Lifecycle, next.Result
			image.Operations[next.DispatchID] = op
		}
		return true, nil
	})
}
func (j *Filesystem) Invalidate(ctx context.Context, before port.Snapshot) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.update(ctx, func(image *filesystemImage) (bool, error) {
		current, found := image.Tasks[before.Task.ID]
		if !found || current != before {
			return false, task.ErrConflict
		}
		if !current.Task.Admission.Binding.Valid() {
			return false, task.ErrIdentity
		}
		if current.Revision == ^uint64(0) {
			return false, task.ErrUnavailable
		}
		current.Task.Admission.State = task.AdmissionRevoked
		current.Revision++
		image.Tasks[before.Task.ID] = current
		return true, nil
	})
}
func (j *Filesystem) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return task.ErrUnavailable
	}
	j.closed, j.fenced = true, true
	if j.storage.Close() != nil {
		return task.ErrUnknown
	}
	return nil
}
