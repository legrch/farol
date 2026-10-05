package boot

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Real generated JSON-RPC and memory pipes, no OS child/files/socket/provider.
// Prepared is an explicit test fact, not native qualification evidence.
type heldClock struct{ nanos atomic.Int64 }

func (c *heldClock) Now() time.Time { return time.Unix(0, c.nanos.Load()) }

type heldReplyWriter struct {
	*io.PipeWriter
	started chan struct{}
	allow   chan struct{}
	fail    bool
}

func (w *heldReplyWriter) Write(raw []byte) (int, error) {
	var response wire.Response
	if json.Unmarshal(raw, &response) == nil && response.Result != nil && response.Result.OperationId != nil {
		close(w.started)
		<-w.allow
		if w.fail {
			return 0, io.ErrClosedPipe
		}
	}
	return w.PipeWriter.Write(raw)
}

type heldFixture struct {
	control *processHeldControl
	gate    *processHeldGate
	clock   *heldClock
	writer  *heldReplyWriter
	cancel  context.CancelFunc
}

func newHeldFixture(t *testing.T, change func(*wire.ComputerHeldIdentity), blockReply bool, failReply bool) *heldFixture {
	t.Helper()
	clock := &heldClock{}
	clock.nanos.Store(time.Now().UnixNano())
	identity := wire.ComputerHeldIdentity{BuildId: BuildID, ProfileId: "profile", BackendGeneration: "backend", OperationId: "operation", SealSha256: strings.Repeat("a", 64), AnchorLifetimeId: "anchor", ChildLaunchId: "held-child", Deadline: clock.Now().Add(15 * time.Second).UTC().Format(time.RFC3339Nano)}
	control, err := newProcessHeldControl(identity, clock)
	if err != nil {
		t.Fatal(err)
	}
	server, err := control.Server()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.Server(); err == nil {
		t.Fatal("second role server constructed")
	}
	input, send := io.Pipe()
	receive, output := io.Pipe()
	writer := &heldReplyWriter{PipeWriter: output, started: make(chan struct{}), allow: make(chan struct{}), fail: failReply}
	if !blockReply {
		close(writer.allow)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, input, writer) }()
	if change != nil {
		change(&identity)
	}
	gate, err := newProcessHeldGate(identity, clock, receive, send)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	f := &heldFixture{control: control, gate: gate, clock: clock, writer: writer, cancel: cancel}
	t.Cleanup(func() {
		select {
		case <-writer.allow:
		default:
			close(writer.allow)
		}
		_ = gate.Close()
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("held protocol did not close owned memory pipes")
		}
	})
	return f
}

