package task

// Controlled Task owner/journal witnesses. Cancel capability and parent sends
// are scripted policy ports, not production Codex or native qualification.
import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

func guardedMutation(s *Service, c context.Context, action task.Action, operation, dispatch string, reference task.Reference) (*MutationResponse, error) {
	if action == task.Cancel {
		return s.CancelExact(c, CancelExactRequest{operation, "task-1", dispatch, reference})
	}
	out, err := s.DeliverExact(c, DeliverExactRequest{operation, "task-1", dispatch, reference})
	if out == nil {
		return nil, err
	}
	return &MutationResponse{out.OperationID, out.TaskID, out.Receipt}, err
}

func TestExactGuardRejectsStaleDispatchAndEveryReferenceComponent(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, kind := range []task.Provider{task.Codex, task.Claude} {
			for _, change := range []string{"dispatch", "thread", "turn", "session", "invocation", "missing-reference", "missing-dispatch"} {
				t.Run(string(action)+"/"+string(kind)+"/"+change, func(t *testing.T) {
					s, j, _, p, d := setup(kind)
					p.caps.Cancel = true // Controlled capability only.
					create(t, s, kind)
					if action == task.Deliver {
						complete(t, s)
					}
					ref, dispatch := reference(kind, "turn-1"), "create-1"
					switch change {
					case "dispatch":
						dispatch = "foreign"
					case "thread":
						ref.ThreadID = "foreign"
					case "turn":
						ref.TurnID = "foreign"
					case "session":
						ref.SessionID = "foreign"
					case "invocation":
						ref.InvocationID = "foreign"
					case "missing-reference":
						ref = task.Reference{}
					case "missing-dispatch":
						dispatch = ""
					}
					before, _ := j.Read(ctx, "task-1")
					calls, reads, sends := p.calls, p.reads, d.calls
					_, err := guardedMutation(s, ctx, action, "guarded", dispatch, ref)
					want := task.ErrIdentity
					if change == "missing-reference" || change == "missing-dispatch" ||
						kind == task.Codex && (change == "session" || change == "invocation") ||
						kind == task.Claude && (change == "thread" || change == "turn") {
						want = task.ErrInvalid
					}
					after, _ := j.Read(ctx, "task-1")
					op, _ := j.Lookup(ctx, "guarded")
					if !errors.Is(err, want) || *after != *before || op != nil || p.calls != calls || p.reads != reads || d.calls != sends {
						t.Fatal("stale/malformed guard changed journal or reached effect", err, op)
					}
				})
			}
		}
	}
}

// Original RED showed that a separate successful consumer read plus a legacy
// call could target the successor. These exact calls retain the original guard.
func TestExactGuardRejectsSuccessorAfterConsumerRead(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		t.Run(string(action), func(t *testing.T) {
			s, j, _, p, d := setup(task.Codex)
			create(t, s, task.Codex)
			if action == task.Deliver {
				complete(t, s)
			}
			original, _ := j.Read(ctx, "task-1")
			if action == task.Cancel {
				complete(t, s)
			}
			p.receipt.Reference = reference(task.Codex, "turn-2")
			if _, err := s.ContinueExact(ctx, ContinueExactRequest{"successor", "task-1", "next", "create-1"}); err != nil {
				t.Fatal(err)
			}
			if action == task.Deliver {
				p.observation.Reference = p.receipt.Reference
				complete(t, s)
				d.receipt.Reference = p.receipt.Reference
			}
			before, _ := j.Read(ctx, "task-1")
			_, err := guardedMutation(s, ctx, action, "stale-control", original.Task.DispatchID, original.Task.Reference)
			after, _ := j.Read(ctx, "task-1")
			op, _ := j.Lookup(ctx, "stale-control")
			if !errors.Is(err, task.ErrIdentity) || *after != *before || op != nil || p.calls != 2 || d.calls != 0 {
				t.Fatal("successor was substituted", err, op, after)
			}
		})
	}
}

