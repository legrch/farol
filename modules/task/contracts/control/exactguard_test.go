package control_test

// Published DTOs compose the existing selected Task Owner. Provider capability,
// authority, storage and parent ACKs are controlled portable fixtures.
import (
	"testing"

	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
)

func exactFacade(f *fixture, action task.Action, dispatch string, ref control.Reference) (*control.MutationResponse, error) {
	if action == task.Cancel {
		return f.facade.CancelExact(ctx, control.CancelExactRequest{"cancel-1", "task", dispatch, ref})
	}
	return f.facade.DeliverExact(ctx, control.DeliverExactRequest{"deliver-1", "task", dispatch, ref})
}

func TestFacadeExactGuardsDelegateSameOwnerAndRetainACKState(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, kind := range []task.Provider{task.Codex, task.Claude} {
			for _, mode := range []string{"known", "refused", "lost-ack"} {
				t.Run(string(action)+"/"+string(kind)+"/"+mode, func(t *testing.T) {
					f := newFixture(t, kind)
					created := f.create()
					reference := ref(kind, "turn-1", "create-1")
					want := control.Known
					if mode == "refused" {
						want = control.Rejected
					} else if mode == "lost-ack" {
						want = control.Uncertain
					}
					if action == task.Cancel {
						f.provider.caps.Cancel = true
						s := step{action: action, operation: "cancel-1", expected: reference, reference: reference, lifecycle: task.Running, cancel: true, lostAck: mode == "lost-ack"}
						if mode == "refused" {
							s.rejection = "CONTROLLED_REFUSAL"
						}
						f.provider.steps = append(f.provider.steps, s)
					} else {
						if out, err := f.facade.Result(ctx, control.TaskRequest{"task"}); err != nil || !out.Retained {
							t.Fatal(out, err)
						}
						f.delivery.refused = mode == "refused"
						f.delivery.lostAck = mode == "lost-ack"
					}
					out, err := exactFacade(f, action, "create-1", created.Receipt.Reference)
					if err != nil || out == nil || out.Receipt.State != want {
						t.Fatal(out, err)
					}
					if replay, err := exactFacade(f, action, "create-1", created.Receipt.Reference); err != nil || *replay != *out {
						t.Fatal("facade replay changed", replay, err)
					}
					_, err = exactFacade(f, action, "foreign", created.Receipt.Reference)
					requireFailure(t, err, "TASK_OPERATION_CONFLICT")
					changed := created.Receipt.Reference
					if kind == task.Codex {
						changed.TurnID = "foreign"
					} else {
						changed.InvocationID = "foreign"
					}
					_, err = exactFacade(f, action, "create-1", changed)
					requireFailure(t, err, "TASK_OPERATION_CONFLICT")
					id := "deliver-1"
					if action == task.Cancel {
						id = "cancel-1"
						_, err = f.facade.Cancel(ctx, control.CancelRequest{id, "task"})
						requireFailure(t, err, "TASK_OPERATION_CONFLICT")
					}
					original, err := f.facade.Operation(ctx, control.OperationRequest{id})
					if err != nil || original.Receipt.State != want || original.Action != control.Action(action) {
						t.Fatal(original, err)
					}
					if action == task.Cancel {
						if f.provider.effects != 2 || f.delivery.calls != 0 {
							t.Fatal("extra cancel effects")
						}
					} else if f.provider.effects != 1 || f.delivery.calls != 1 {
						t.Fatal("extra delivery effects")
					}
				})
			}
		}
	}
}

func TestFacadeExactGuardsRejectMalformedStaleAndUnqualifiedTargets(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, variant := range []string{"empty", "malformed", "stale", "reference", "valid"} {
			t.Run(string(action)+"/"+variant, func(t *testing.T) {
				f := newFixture(t, task.Codex)
				created := f.create()
				dispatch, reference := "create-1", created.Receipt.Reference
				want := "TASK_IDENTITY_MISMATCH"
				switch variant {
				case "empty":
					dispatch = ""
					want = "TASK_INPUT_INVALID"
				case "malformed":
					reference.SessionID = "crossed"
					want = "TASK_INPUT_INVALID"
				case "stale":
					dispatch = "foreign"
				case "reference":
					reference.TurnID = "foreign"
				case "valid":
					if action == task.Cancel {
						want = "TASK_CAPABILITY_UNAVAILABLE"
					} else {
						want = "TASK_STATE_REFUSED"
					}
				}
				_, err := exactFacade(f, action, dispatch, reference)
				requireFailure(t, err, want)
				if f.provider.effects != 1 || f.provider.reads != 0 || f.delivery.calls != 0 {
					t.Fatal("guard manufactured authority or effects")
				}
			})
		}
	}
}