func heldUnknown(t *testing.T, err error) {
	t.Helper()
	var failure *processsvc.NativeFailure
	if !errors.As(err, &failure) || !failure.Unknown {
		t.Fatal("role channel did not retain unknown", err)
	}
}
func (f *heldFixture) prepare(t *testing.T) {
	t.Helper()
	if err := f.control.Prepared(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func (f *heldFixture) ready(t *testing.T) {
	t.Helper()
	for i := 0; i < 2; i++ {
		if err := f.gate.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestProcessHeldSharedProtocolReleasesOnlyAfterCompleteACK(t *testing.T) {
	f := newHeldFixture(t, nil, true, false)
	f.prepare(t)
	f.ready(t)
	result := make(chan error, 1)
	go func() { result <- f.gate.Release(context.Background()) }()
	select {
	case <-f.writer.started:
	case <-time.After(time.Second):
		t.Fatal("release did not reach ACK write")
	}
	select {
	case <-f.control.release:
		t.Fatal("guest released before ACK frame write completed")
	default:
	}
	close(f.writer.allow)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("release reply blocked")
	}
	select {
	case <-f.control.release:
	case <-time.After(time.Second):
		t.Fatal("known ACK did not release held gate")
	}
	if f.gate.attempt != 4 || f.gate.barrier != 2 {
		t.Fatal("not one handshake, two same-child barriers and one release")
	}
	heldUnknown(t, f.gate.Release(context.Background()))
	if f.gate.attempt != 4 {
		t.Fatal("release sent twice")
	}
}

func TestProcessHeldLostACKNeverReleasesOrRetries(t *testing.T) {
	f := newHeldFixture(t, nil, false, true)
	f.prepare(t)
	f.ready(t)
	heldUnknown(t, f.gate.Release(context.Background()))
	select {
	case <-f.control.release:
		t.Fatal("failed ACK write released guest")
	default:
	}
	heldUnknown(t, f.gate.Release(context.Background()))
	if f.gate.attempt != 4 {
		t.Fatal("lost release replayed")
	}
}

func TestProcessHeldCrossedIdentityFencesTheSameChannel(t *testing.T) {
	cases := map[string]func(*wire.ComputerHeldIdentity){
		"profile":   func(i *wire.ComputerHeldIdentity) { i.ProfileId = "other-profile" },
		"backend":   func(i *wire.ComputerHeldIdentity) { i.BackendGeneration = "other-backend" },
		"operation": func(i *wire.ComputerHeldIdentity) { i.OperationId = "other-operation" },
		"seal":      func(i *wire.ComputerHeldIdentity) { i.SealSha256 = strings.Repeat("b", 64) },
		"anchor":    func(i *wire.ComputerHeldIdentity) { i.AnchorLifetimeId = "other-anchor" },
		"child":     func(i *wire.ComputerHeldIdentity) { i.ChildLaunchId = "other-child" },
		"deadline": func(i *wire.ComputerHeldIdentity) {
			d, _ := time.Parse(time.RFC3339Nano, i.Deadline)
			i.Deadline = d.Add(-time.Second).UTC().Format(time.RFC3339Nano)
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newHeldFixture(t, change, false, false)
			f.prepare(t)
			heldUnknown(t, f.gate.Ready(context.Background()))
			attempts := f.gate.attempt
			heldUnknown(t, f.gate.Ready(context.Background()))
			if f.gate.attempt != attempts {
				t.Fatal("crossed role reopened")
			}
			select {
			case <-f.control.release:
				t.Fatal("crossed role released")
			default:
			}
		})
	}
}

func TestProcessHeldOrderingDeadlineAndMissingPreparationRefuse(t *testing.T) {
	for _, mode := range []string{"early-release", "third-ready", "expired", "not-prepared", "nil-context"} {
		t.Run(mode, func(t *testing.T) {
			f := newHeldFixture(t, nil, false, false)
			if mode != "not-prepared" {
				f.prepare(t)
			}
			var err error
			switch mode {
			case "early-release":
				err = f.gate.Release(context.Background())
			case "third-ready":
				f.ready(t)
				err = f.gate.Ready(context.Background())
			case "expired":
				f.ready(t)
				f.clock.nanos.Add(int64(15 * time.Second))
				err = f.gate.Release(context.Background())
			case "not-prepared":
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
				defer cancel()
				err = f.gate.Ready(ctx)
			case "nil-context":
				err = f.gate.Ready(nil)
			}
			heldUnknown(t, err)
			attempts := f.gate.attempt
			heldUnknown(t, f.gate.Release(context.Background()))
			if f.gate.attempt != attempts {
				t.Fatal("failed control call retried")
			}
			select {
			case <-f.control.release:
				t.Fatal("unqualified release")
			default:
			}
		})
	}
}

func TestProcessHeldConstructorHasNoIdentityFallback(t *testing.T) {
	f := newHeldFixture(t, nil, false, false)
	for _, change := range []func(*wire.ComputerHeldIdentity){
		func(i *wire.ComputerHeldIdentity) { i.BuildId = "other-build" },
		func(i *wire.ComputerHeldIdentity) { i.ChildLaunchId = i.AnchorLifetimeId },
		func(i *wire.ComputerHeldIdentity) { i.SealSha256 = "invalid" },
		func(i *wire.ComputerHeldIdentity) {
			i.Deadline = f.clock.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
		},
	} {
		identity := f.control.identity
		change(&identity)
		if _, err := newProcessHeldControl(identity, f.clock); err == nil {
			t.Fatal("invalid role accepted")
		}
	}
	f.prepare(t)
	heldUnknown(t, f.control.Prepared(context.Background()))
	heldUnknown(t, f.gate.Ready(context.Background()))
}

func TestProcessHeldBoundaryFaultCannotBeCorrectedOnSameStream(t *testing.T) {
	for _, mode := range []string{"backend", "profile", "missing-operation", "duplicate-request", "unknown-method"} {
		t.Run(mode, func(t *testing.T) {
			f := newHeldFixture(t, nil, false, false)
			f.prepare(t)
			f.ready(t)
			original := f.gate.identity
			body := wire.ComputerHeldBarrier{Identity: original, Barrier: 2}
			method, effect := heldReleaseMethod, true
			switch mode {
			case "backend":
				f.gate.identity.BackendGeneration = "crossed-backend"
			case "profile":
				f.gate.identity.ProfileId = "crossed-profile"
			case "missing-operation":
				effect = false
			case "duplicate-request":
				f.gate.attempt--
			case "unknown-method":
				method = "computer.process.held.exec"
			}
			// Deliberately bypass public gate.control's client-side failure fence:
			// this adversarial peer writes canonical raw envelopes on the SAME pipe.
			if _, err := f.gate.call(method, body, effect); err == nil {
				t.Fatal("bad envelope admitted")
			}
			f.gate.identity = original
			if _, err := f.gate.call(heldReleaseMethod, body, true); err == nil {
				t.Fatal("corrected request released after a boundary fault")
			}
			select {
			case <-f.control.release:
				t.Fatal("boundary fault became retryable")
			default:
			}
		})
	}
}
