package boot

// CPU scheduling witness: hold the real Task current gate, wait until this
// exact dispatch goroutine is blocked on it, withdraw the actual Chat parent,
// then release the gate. Stack inspection observes only this Go test process;
// it neither probes a host process nor relies on a fixed sleep for ordering.
import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

func TestTaskProfileParentWithdrawalDuringTaskGateWaitPreventsSend(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	ctx := context.Background()
	factory := f.profile.newClient
	var route *taskrepo.Route
	var armed atomic.Bool
	monitorDone := make(chan error, 1)
	f.profile.newClient = func(selection codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		return factory(selection, q, grant, func(ctx context.Context, original task.Intent) error {
			if armed.CompareAndSwap(false, true) {
				held, release := make(chan struct{}), make(chan struct{})
				holderDone := make(chan error, 1)
				go func() {
					holderDone <- route.WithCurrent(ctx, func(current *port.CurrentBinding) error {
						close(held)
						<-release // Controlled scheduler stall, no provider IO.
						if current == nil {
							return errors.New("controlled Task gate was not active")
						}
						return nil
					})
				}()
				<-held
				go func() {
					err := taskProfileWaitForDispatchGate()
					if err == nil {
						err = f.parent.handle.Cancel(ctx)
					}
					close(release)
					monitorDone <- errors.Join(err, <-holderDone)
				}()
			}
			return dispatch(ctx, original)
		})
	}
	g := f.selectTurn(t, 1)
	route = f.profile.routes[0]
	_, _ = g.Create(ctx, "create", TaskIngressCreateRequest{Message: "do not send after parent cancellation during Task wait"})
	select {
	case err := <-monitorDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("controlled gate monitor did not finish")
	}
	if f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 {
		t.Fatalf("parent withdrawn during Task gate wait still dispatched: thread=%d turn=%d", f.task.pipe.count("thread/start"), f.task.pipe.count("turn/start"))
	}
	op, err := f.task.store.Lookup(ctx, "create")
	if err != nil || op == nil || op.Settled || op.Receipt.State != task.Uncertain {
		t.Fatal("original pending uncertainty was lost", op, err)
	}
	_, _ = g.Create(ctx, "fresh-id", TaskIngressCreateRequest{Message: "no replacement"})
	if f.task.pipe.count("thread/start") != 0 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("withdrawn original operation retried or client replaced")
	}
}

func taskProfileWaitForDispatchGate() error {
	deadline := time.Now().Add(2 * time.Second)
	buffer := make([]byte, 1<<20)
	for time.Now().Before(deadline) {
		for _, stack := range strings.Split(string(buffer[:runtime.Stack(buffer, true)]), "\n\n") {
			if strings.Contains(stack, "boot.(*TaskProfile).recheckDispatch") &&
				strings.Contains(stack, "modules/task/infra/repos/task.(*Route).WithCurrent") &&
				strings.Contains(stack, "[sync.Mutex.Lock]") {
				return nil
			}
		}
		runtime.Gosched()
	}
	return errors.New("original dispatch did not reach the held Task current gate")
}
