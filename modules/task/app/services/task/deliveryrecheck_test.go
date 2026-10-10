package task

// Controlled policy fixtures use the existing Task Owner and atomic memory
// journal. They qualify neither native persistence nor actual parent delivery.
import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

// The first delivery has completed its pre-admission checks before a second
// caller publishes the identical operation. The existing Owner then returns
// that operation without granting another effect or rewriting its receipt.
type deliveryAdmissionBarrier struct {
	port.SelectedJournal
	entered, release chan struct{}
}

func (j *deliveryAdmissionBarrier) Admit(ctx context.Context, i task.Intent, revision uint64, next task.Task) (*port.Admission, error) {
	close(j.entered)
	<-j.release
	return j.SelectedJournal.Admit(ctx, i, revision, next)
}

func TestDeliveryAdmissionRaceRechecksAuthorityBeforeReceiptDisclosure(t *testing.T) {
	for _, state := range []task.ReceiptState{task.Known, task.Rejected, task.Uncertain} {
		for _, window := range []string{"unchanged", "parent-withdrawn", "parent-rebound", "binding-withdrawn", "caller-cancelled"} {
			t.Run(string(state)+"/"+window, func(t *testing.T) {
				_, j, baseAuthority, provider, delivery := setup(task.Codex)
				a := &parentWindowAuthority{fakeAuthority: baseAuthority, parent: request(task.Codex).Parent}
				_, route := ownerRoute(t, j)
				service, err := NewOwned(route, a, map[task.Provider]port.Provider{task.Codex: provider}, delivery, intent.Fingerprint, providerclient.NewProgress)
				if err != nil {
					t.Fatal(err)
				}
				create(t, service, task.Codex)
				complete(t, service)
				if state == task.Rejected {
					delivery.receipt = task.Receipt{State: task.Rejected, Code: "PARENT_REFUSED"}
				} else if state == task.Uncertain {
					delivery.err = errors.New("controlled lost parent acknowledgement")
				}
				barrier := &deliveryAdmissionBarrier{SelectedJournal: route, entered: make(chan struct{}), release: make(chan struct{})}
				stale, err := NewOwned(barrier, a, map[task.Provider]port.Provider{task.Codex: provider}, delivery, intent.Fingerprint, providerclient.NewProgress)
				if err != nil {
					t.Fatal(err)
				}
				call, cancel := context.WithCancel(ctx)
				defer cancel()
				type outcome struct {
					response *DeliverResponse
					err      error
				}
				done := make(chan outcome, 1)
				go func() {
					out, err := stale.Deliver(call, DeliverRequest{"delivery", "task-1"})
					done <- outcome{out, err}
				}()
				await(t, barrier.entered)
				winner, err := service.Deliver(ctx, DeliverRequest{"delivery", "task-1"})
				if err != nil || winner == nil || winner.Receipt.State != state {
					close(barrier.release)
					t.Fatalf("competing delivery: out=%+v err=%v", winner, err)
				}
				wantErr := task.ErrState
				switch window {
				case "parent-withdrawn":
					a.withdrawn = true
				case "parent-rebound":
					a.parent = task.Parent{ThreadID: "replacement-parent", TurnID: "replacement-turn"}
				case "binding-withdrawn":
					a.mu.Lock()
					a.denied = true
					a.mu.Unlock()
				case "caller-cancelled":
					cancel()
					wantErr = context.Canceled
				}
				close(barrier.release)
				out := <-done
				if window == "unchanged" {
					if out.err != nil || out.response == nil || out.response.Receipt.State != state {
						t.Fatalf("exact operation race: out=%+v err=%v", out.response, out.err)
					}
				} else if !errors.Is(out.err, wantErr) || out.response != nil {
					t.Errorf("withdrawn caller received competing delivery receipt: out=%+v err=%v", out.response, out.err)
				}
				retained, err := j.Lookup(ctx, "delivery")
				if err != nil || retained == nil || retained.Receipt.State != state || retained.Settled != (state != task.Uncertain) || delivery.calls != 1 || provider.calls != 1 {
					t.Fatalf("race changed durable evidence or repeated effect: op=%+v err=%v delivery=%d provider=%d", retained, err, delivery.calls, provider.calls)
				}
				snapshot, err := j.Read(ctx, "task-1")
				if err != nil || snapshot == nil || snapshot.Task.Parent != request(task.Codex).Parent || snapshot.Task.Result != "final" || (snapshot.Pending == "delivery") != (state == task.Uncertain) {
					t.Fatalf("race changed parent/result or cleared unknown: snapshot=%+v err=%v", snapshot, err)
				}
			})
		}
	}
}
