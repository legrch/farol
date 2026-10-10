package task

// These canonical storage/owner tests use the existing memory storage seam.
// They do not qualify native durability or upgrade/rollback on a Mac profile.
import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type preExactIntent struct {
	Admission                   task.AdmissionBinding `json:",omitzero"`
	OperationID, TaskID, Digest string
	Action                      task.Action
	Binding                     task.Binding
	Parent                      task.Parent
	Expected                    task.Reference
}

func TestExactGuardPreservesLegacyCanonicalImageAndReader(t *testing.T) {
	j, m := filesystemFixture(t)
	filesystemLaunch(t, j, task.Codex)
	image, err := filesystemDecode(m.data)
	if err != nil {
		t.Fatal(err)
	}
	type oldOperation struct {
		Reservation task.NativeReservation `json:",omitzero"`
		Events      task.EventLog          `json:",omitzero"`
		Intent      preExactIntent
		Lineage     task.Reference
		Receipt     task.Receipt
		Settled     bool
	}
	type oldImage struct {
		ProfileID  string
		Version    uint8
		Revision   uint64
		Tasks      map[string]port.Snapshot
		Operations map[string]oldOperation
	}
	old := oldImage{image.ProfileID, image.Version, image.Revision, image.Tasks, map[string]oldOperation{}}
	for id, op := range image.Operations {
		i := op.Intent
		old.Operations[id] = oldOperation{op.Reservation, op.Events, preExactIntent{i.Admission, i.OperationID, i.TaskID, i.Digest, i.Action, i.Binding, i.Parent, i.Expected}, op.Lineage, op.Receipt, op.Settled}
	}
	body, _ := json.Marshal(old)
	encoded, _ := json.Marshal(struct {
		Image  oldImage
		SHA256 string
	}{old, filesystemHash(body)})
	legacy := append(encoded, '\n')
	if !bytes.Equal(legacy, m.data) || bytes.Contains(legacy, []byte("ExactDispatchID")) {
		t.Fatal("zero guard changed canonical legacy bytes")
	}
	if _, err := filesystemDecode(legacy); err != nil {
		t.Fatal("old image no longer reads", err)
	}
	if _, err := newFilesystem(&filesystemMemory{data: legacy}, "dev"); err != nil {
		t.Fatal("legacy reopen refused", err)
	}
}