func TestExactGuardKnownRefusedLostACKReplayAndLegacyIsolation(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, kind := range []task.Provider{task.Codex, task.Claude} {
			for _, mode := range []string{"known", "refused", "lost-ack", "lost-finish-ack"} {
				t.Run(string(action)+"/"+string(kind)+"/"+mode, func(t *testing.T) {
					_, j, a, p, d := setup(kind)
					p.caps.Cancel = true
					owner, route := ownerRoute(t, j)
					s := ownedService(t, route, a, p, d)
					create(t, s, kind)
					if action == task.Deliver {
						complete(t, s)
					} else {
						p.receipt.CancelRequested = true
					}
					want := task.Known
					if mode == "refused" {
						want = task.Rejected
						if action == task.Cancel {
							p.receipt = task.Receipt{State: want, Code: "CONTROLLED_REFUSAL"}
						} else {
							d.receipt = task.Receipt{State: want, Code: "CONTROLLED_REFUSAL"}
						}
					} else if mode == "lost-ack" {
						want = task.Uncertain
						if action == task.Cancel {
							p.dispatchErr = errors.New("controlled lost cancel ACK")
						} else {
							d.err = errors.New("controlled lost parent ACK")
						}
					} else if mode == "lost-finish-ack" {
						j.failFinish = true
						want = task.Uncertain
					}
					ref := reference(kind, "turn-1")
					out, err := guardedMutation(s, ctx, action, "guarded", "create-1", ref)
					if err != nil || out == nil || out.Receipt.State != want {
						t.Fatal(out, err)
					}
					j.failFinish = false
					retained, _ := j.Lookup(ctx, "guarded")
					if retained.Intent.ExactDispatchID != "create-1" || retained.Intent.Expected != ref {
						t.Fatal("target not durable", retained)
					}
					for _, target := range []struct {
						dispatch string
						ref      task.Reference
					}{{"", ref}, {"create-1", task.Reference{}}} {
						if disclosure, err := guardedMutation(s, ctx, action, "guarded", target.dispatch, target.ref); !errors.Is(err, task.ErrInvalid) || disclosure != nil {
							t.Fatal("missing guard disclosed original operation", disclosure, err)
						}
					}
					replayWant := want
					if mode == "lost-finish-ack" {
						replayWant = task.Known
					}
					if replay, err := guardedMutation(s, ctx, action, "guarded", "create-1", ref); err != nil || replay.Receipt.State != replayWant {
						t.Fatal("replay changed original receipt", replay, err)
					}
					changed := ref
					if kind == task.Codex {
						changed.TurnID = "foreign"
					} else {
						changed.InvocationID = "foreign"
					}
					for _, target := range []struct {
						dispatch string
						ref      task.Reference
					}{{"foreign", ref}, {"create-1", changed}} {
						if _, err := guardedMutation(s, ctx, action, "guarded", target.dispatch, target.ref); !errors.Is(err, task.ErrConflict) {
							t.Fatal("changed guard replayed", err)
						}
					}
					if action == task.Cancel {
						_, err = s.Control(ctx, MutationRequest{"guarded", "task-1", "", action})
					} else {
						_, err = s.Deliver(ctx, DeliverRequest{"guarded", "task-1"})
					}
					if !errors.Is(err, task.ErrConflict) {
						t.Fatal("legacy replay discarded exact guard", err)
					}
					fresh, err := owner.Select(selection(2, "not-original-turn"))
					if err != nil {
						t.Fatal(err)
					}
					// Lookup through a foreign selected epoch retains the existing
					// service contract: classified read uncertainty, no disclosure.
					if disclosure, err := guardedMutation(ownedService(t, fresh, a, p, d), ctx, action, "guarded", "create-1", ref); !errors.Is(err, task.ErrUnknown) || disclosure != nil {
						t.Fatal("fresh epoch disclosed old mutation", disclosure, err)
					}
					a.parentDenied = true
					if disclosure, err := guardedMutation(s, ctx, action, "guarded", "create-1", ref); !errors.Is(err, task.ErrState) || disclosure != nil {
						t.Fatal("revoked parent received mutation receipt", disclosure, err)
					}
					after, _ := j.Lookup(ctx, "guarded")
					if !reflect.DeepEqual(after, retained) || p.calls != 1+boolCount(action == task.Cancel) || d.calls != boolCount(action == task.Deliver) {
						t.Fatal("replay changed retained evidence or repeated effect")
					}
					if mode == "lost-ack" {
						snapshot, _ := j.Read(ctx, "task-1")
						if snapshot.Pending != "guarded" || retained.Settled {
							t.Fatal("UNKNOWN cleared", snapshot)
						}
					}
					// Delivery keeps its existing closed/fenced route behavior. Neither
					// form may regain a positive admission after a receipt replay.
					if b, err := current(route); b != nil || err != nil && !errors.Is(err, task.ErrUnavailable) {
						t.Fatal("replay restored admission", b, err)
					}
				})
			}
		}
	}
}

