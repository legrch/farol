//go:build darwin || linux

package workflow_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/workflow"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

// The finite trace matrix combines actual Task persistence boundaries with an
// already settled sibling and later parent withdrawal. It uses only controlled
// ports and the explicit original-plan input; there is no durable workflow store
// or production admission/atomic-control qualification in these witnesses.
func TestTraceRestartBoundaryCombinations(t *testing.T) {
	boundaries := []string{"admitACK", "requestACK", "finishACK", "resultObserveACK", "beforeResultRecord", "parentSendACK", "deliveryFinishACK"}
	for _, boundary := range boundaries {
		for _, first := range []string{"a", "b"} {
			for _, revoked := range []bool{false, true} {
				parent := "open"
				if revoked {
					parent = "revoked"
				}
				t.Run(boundary+"/"+first+"-first/"+parent, func(t *testing.T) {
					owner := newTracePlanOwner(t)
					f, second := traceSettledSibling(t, owner, first)
					taskID, createID := "task-"+second, "create-"+second
					switch boundary {
					case "admitACK":
						f.faults.admit = true
					case "requestACK":
						f.provider.lostDispatchACK[taskID] = true
					case "finishACK":
						f.provider.immediate[taskID] = port.Observation{Lifecycle: task.Completed, Result: strings.ToUpper(second)}
						f.faults.finish = true
					}
					launched := f.tick(1, app.AdmitNew)
					if !reflect.DeepEqual(launched.Started, []string{second}) {
						t.Fatalf("second boundary launch: %+v", launched)
					}
					assertTraceSafety(t, f, owner)
					if boundary == "resultObserveACK" || boundary == "beforeResultRecord" || boundary == "parentSendACK" || boundary == "deliveryFinishACK" {
						f.provider.settle(taskID, createID, task.Completed, strings.ToUpper(second))
						if boundary == "resultObserveACK" {
							f.faults.observe = true
						}
						var cut *traceBeforeResultRecord
						if boundary == "beforeResultRecord" {
							cut = cutTraceBeforeResult(t, f, taskID)
						}
						observed := f.tick(1, app.Reconnect)
						if cut != nil && !cut.fired {
							t.Fatal("before-result record cut was not exercised")
						}
						if boundary == "resultObserveACK" || boundary == "beforeResultRecord" {
							if progress(t, observed, second).State != wf.Unknown {
								t.Fatalf("lost observation ACK: %+v", observed)
							}
						} else if !progress(t, observed, second).Accepted {
							t.Fatalf("second settlement: %+v", observed)
						}
						if boundary == "parentSendACK" || boundary == "deliveryFinishACK" {
							if boundary == "parentSendACK" {
								f.delivery.lostACK = true
							} else {
								f.faults.finish = true
							}
							delivered, err := f.workflow.Deliver(testContext, f.plan)
							if err != nil {
								t.Fatal(err)
							}
							want := app.DeliveryAcknowledged
							if boundary == "parentSendACK" {
								want = app.DeliveryUnknown
							}
							if progress(t, delivered, second).Delivery != want {
								t.Fatalf("delivery boundary: %+v", delivered)
							}
							f.delivery.lostACK = false // Retained unknown operation still forbids another Send.
						}
					}
					assertTraceSafety(t, f, owner)
					f.authority.parentClosed = revoked
					reopenTrace(t, f, owner)
					beforeReconnect := assertTraceSafety(t, f, owner)
					reconnected := f.tick(1, app.Reconnect)
					if len(reconnected.Started) != 0 || progress(t, reconnected, "c").State != wf.Unknown || !progress(t, reconnected, first).Accepted {
						t.Fatalf("reconnect changed retained sibling or launched missing child: %+v", reconnected)
					}
					if after := assertTraceSafety(t, f, owner); !reflect.DeepEqual(beforeReconnect, after) {
						t.Fatalf("reconnect emitted effect: before=%+v after=%+v", beforeReconnect, after)
					}
					unknownExecution := boundary == "admitACK" || boundary == "requestACK"
					if unknownExecution {
						if progress(t, reconnected, second).State != wf.Unknown {
							t.Fatalf("unknown execution was reauthorized: %+v", reconnected)
						}
						pending, err := f.journal.Read(testContext, taskID)
						if err != nil || pending.Pending != createID {
							t.Fatalf("original create fence lost: %+v %v", pending, err)
						}
					} else if !progress(t, reconnected, second).Accepted {
						t.Fatalf("retained second completion lost: %+v", reconnected)
					}
					admitted := f.tick(1, app.AdmitNew)
					canAggregate := !unknownExecution && !revoked
					if canAggregate {
						if !reflect.DeepEqual(admitted.Started, []string{"c"}) {
							t.Fatalf("known retained dependencies did not aggregate: %+v", admitted)
						}
						f.provider.settle("task-c", "create-c", task.Completed, "A+B")
						if !progress(t, f.tick(1, app.Reconnect), "c").Accepted {
							t.Fatal("aggregation result not retained")
						}
					} else if len(admitted.Started) != 0 {
						t.Fatalf("unknown execution/closed parent launched child: %+v", admitted)
					}
					if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
						t.Fatal(err)
					}
					counts := assertTraceSafety(t, f, owner)
					wantSecond := 1
					if boundary == "admitACK" {
						wantSecond = 0
					}
					wantAggregate := 0
					if canAggregate {
						wantAggregate = 1
					}
					if counts.provider["create-"+first] != 1 || counts.parent["deliver-"+first] != 1 || counts.provider[createID] != wantSecond || counts.provider["create-c"] != wantAggregate {
						t.Fatalf("unexpected trace effects: %+v", counts)
					}
					if boundary == "parentSendACK" {
						pending, err := f.journal.Read(testContext, taskID)
						if err != nil || pending.Pending != "deliver-"+second || counts.parent["deliver-"+second] != 1 {
							t.Fatalf("unknown delivery fence/resend: %+v counts=%+v err=%v", pending, counts, err)
						}
					}
					reopenTrace(t, f, owner)
					f.tick(1, app.Reconnect)
					f.tick(1, app.AdmitNew)
					if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
						t.Fatal(err)
					}
					if after := assertTraceSafety(t, f, owner); !reflect.DeepEqual(counts, after) {
						t.Fatalf("settled reconstruction repeated effect: before=%+v after=%+v", counts, after)
					}
				})
			}
		}
	}
}