func TestExactGuardCanonicalReopenKnownRefusedAndUnknown(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, state := range []task.ReceiptState{task.Known, task.Rejected, task.Uncertain} {
			t.Run(string(action)+"/"+string(state), func(t *testing.T) {
				j, m := filesystemFixture(t)
				filesystemLaunch(t, j, task.Codex)
				if action == task.Deliver {
					filesystemComplete(t, j)
				}
				before, _ := j.Read(filesystemCtx, "task")
				next := before.Task
				i := task.Intent{Admission: next.Admission.Binding, OperationID: "guarded", TaskID: "task", Digest: strings.Repeat("b", 64), Action: action, Binding: next.Binding, Parent: next.Parent, Expected: next.Reference, ExactDispatchID: next.DispatchID}
				if action == task.Cancel {
					next.Admission.State = task.AdmissionRevoked
				}
				if out, err := j.Admit(filesystemCtx, i, before.Revision, next); err != nil || !out.Claimed {
					t.Fatal(out, err)
				}
				if state != task.Uncertain {
					r := task.Receipt{State: state}
					if state == task.Rejected {
						r.Code = "CONTROLLED_REFUSAL"
					} else {
						r.Reference = i.Expected
						if action == task.Cancel {
							r.Lifecycle = task.Running
							r.CancelRequested = true
							next.CancelRequested = true
							if err := j.Progress(filesystemCtx, i.OperationID, i.Expected); err != nil {
								t.Fatal(err)
							}
						}
					}
					if action == task.Deliver {
						next.DeliveryDispatchID = next.DispatchID
					}
					if err := j.Finish(filesystemCtx, i.OperationID, r, next); err != nil {
						t.Fatal(err)
					}
				}
				writes := m.writes
				original := bytes.Clone(m.data)
				reopened, err := newFilesystem(m, "dev")
				if err != nil {
					t.Fatal("guarded canonical image did not reopen", err)
				}
				owner, err := New(reopened, "task")
				if err != nil {
					t.Fatal(err)
				}
				a := i.Admission
				route, err := owner.Select(port.CurrentBinding{OwnerID: a.OwnerID, SessionID: a.SessionID, TaskID: a.TaskID, TaskEpoch: a.TaskEpoch, ParticipantID: a.ParticipantID, TurnID: a.TurnID})
				if err != nil {
					t.Fatal(err)
				}
				op, err := route.Lookup(filesystemCtx, "guarded")
				if err != nil || op.Intent != i || op.Receipt.State != state || op.Settled != (state != task.Uncertain) {
					t.Fatal("reopen changed guarded evidence", op, err)
				}
				if err := route.WithCurrent(filesystemCtx, func(b *port.CurrentBinding) error {
					if b != nil {
						t.Fatal("reopen restored positive admission")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if m.writes != writes || !bytes.Equal(original, m.data) {
					t.Fatal("reopen repaired or rewrote image")
				}
				encoded, _ := json.Marshal(i)
				var old preExactIntent
				decoder := json.NewDecoder(bytes.NewReader(encoded))
				decoder.DisallowUnknownFields()
				if decoder.Decode(&old) == nil {
					t.Fatal("old reader silently accepted guarded intent")
				}
			})
		}
	}
}

func TestExactGuardRejectsInvalidCrossedAndPreparedTargets(t *testing.T) {
	for _, variant := range []string{"wrong-action", "malformed-dispatch", "crossed-reference", "missing-original", "foreign-original"} {
		t.Run(variant, func(t *testing.T) {
			j, m := filesystemFixture(t)
			filesystemLaunch(t, j, task.Codex)
			before, _ := j.Read(filesystemCtx, "task")
			next := before.Task
			next.Admission.State = task.AdmissionRevoked
			i := task.Intent{Admission: next.Admission.Binding, OperationID: "guarded", TaskID: "task", Digest: strings.Repeat("b", 64), Action: task.Cancel, Binding: next.Binding, Parent: next.Parent, Expected: next.Reference, ExactDispatchID: next.DispatchID}
			if out, err := j.Admit(filesystemCtx, i, before.Revision, next); err != nil || !out.Claimed {
				t.Fatal(out, err)
			}
			image, err := filesystemDecode(m.data)
			if err != nil {
				t.Fatal(err)
			}
			op := image.Operations["guarded"]
			switch variant {
			case "wrong-action":
				op.Intent.Action = task.Message
			case "malformed-dispatch":
				op.Intent.ExactDispatchID = "bad\x00dispatch"
			case "crossed-reference":
				op.Intent.Expected.TurnID = "foreign"
			case "missing-original":
				op.Intent.ExactDispatchID = "missing"
			case "foreign-original":
				other := image.Operations["create"]
				other.Intent.TaskID = "foreign"
				image.Operations["create"] = other
			}
			image.Operations["guarded"] = op
			if _, err := filesystemEncode(image); !errors.Is(err, task.ErrInvalid) {
				t.Fatal("invalid original guard encoded", err)
			}
		})
	}
	for _, change := range []string{"dispatch", "reference"} {
		t.Run("prepare/"+change, func(t *testing.T) {
			j, m := filesystemFixture(t)
			filesystemLaunch(t, j, task.Codex)
			before, _ := j.Read(filesystemCtx, "task")
			next := before.Task
			next.Admission.State = task.AdmissionRevoked
			i := task.Intent{Admission: next.Admission.Binding, OperationID: "guarded", TaskID: "task", Digest: strings.Repeat("b", 64), Action: task.Cancel, Binding: next.Binding, Parent: next.Parent, Expected: next.Reference, ExactDispatchID: next.DispatchID}
			if change == "dispatch" {
				i.ExactDispatchID = "foreign"
			} else {
				i.Expected.TurnID = "foreign"
			}
			writes := m.writes
			if _, err := j.Admit(filesystemCtx, i, before.Revision, next); !errors.Is(err, task.ErrIdentity) {
				t.Fatal("prepared target was not checked", err)
			}
			after, _ := j.Read(filesystemCtx, "task")
			op, _ := j.Lookup(filesystemCtx, "guarded")
			if *after != *before || op != nil || m.writes != writes {
				t.Fatal("invalid guard published")
			}
		})
	}
}