func boolCount(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestExactGuardCannotReplayLegacyOperation(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, mode := range []string{"known", "refused", "lost-ack"} {
			t.Run(string(action)+"/"+mode, func(t *testing.T) {
				s, j, _, p, d := setup(task.Codex)
				create(t, s, task.Codex)
				if mode == "refused" {
					if action == task.Cancel {
						p.receipt = task.Receipt{State: task.Rejected, Code: "CONTROLLED_REFUSAL"}
					} else {
						d.receipt = task.Receipt{State: task.Rejected, Code: "CONTROLLED_REFUSAL"}
					}
				} else if mode == "lost-ack" {
					if action == task.Cancel {
						p.dispatchErr = errors.New("controlled lost ACK")
					} else {
						d.err = errors.New("controlled lost ACK")
					}
				}
				if action == task.Cancel {
					if mode != "refused" {
						p.receipt.CancelRequested = true
					}
					if _, err := s.Control(ctx, MutationRequest{"legacy", "task-1", "", action}); err != nil {
						t.Fatal(err)
					}
				} else {
					complete(t, s)
					if _, err := s.Deliver(ctx, DeliverRequest{"legacy", "task-1"}); err != nil {
						t.Fatal(err)
					}
				}
				before, _ := j.Lookup(ctx, "legacy")
				if _, err := guardedMutation(s, ctx, action, "legacy", "create-1", reference(task.Codex, "turn-1")); !errors.Is(err, task.ErrConflict) {
					t.Fatal("exact guard adopted legacy operation", err)
				}
				after, _ := j.Lookup(ctx, "legacy")
				if !reflect.DeepEqual(after, before) || p.calls != 1+boolCount(action == task.Cancel) || d.calls != boolCount(action == task.Deliver) {
					t.Fatal("legacy receipt or effects changed")
				}
			})
		}
	}
}

func TestExactGuardRetainsOriginalReplayAfterKnownSuccessor(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, refusal := range []bool{false, true} {
			t.Run(string(action)+"/"+map[bool]string{false: "known", true: "refused"}[refusal], func(t *testing.T) {
				_, j, a, p, d := setup(task.Codex)
				owner, old := ownerRoute(t, j)
				s := ownedService(t, old, a, p, d)
				create(t, s, task.Codex)
				if action == task.Deliver {
					complete(t, s)
				} else {
					p.receipt.CancelRequested = true
				}
				if refusal {
					if action == task.Cancel {
						p.receipt = task.Receipt{State: task.Rejected, Code: "CONTROLLED_REFUSAL"}
					} else {
						d.receipt = task.Receipt{State: task.Rejected, Code: "CONTROLLED_REFUSAL"}
					}
				}
				out, err := guardedMutation(s, ctx, action, "original-control", "create-1", reference(task.Codex, "turn-1"))
				if err != nil {
					t.Fatal(err)
				}
				if action == task.Cancel {
					complete(t, s)
				}
				fresh, err := owner.Select(selection(2, "next-turn"))
				if err != nil {
					t.Fatal(err)
				}
				p.receipt = task.Receipt{State: task.Known, Lifecycle: task.Running, Reference: reference(task.Codex, "turn-2")}
				if _, err := ownedService(t, fresh, a, p, d).ContinueExact(ctx, ContinueExactRequest{"successor", "task-1", "next", "create-1"}); err != nil {
					t.Fatal(err)
				}
				before, _ := j.Read(ctx, "task-1")
				if replay, err := guardedMutation(s, ctx, action, "original-control", "create-1", reference(task.Codex, "turn-1")); err != nil || *replay != *out {
					t.Fatal("old receipt replaced by new dispatch", replay, err)
				}
				if _, err := guardedMutation(s, ctx, action, "original-control", "successor", reference(task.Codex, "turn-2")); !errors.Is(err, task.ErrConflict) {
					t.Fatal("same operation retargeted successor", err)
				}
				after, _ := j.Read(ctx, "task-1")
				if *before != *after || p.calls != 2+boolCount(action == task.Cancel) || d.calls != boolCount(action == task.Deliver) {
					t.Fatal("replay altered newer task")
				}
			})
		}
	}
}