func TestTraceCancellationRestartCombinations(t *testing.T) {
	for _, first := range []string{"a", "b"} {
		for _, boundary := range []string{"cancelACK", "interruptedObserveACK", "interruptedDeliveryACK"} {
			t.Run(first+"-first/"+boundary, func(t *testing.T) {
				owner := newTracePlanOwner(t)
				f, second := traceSettledSibling(t, owner, first)
				if r := f.tick(1, app.AdmitNew); !reflect.DeepEqual(r.Started, []string{second}) {
					t.Fatalf("remaining single slot: %+v", r)
				}
				assertTraceSafety(t, f, owner)
				if boundary == "cancelACK" {
					f.provider.lostDispatchACK["task-"+second] = true
				}
				cancelled, err := f.workflow.Cancel(testContext, f.plan)
				if err != nil {
					t.Fatal(err)
				}
				if boundary == "cancelACK" {
					if progress(t, cancelled, second).Cancellation != app.CancellationUnknown {
						t.Fatalf("lost cancellation ACK fabricated request acknowledgement: %+v", cancelled)
					}
				} else {
					if progress(t, cancelled, second).Cancellation != app.CancellationAcknowledged {
						t.Fatalf("known cancellation request: %+v", cancelled)
					}
					f.provider.settle("task-"+second, "create-"+second, task.Interrupted, "")
					if boundary == "interruptedObserveACK" {
						f.faults.observe = true
					}
					observed := f.tick(1, app.Reconnect)
					if boundary == "interruptedObserveACK" {
						if progress(t, observed, second).State != wf.Unknown {
							t.Fatalf("lost interrupted observation ACK: %+v", observed)
						}
					} else {
						if progress(t, observed, second).State != wf.Cancelled {
							t.Fatalf("terminal interruption: %+v", observed)
						}
						f.delivery.lostACK = true
						r, err := f.workflow.Deliver(testContext, f.plan)
						if err != nil {
							t.Fatal(err)
						}
						if progress(t, r, second).Delivery != app.DeliveryUnknown {
							t.Fatalf("lost interrupted parent ACK: %+v", r)
						}
						f.delivery.lostACK = false
					}
				}
				assertTraceSafety(t, f, owner)
				reopenTrace(t, f, owner)
				counts := assertTraceSafety(t, f, owner)
				r := f.tick(1, app.Reconnect)
				if !progress(t, r, first).Accepted || progress(t, r, second).Accepted || len(r.Started) != 0 {
					t.Fatalf("cancellation reconstruction lost accepted sibling or supplied dependency: %+v", r)
				}
				if boundary == "cancelACK" {
					if progress(t, r, second).State != wf.Unknown || progress(t, r, second).Cancellation != app.CancellationUnknown {
						t.Fatalf("unknown cancellation fence lost: %+v", r)
					}
					pending, err := f.journal.Read(testContext, "task-"+second)
					if err != nil || pending.Pending != "cancel-"+second {
						t.Fatalf("pending original cancel: %+v %v", pending, err)
					}
				} else if progress(t, r, second).State != wf.Cancelled || progress(t, r, second).Cancellation != app.CancellationAcknowledged {
					t.Fatalf("retained interrupted dispatch: %+v", r)
				}
				if _, err := f.workflow.Cancel(testContext, f.plan); err != nil {
					t.Fatal(err)
				}
				if next := f.tick(1, app.AdmitNew); len(next.Started) != 0 {
					t.Fatalf("cancelled/unknown dependency aggregated: %+v", next)
				}
				// Only the observation-ACK case has a known, as-yet undelivered
				// interruption. Its first delivery is useful work, never a retry.
				if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
					t.Fatal(err)
				}
				after := assertTraceSafety(t, f, owner)
				if after.provider["create-"+first] != 1 || after.provider["create-"+second] != 1 || after.provider["cancel-"+second] != 1 || after.provider["create-c"] != 0 || after.parent["deliver-"+first] != 1 {
					t.Fatalf("cancellation repeated provider/sibling effect: %+v", after)
				}
				if boundary != "interruptedObserveACK" && !reflect.DeepEqual(counts, after) {
					t.Fatalf("unknown cancellation/delivery replayed: before=%+v after=%+v", counts, after)
				}
				reopenTrace(t, f, owner)
				f.tick(1, app.Reconnect)
				if _, err := f.workflow.Cancel(testContext, f.plan); err != nil {
					t.Fatal(err)
				}
				if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
					t.Fatal(err)
				}
				if final := assertTraceSafety(t, f, owner); !reflect.DeepEqual(after, final) {
					t.Fatalf("second cancellation reconstruction replayed: before=%+v after=%+v", after, final)
				}
			})
		}
	}
}

func traceSettledSibling(t *testing.T, owner tracePlanOwner, first string) (*composition, string) {
	t.Helper()
	second := "b"
	if first == "b" {
		second = "a"
	}
	f := newTraceComposition(t, owner)
	f.composer.blocked[second] = true
	f.provider.immediate["task-"+first] = port.Observation{Lifecycle: task.Completed, Result: strings.ToUpper(first)}
	initial := f.tick(1, app.AdmitNew)
	if !reflect.DeepEqual(initial.Started, []string{first}) || !progress(t, initial, first).Accepted {
		t.Fatalf("first sibling did not retain output: %+v", initial)
	}
	assertTraceSafety(t, f, owner)
	r, err := f.workflow.Deliver(testContext, f.plan)
	if err != nil {
		t.Fatal(err)
	}
	if progress(t, r, first).Delivery != app.DeliveryAcknowledged {
		t.Fatalf("first sibling not delivered: %+v", r)
	}
	assertTraceSafety(t, f, owner)
	delete(f.composer.blocked, second)
	return f, second
}
