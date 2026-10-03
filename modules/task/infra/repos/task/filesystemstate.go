package task

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// No automatic pruning: old dispatch results and delivery acknowledgements stay
// in Operations. Reaching these explicit bounds refuses publication; accepted
// archival/capacity policy must precede any future removal of retained evidence.
const filesystemMaxBytes = 32 << 20
const filesystemMaxTasks = 1024
const filesystemMaxOperations = 8192

type filesystemImage struct {
	ProfileID  string
	Version    uint8
	Revision   uint64
	Tasks      map[string]port.Snapshot
	Operations map[string]port.Operation
}
type filesystemEnvelope struct {
	Image  filesystemImage
	SHA256 string
}

func filesystemEmpty(profile string) *filesystemImage {
	return &filesystemImage{ProfileID: profile, Version: 1, Tasks: map[string]port.Snapshot{}, Operations: map[string]port.Operation{}}
}
func filesystemHash(bytes []byte) string {
	digest := sha256.Sum256(bytes)
	return hex.EncodeToString(digest[:])
}
func filesystemDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func filesystemEncode(image *filesystemImage) ([]byte, error) {
	if !filesystemImageValid(image) {
		return nil, task.ErrInvalid
	}
	body, err := json.Marshal(image)
	if err != nil {
		return nil, task.ErrInvalid
	}
	out, err := json.Marshal(filesystemEnvelope{*image, filesystemHash(body)})
	if err != nil {
		return nil, task.ErrInvalid
	}
	out = append(out, '\n')
	if len(out) > filesystemMaxBytes {
		return nil, task.ErrUnavailable
	}
	return out, nil
}
func filesystemDecode(data []byte) (*filesystemImage, error) {
	if len(data) == 0 || len(data) > filesystemMaxBytes || !utf8.Valid(data) {
		return nil, task.ErrUnknown
	}
	var envelope filesystemEnvelope
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || !filesystemDigest(envelope.SHA256) {
		return nil, task.ErrUnknown
	}
	canonical, err := filesystemEncode(&envelope.Image)
	// Exact canonical bytes reject duplicate/case-aliased fields, null/missing
	// collections, trailing JSON, invalid escape rewrites and unsupported format.
	if err != nil || !bytes.Equal(canonical, data) {
		return nil, task.ErrUnknown
	}
	return &envelope.Image, nil
}
func filesystemText(s string) bool { return s == "" || task.Text(s, 65536) }
func filesystemAdmission(a task.ExecutionAdmission, id string) bool {
	if a == (task.ExecutionAdmission{}) {
		return true
	}
	return a.Binding.Valid() && a.Binding.TaskID == id && a.State.Valid()
}
func filesystemIntent(i task.Intent) bool {
	if !task.ID(i.OperationID) || !task.ID(i.TaskID) || !filesystemDigest(i.Digest) || !i.Binding.Valid() || !i.Parent.Valid() {
		return false
	}
	if i.Admission != (task.AdmissionBinding{}) && (!i.Admission.Valid() || i.Admission.TaskID != i.TaskID) {
		return false
	}
	if i.Action == task.Create {
		return i.Expected == (task.Reference{})
	}
	if !i.Expected.Complete(i.Binding.Provider) {
		return false
	}
	return i.Action == task.Continue && i.Binding.Provider == task.Codex || i.Action == task.Resume && i.Binding.Provider == task.Claude || i.Action == task.Message || i.Action == task.Cancel || i.Action == task.Deliver
}
func filesystemProgress(i task.Intent, ref task.Reference) bool {
	if i.Action == task.Deliver || !((task.Reference{}).Extend(ref, i.Binding.Provider)) {
		return false
	}
	if i.Binding.Provider == task.Claude && (i.Action == task.Create || i.Action == task.Resume) && ref.InvocationID != "" && ref.InvocationID != i.OperationID {
		return false
	}
	if i.Action != task.Create && !i.Expected.SameSession(ref, i.Binding.Provider) {
		return false
	}
	if (i.Action == task.Message || i.Action == task.Cancel) && ref != i.Expected {
		return false
	}
	return !((i.Action == task.Continue || i.Action == task.Resume) && ref == i.Expected)
}
func filesystemReceipt(i task.Intent, lineage task.Reference, r task.Receipt) bool {
	if r.State == task.Rejected {
		return lineage == (task.Reference{}) && task.ID(r.Code) && r.Reference == (task.Reference{}) && r.Lifecycle == "" && r.Result == "" && !r.CancelRequested
	}
	if r.State != task.Known || r.Code != "" || !r.Reference.Complete(i.Binding.Provider) {
		return false
	}
	if i.Action == task.Deliver {
		return r.Reference == i.Expected && r.Lifecycle == "" && r.Result == "" && !r.CancelRequested
	}
	if !lineage.Extend(r.Reference, i.Binding.Provider) || !filesystemProgress(i, r.Reference) {
		return false
	}
	if i.Action == task.Message {
		return r.Lifecycle == task.Running && r.Result == "" && !r.CancelRequested
	}
	if i.Action == task.Cancel {
		return r.Lifecycle == task.Running && r.Result == "" && r.CancelRequested
	}
	return r.Lifecycle.Valid() && r.Lifecycle != task.Unknown && r.Lifecycle != task.Refused && filesystemText(r.Result) && !r.CancelRequested
}
func filesystemImageValid(image *filesystemImage) bool {
	if image == nil || !task.ID(image.ProfileID) || image.Version != 1 || image.Tasks == nil || image.Operations == nil || len(image.Tasks) > filesystemMaxTasks || len(image.Operations) > filesystemMaxOperations {
		return false
	}
	creates := map[string]int{}
	creation := map[string]port.Operation{}
	deliveries := map[string]map[task.Reference]bool{}
	for id, op := range image.Operations {
		i := op.Intent
		snapshot, found := image.Tasks[i.TaskID]
		if !found || id != i.OperationID || !filesystemIntent(i) || i.Binding.ProfileID != image.ProfileID || i.Binding != snapshot.Task.Binding || i.Parent != snapshot.Task.Parent {
			return false
		}
		if i.Admission == (task.AdmissionBinding{}) {
			if snapshot.Task.Admission != (task.ExecutionAdmission{}) {
				return false
			}
		} else {
			a := snapshot.Task.Admission.Binding
			if i.Admission.OwnerID != a.OwnerID || i.Admission.SessionID != a.SessionID || i.Admission.ParticipantID != a.ParticipantID || i.Admission.TaskEpoch > a.TaskEpoch {
				return false
			}
		}
		if i.Action == task.Create {
			creates[i.TaskID]++
			creation[i.TaskID] = op
		}
		if i.Action == task.Deliver {
			if i.Parent.ThreadID == "" {
				return false
			}
			if deliveries[i.TaskID] == nil {
				deliveries[i.TaskID] = map[task.Reference]bool{}
			}
			if deliveries[i.TaskID][i.Expected] {
				return false
			}
			deliveries[i.TaskID][i.Expected] = true
		}
		if op.Lineage != (task.Reference{}) && !filesystemProgress(i, op.Lineage) {
			return false
		}
		if op.Settled {
			if !filesystemReceipt(i, op.Lineage, op.Receipt) {
				return false
			}
		} else if snapshot.Pending != id || op.Receipt != (task.Receipt{State: task.Uncertain}) {
			return false
		}
	}
	for id, snapshot := range image.Tasks {
		t := snapshot.Task
		if !task.ID(id) || id != t.ID || creates[id] != 1 || snapshot.Revision == 0 || snapshot.Revision > image.Revision || !t.Binding.Valid() || !t.Parent.Valid() || !t.Lifecycle.Valid() || !filesystemText(t.Result) || !filesystemAdmission(t.Admission, id) {
			return false
		}
		if snapshot.Pending != "" {
			op, found := image.Operations[snapshot.Pending]
			if !found || op.Settled || op.Intent.TaskID != id || op.Intent.Admission != t.Admission.Binding {
				return false
			}
		}
		if t.Lifecycle == task.Unknown || t.Lifecycle == task.Refused {
			if t.Reference != (task.Reference{}) || t.DispatchID != "" || t.Result != "" || t.CancelRequested || t.DeliveryDispatchID != "" {
				return false
			}
			if t.Lifecycle == task.Unknown && (snapshot.Pending == "" || image.Operations[snapshot.Pending].Intent.Action != task.Create) {
				return false
			}
		} else {
			op, found := image.Operations[t.DispatchID]
			if !found || !op.Settled || op.Intent.TaskID != id || !(op.Intent.Action == task.Create || op.Intent.Action == task.Continue || op.Intent.Action == task.Resume) || op.Receipt.State != task.Known || !t.Reference.Complete(t.Binding.Provider) || op.Receipt.Reference != t.Reference {
				return false
			}
			if t.Lifecycle.Terminal() && (op.Receipt.Lifecycle != t.Lifecycle || op.Receipt.Result != t.Result) {
				return false
			}
		}
		if snapshot.Pending == "" && t.Admission.State == task.AdmissionActive && (t.Lifecycle.Terminal() || t.Lifecycle == task.Refused) {
			return false
		}
		if t.Lifecycle == task.Refused && (snapshot.Pending != "" || !creation[id].Settled || creation[id].Receipt.State != task.Rejected) {
			return false
		}
		if t.Lifecycle == task.Running && image.Operations[t.DispatchID].Receipt.Lifecycle != task.Running {
			return false
		}
		if t.DeliveryDispatchID != "" {
			if t.DeliveryDispatchID != t.DispatchID || !t.Lifecycle.Terminal() {
				return false
			}
			found := false
			for _, op := range image.Operations {
				if op.Intent.TaskID == id && op.Intent.Action == task.Deliver && op.Intent.Expected == t.Reference && op.Settled {
					found = true
				}
			}
			if !found {
				return false
			}
		}
	}
	return len(image.Tasks) != 0 || len(image.Operations) == 0
}
func filesystemPending(image *filesystemImage, id string) (port.Operation, port.Snapshot, error) {
	if !task.ID(id) {
		return port.Operation{}, port.Snapshot{}, task.ErrInvalid
	}
	op, found := image.Operations[id]
	if !found {
		return port.Operation{}, port.Snapshot{}, task.ErrNotFound
	}
	snapshot := image.Tasks[op.Intent.TaskID]
	if op.Settled || snapshot.Pending != id {
		return port.Operation{}, port.Snapshot{}, task.ErrState
	}
	return op, snapshot, nil
}