func TestExactCancelSnapshotCASRejectsCompletionAndSuccessor(t *testing.T) {
	winner, j, a, p, d := setup(task.Codex)
	create(t, winner, task.Codex)
	blocked := &exactParentBarrierProvider{fakeProvider: &fakeProvider{caps: p.caps, receipt: p.receipt}, entered: make(chan struct{}), release: make(chan struct{})}
	loser := newService(j, a, map[task.Provider]port.Provider{task.Codex: blocked}, d)
	done := make(chan error, 1)
	go func() {
		_, err := loser.CancelExact(ctx, CancelExactRequest{"old-cancel", "task-1", "create-1", reference(task.Codex, "turn-1")})
		done <- err
	}()
	await(t, blocked.entered)
	complete(t, winner)
	p.receipt.Reference = reference(task.Codex, "turn-2")
	if _, err := winner.ContinueExact(ctx, ContinueExactRequest{"successor", "task-1", "next", "create-1"}); err != nil {
		t.Fatal(err)
	}
	before, _ := j.Read(ctx, "task-1")
	close(blocked.release)
	if err := awaitError(t, done); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("old snapshot was admitted", err)
	}
	after, _ := j.Read(ctx, "task-1")
	op, _ := j.Lookup(ctx, "old-cancel")
	if *after != *before || op != nil || blocked.calls != 0 || p.calls != 2 {
		t.Fatal("CAS substituted successor", after, op)
	}
}

func TestExactDeliverySnapshotCASRejectsFreshOwnerSuccessor(t *testing.T) {
	_, j, a, p, d := setup(task.Codex)
	owner, old := ownerRoute(t, j)
	winner := ownedService(t, old, a, p, d)
	create(t, winner, task.Codex)
	complete(t, winner)
	barrier := &deliveryAdmissionBarrier{SelectedJournal: old, entered: make(chan struct{}), release: make(chan struct{})}
	loser, err := NewOwned(barrier, a, map[task.Provider]port.Provider{task.Codex: p}, d, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := loser.DeliverExact(ctx, DeliverExactRequest{"old-delivery", "task-1", "create-1", reference(task.Codex, "turn-1")})
		done <- err
	}()
	await(t, barrier.entered)
	fresh, err := owner.Select(selection(2, "successor-turn"))
	if err != nil {
		t.Fatal(err)
	}
	p.receipt.Reference = reference(task.Codex, "turn-2")
	if _, err := ownedService(t, fresh, a, p, d).ContinueExact(ctx, ContinueExactRequest{"successor", "task-1", "next", "create-1"}); err != nil {
		t.Fatal(err)
	}
	before, _ := j.Read(ctx, "task-1")
	close(barrier.release)
	if err := awaitError(t, done); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("old owner mutated successor", err)
	}
	after, _ := j.Read(ctx, "task-1")
	op, _ := j.Lookup(ctx, "old-delivery")
	if *after != *before || op != nil || d.calls != 0 || p.calls != 2 {
		t.Fatal("stale delivery reached parent", after, op)
	}
}

func TestExactControlSameOperationRaceRetainsLateAuthorityFence(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, state := range []task.ReceiptState{task.Known, task.Rejected, task.Uncertain} {
			for _, withdrawal := range []string{"unchanged", "parent", "binding", "caller"} {
				t.Run(string(action)+"/"+string(state)+"/"+withdrawal, func(t *testing.T) {
					_, j, base, p, d := setup(task.Codex)
					a := &parentWindowAuthority{fakeAuthority: base, parent: request(task.Codex).Parent}
					_, route := ownerRoute(t, j)
					winner, err := NewOwned(route, a, map[task.Provider]port.Provider{task.Codex: p}, d, intent.Fingerprint, providerclient.NewProgress)
					if err != nil {
						t.Fatal(err)
					}
					create(t, winner, task.Codex)
					if action == task.Deliver {
						complete(t, winner)
					} else {
						p.receipt.CancelRequested = true
					}
					if state == task.Rejected {
						if action == task.Deliver {
							d.receipt = task.Receipt{State: state, Code: "PARENT_REFUSED"}
						} else {
							p.receipt = task.Receipt{State: state, Code: "CONTROLLED_REFUSAL"}
						}
					} else if state == task.Uncertain {
						if action == task.Deliver {
							d.err = errors.New("controlled lost ACK")
						} else {
							p.dispatchErr = errors.New("controlled lost ACK")
						}
					}
					barrier := &deliveryAdmissionBarrier{SelectedJournal: route, entered: make(chan struct{}), release: make(chan struct{})}
					loser, err := NewOwned(barrier, a, map[task.Provider]port.Provider{task.Codex: p}, d, intent.Fingerprint, providerclient.NewProgress)
					if err != nil {
						t.Fatal(err)
					}
					c, cancel := context.WithCancel(ctx)
					defer cancel()
					type result struct {
						out *MutationResponse
						err error
					}
					done := make(chan result, 1)
					go func() {
						out, err := guardedMutation(loser, c, action, "delivery", "create-1", reference(task.Codex, "turn-1"))
						done <- result{out, err}
					}()
					await(t, barrier.entered)
					if out, err := guardedMutation(winner, ctx, action, "delivery", "create-1", reference(task.Codex, "turn-1")); err != nil || out.Receipt.State != state {
						t.Fatal(out, err)
					}
					original, _ := j.Lookup(ctx, "delivery")
					want := task.ErrState
					switch withdrawal {
					case "parent":
						a.withdrawn = true
					case "binding":
						a.denied = true
					case "caller":
						cancel()
						want = context.Canceled
					}
					close(barrier.release)
					out := <-done
					if withdrawal == "unchanged" {
						if out.err != nil || out.out == nil || out.out.Receipt.State != state {
							t.Fatal(out)
						}
					} else if !errors.Is(out.err, want) || out.out != nil {
						t.Fatal("withdrawn caller received receipt", out)
					}
					retained, _ := j.Lookup(ctx, "delivery")
					if !reflect.DeepEqual(original, retained) || d.calls != boolCount(action == task.Deliver) || p.calls != 1+boolCount(action == task.Cancel) {
						t.Fatal("race changed evidence or replayed effect")
					}
				})
			}
		}
	}
}

func TestExactGuardParentWithdrawalRetainsPublishedIntentAndReceipt(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		for _, cut := range []string{"admit", "finish"} {
			t.Run(string(action)+"/"+cut, func(t *testing.T) {
				_, base, authority, p, d := setup(task.Codex)
				a := &parentWindowAuthority{fakeAuthority: authority, parent: request(task.Codex).Parent}
				j := &parentWindowJournal{fakeJournal: base}
				_, route := ownerRoute(t, j)
				s, err := NewOwned(route, a, map[task.Provider]port.Provider{task.Codex: p}, d, intent.Fingerprint, providerclient.NewProgress)
				if err != nil {
					t.Fatal(err)
				}
				create(t, s, task.Codex)
				if action == task.Deliver {
					complete(t, s)
				} else {
					p.receipt.CancelRequested = true
				}
				withdraw := func() { a.withdrawn = true }
				if cut == "admit" {
					j.afterAdmit = withdraw
				} else {
					j.afterFinish = withdraw
				}
				out, err := guardedMutation(s, ctx, action, "guarded", "create-1", reference(task.Codex, "turn-1"))
				if cut == "admit" {
					if err != nil || out == nil || out.Receipt.State != task.Uncertain {
						t.Fatal("published intent misclassified", out, err)
					}
				} else if !errors.Is(err, task.ErrState) || out != nil {
					t.Fatal("withdrawn parent got known receipt", out, err)
				}
				op, _ := j.Lookup(ctx, "guarded")
				snapshot, _ := j.Read(ctx, "task-1")
				if op.Intent.ExactDispatchID != "create-1" || op.Intent.Expected != reference(task.Codex, "turn-1") || op.Intent.Parent != request(task.Codex).Parent || op.Settled != (cut == "finish") || (snapshot.Pending == "guarded") != (cut == "admit") {
					t.Fatal("published evidence changed", op, snapshot)
				}
				if cut == "admit" {
					if p.calls != 1 || d.calls != 0 {
						t.Fatal("withdrawal reached effect")
					}
				} else if p.calls != 1+boolCount(action == task.Cancel) || d.calls != boolCount(action == task.Deliver) {
					t.Fatal("wrong effect count")
				}
				a.withdrawn = false
				j.afterAdmit = nil
				j.afterFinish = nil
				want := task.Uncertain
				if cut == "finish" {
					want = task.Known
				}
				if replay, err := guardedMutation(s, ctx, action, "guarded", "create-1", reference(task.Codex, "turn-1")); err != nil || replay.Receipt.State != want {
					t.Fatal("replay did not retain original evidence", replay, err)
				}
				retained, _ := j.Lookup(ctx, "guarded")
				if !reflect.DeepEqual(op, retained) {
					t.Fatal("replay settled or changed original operation")
				}
			})
		}
	}
}

func TestExactGuardSameOperationRaceCannotAdoptLegacyIntent(t *testing.T) {
	for _, action := range []task.Action{task.Cancel, task.Deliver} {
		t.Run(string(action), func(t *testing.T) {
			_, j, a, p, d := setup(task.Codex)
			_, route := ownerRoute(t, j)
			winner := ownedService(t, route, a, p, d)
			create(t, winner, task.Codex)
			if action == task.Deliver {
				complete(t, winner)
			} else {
				p.receipt.CancelRequested = true
			}
			barrier := &deliveryAdmissionBarrier{SelectedJournal: route, entered: make(chan struct{}), release: make(chan struct{})}
			loser, err := NewOwned(barrier, a, map[task.Provider]port.Provider{task.Codex: p}, d, intent.Fingerprint, providerclient.NewProgress)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := guardedMutation(loser, ctx, action, "same-operation", "create-1", reference(task.Codex, "turn-1"))
				done <- err
			}()
			await(t, barrier.entered)
			if action == task.Deliver {
				_, err = winner.Deliver(ctx, DeliverRequest{"same-operation", "task-1"})
			} else {
				_, err = winner.Control(ctx, MutationRequest{"same-operation", "task-1", "", action})
			}
			if err != nil {
				t.Fatal(err)
			}
			original, _ := j.Lookup(ctx, "same-operation")
			close(barrier.release)
			if err := awaitError(t, done); !errors.Is(err, task.ErrConflict) {
				t.Fatal("retained mismatching race intent was not an operation conflict", err)
			}
			retained, _ := j.Lookup(ctx, "same-operation")
			if !reflect.DeepEqual(original, retained) || retained.Intent.ExactDispatchID != "" || p.calls != 1+boolCount(action == task.Cancel) || d.calls != boolCount(action == task.Deliver) {
				t.Fatal("race altered legacy evidence")
			}
		})
	}
}
