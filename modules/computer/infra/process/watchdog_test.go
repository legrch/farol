package process

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CPU only: injected image/physical measurement, evidence, socket and owning
// helper Wait. No os/exec, actual Node, shell, sandbox, native signal or endpoint.
type watchdogTestProcess struct {
	ended   chan error
	waiting chan struct{}
	waits   atomic.Int32
}

func (p *watchdogTestProcess) Wait() error {
	p.waits.Add(1)
	if p.waiting != nil {
		close(p.waiting)
	}
	return <-p.ended
}

type watchdogTestHost struct {
	preflights     atomic.Int32
	calls          atomic.Int32
	starts         atomic.Int32
	stops          atomic.Int32
	process        *watchdogTestProcess
	peer           net.Conn
	frames         chan map[string]any
	selection      WatchdogSelection
	beforeStart    func()
	beforePrepared func()
	beforeStop     func()
	holdWait       bool
	reply          string
	reservation    *parentReservation
	lease          *parentLease
}

func (h *watchdogTestHost) Start(ctx context.Context, selection WatchdogSelection, cwd string, check func() error) (watchdogProcess, watchdogChannel, error) {
	h.preflights.Add(1)
	if h.beforeStart != nil {
		h.beforeStart()
	}
	return startWatchdogHelper(ctx, check, func() (watchdogProcess, watchdogChannel, error) {
		return h.start(selection, cwd)
	})
}

func (h *watchdogTestHost) start(selection WatchdogSelection, cwd string) (watchdogProcess, watchdogChannel, error) {
	if h.lease.inspecting.Load() || h.reservation.calls != 1 {
		panic("helper before reservation/outside owner gate")
	}
	if cwd != "/approved/work/project" {
		panic("cwd drift")
	}
	h.calls.Add(1)
	h.selection = selection
	client, peer := net.Pipe()
	h.peer = peer
	go func() {
		defer peer.Close()
		defer func() {
			if !h.holdWait {
				h.process.ended <- nil
			}
		}()
		reader := bufio.NewReader(peer)
		for {
			raw, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var message map[string]any
			if json.Unmarshal(raw, &message) != nil {
				return
			}
			h.frames <- message
			id := message["id"]
			var response any
			switch message["type"] {
			case "prepare":
				if h.beforePrepared != nil {
					h.beforePrepared()
				}
				if h.reply == "lost-prepared" {
					return
				}
				response = map[string]any{"type": "prepared", "id": id}
			case "start":
				h.starts.Add(1)
				if h.reply == "lost" {
					return
				}
				if h.reply == "malformed" {
					peer.Write([]byte("{\"type\":\"ready\",\"id\":false}\n"))
					return
				}
				response = map[string]any{"type": "ready", "id": id}
			case "stop":
				h.stops.Add(1)
				if h.beforeStop != nil {
					h.beforeStop()
				}
				if h.reply == "lost-stop" {
					return
				}
				if h.reply == "refused-stop" {
					response = map[string]any{"type": "signal-refused", "id": id}
					break
				}
				response = map[string]any{"type": "stop-requested", "id": id}
			default:
				return
			}
			raw, _ = json.Marshal(response)
			if _, err := peer.Write(append(raw, '\n')); err != nil {
				return
			}
		}
	}()
	if h.reply == "start-error" {
		return h.process, client, errors.New("synthetic possible helper start")
	}
	return h.process, client, nil
}

type watchdogFixture struct {
	preparer     *SupervisedPreparer
	route        *processcontract.Contract
	lease        *parentLease
	reservation  *parentReservation
	clock        *parentClock
	host         *watchdogTestHost
	evidence     *confinementEvidenceDouble
	timers       *timers
	measurements atomic.Int32
}

func newWatchdogFixture(t *testing.T) *watchdogFixture {
	t.Helper()
	_, selection, command, evidence := confinementFixture(t)
	clock := &parentClock{now: time.Now()}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7}, ParticipantID: "participant", TurnID: "turn"}
	selection.Snapshot.Participant.Grant.Identity = binding.Identity
	selection.Snapshot.Participant.Grant.ExpiresAt = clock.Now().Add(time.Hour)
	selection.Snapshot.Approval.ExpiresAt = clock.Now().Add(time.Hour)
	policy, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	command.Args = nil
	command.Input = nil
	command.Binding = nil
	lease := &parentLease{binding: binding, deadline: clock.Now().Add(15 * time.Second), snapshot: selection.Snapshot}
	reservation := &parentReservation{lease: lease}
	source := []byte("synthetic trusted watchdog source, NOT executed")
	digest := sha256.Sum256(source)
	wd := WatchdogSelection{Executable: ExecutablePin{"/selected/node", strings.Repeat("c", 64)}, Source: source, SourceSHA256: hex.EncodeToString(digest[:])}
	execution, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	preparer, err := NewSupervisedPreparer("cli", command, policy, wd, execution, clock)
	if err != nil {
		t.Fatal(err)
	}
	host := &watchdogTestHost{process: &watchdogTestProcess{ended: make(chan error, 1)}, frames: make(chan map[string]any, 8), reservation: reservation, lease: lease}
	f := &watchdogFixture{preparer: preparer, lease: lease, reservation: reservation, clock: clock, host: host, evidence: evidence, timers: &timers{}}
	preparer.boundary.host = host
	preparer.boundary.measure = func(_ context.Context, original Command, launch *confinedLaunch) (launchMeasurement, error) {
		if lease.inspecting.Load() || reservation.calls != 1 {
			panic("measurement before reservation/under owner gate")
		}
		if original.Executable == launch.command.Executable || launch.command.Executable != seatbeltExecutable {
			panic("unconfined launch")
		}
		f.measurements.Add(1)
		return &watchdogMeasurementDouble{}, nil
	}
	service, err := processsvc.NewForInvocation("operation", lease, preparer, reservation, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	f.route, err = processcontract.New(service)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if host.peer != nil {
			host.peer.Close()
		}
	})
	return f
}
func (f *watchdogFixture) prepare(t *testing.T) {
	t.Helper()
	out, err := f.route.Prepare(context.Background(), processcontract.PrepareRequest{OperationID: "operation", Invocation: parentInvocation()})
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	f.preparer.selected.schedule = f.timers.schedule
}
func (f *watchdogFixture) start(t *testing.T) *processcontract.StartResponse {
	t.Helper()
	out, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	return out
}
func (f *watchdogFixture) child() *Child {
	f.preparer.selected.mutex.Lock()
	defer f.preparer.selected.mutex.Unlock()
	return f.preparer.selected.retained
}
func (f *watchdogFixture) emit(t *testing.T, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.host.peer.Write(append(raw, '\n')); err != nil {
		t.Fatal(err)
	}
}
func (f *watchdogFixture) settle(t *testing.T) {
	t.Helper()
	f.host.peer.Close()
	select {
	case <-f.child().done:
	case <-time.After(time.Second):
		t.Fatal("CPU helper wait did not settle")
	}
	if f.host.process.waits.Load() != 1 {
		t.Fatal("helper Wait count")
	}
}
func TestWatchdogServiceRetainsUsefulForkingRootFactsWithoutTerminal(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	if f.host.calls.Load() != 0 || f.evidence.calls != 0 || f.reservation.calls != 0 {
		t.Fatal("preparation effects")
	}
	start := f.start(t)
	prepare, release := <-f.host.frames, <-f.host.frames
	if prepare["type"] != "prepare" || prepare["executable"] != seatbeltExecutable || prepare["deadlineAt"] != float64(f.lease.deadline.UnixMilli()) || release["type"] != "start" || f.evidence.calls != 2 {
		t.Fatal("launch/qualification/lease drift", prepare, release)
	}
	env := prepare["environment"].(map[string]any)
	if env["HOME"] == nil || env["NODE_OPTIONS"] != nil || f.host.selection.Executable.Path != "/selected/node" {
		t.Fatal("environment/image drift")
	}
	id := prepare["id"]
	f.emit(t, map[string]any{"type": "stdout", "id": id, "data": "QQ=="})
	f.emit(t, map[string]any{"type": "stderr", "id": id, "data": "RQ=="})
	f.emit(t, map[string]any{"type": "close", "id": id, "code": 7, "signal": nil})
	f.settle(t)
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || out.State != processcontract.Unknown || out.RootState != processcontract.RootExited || !out.RootWaited || !out.OutputDrained || out.ExitCode == nil || *out.ExitCode != 7 || out.StdoutBase64 != "QQ==" || out.StderrBase64 != "RQ==" || out.GroupCleanup != processcontract.CleanupUnverified || out.DescendantCleanup != processcontract.CleanupUnverified {
		t.Fatal(out, err)
	}
	if f.preparer.RetainedHandle() != start.Handle {
		t.Fatal("retained handle lost")
	}
	_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err == nil || f.host.calls.Load() != 1 || f.host.starts.Load() != 1 || f.reservation.calls != 1 {
		t.Fatal("unknown reissued")
	}
}
func TestWatchdogRefusesCurrentLossBeforeHelperAndBeforeRelease(t *testing.T) {
	for _, phase := range []string{"measure", "prepared", "expired"} {
		t.Run(phase, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.prepare(t)
			revoke := func() {
				f.lease.change(func(s *port.AccessSnapshot) { s.Participant.Grant.Commands = authority.NoCommands })
			}
			if phase == "measure" {
				original := f.preparer.boundary.measure
				f.preparer.boundary.measure = func(c context.Context, cmd Command, l *confinedLaunch) (launchMeasurement, error) {
					close, err := original(c, cmd, l)
					revoke()
					return close, err
				}
			}
			if phase == "prepared" {
				f.host.beforePrepared = revoke
			}
			if phase == "expired" {
				f.host.beforePrepared = func() { f.clock.advance(15 * time.Second) }
			}
			_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil || f.host.starts.Load() != 0 {
				t.Fatal("dispatch under stale authority", err)
			}
			if phase == "measure" && f.host.calls.Load() != 0 {
				t.Fatal("helper before current check")
			}
			if f.host.calls.Load() != 0 {
				f.settle(t)
				if f.preparer.RetainedHandle() == "" {
					t.Fatal("possible helper lost")
				}
			}
		})
	}
}

func TestWatchdogRefusesOwnerLossDuringHelperPreflight(t *testing.T) {
	for _, phase := range []string{"revoked", "expired", "response-cancelled"} {
		t.Run(phase, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.prepare(t)
			response, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.host.beforeStart = func() {
				switch phase {
				case "revoked":
					f.lease.change(func(s *port.AccessSnapshot) { s.Participant.Grant.Commands = authority.NoCommands })
				case "expired":
					f.clock.advance(15 * time.Second)
				case "response-cancelled":
					cancel()
				}
			}
			_, err := f.route.Start(response, processcontract.StartRequest{OperationID: "operation"})
			if f.host.calls.Load() != 0 {
				f.settle(t)
			}
			if err == nil || f.host.preflights.Load() != 1 || f.host.calls.Load() != 0 || f.host.starts.Load() != 0 || f.preparer.RetainedHandle() != "" {
				t.Fatal("helper launched after owner loss during preflight", err, f.host.calls.Load())
			}
			_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil || f.host.preflights.Load() != 1 || f.reservation.calls != 1 {
				t.Fatal("refused helper attempt repeated", err)
			}
		})
	}
}

func TestWatchdogFencePublishesUnknownBeforeHelperWait(t *testing.T) {
	for _, scenario := range []struct{ name, root, fault string }{
		{"running-lost-ipc", "", "disconnect"},
		{"running-malformed-ipc", "", "malformed"},
		{"running-signal-refused", "", "signal-refused"},
		{"running-output-limit", "", "output-limit"},
		{"exited-open-pipes", "exit", "signal-refused"},
		{"closed-root", "close", "signal-refused"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.host.holdWait = true
			f.host.process.waiting = make(chan struct{})
			f.prepare(t)
			start := f.start(t)
			child := f.child()
			child.mutex.Lock()
			watchdog := child.process.(*watchdogChild)
			child.mutex.Unlock()
			t.Cleanup(func() {
				f.host.peer.Close()
				f.host.process.ended <- nil
				select {
				case <-child.done:
				case <-time.After(time.Second):
					t.Error("released CPU helper Wait did not settle")
				}
			})
			select {
			case <-f.host.process.waiting:
			case <-time.After(time.Second):
				t.Fatal("CPU helper Wait did not start")
			}
			prepare := <-f.host.frames
			id := prepare["id"]
			f.emit(t, map[string]any{"type": "stdout", "id": id, "data": "QQ=="})
			f.emit(t, map[string]any{"type": "stderr", "id": id, "data": "RQ=="})
			if scenario.root != "" {
				f.emit(t, map[string]any{"type": scenario.root, "id": id, "code": 7, "signal": nil})
			}
			switch scenario.fault {
			case "disconnect":
				f.host.peer.Close()
			case "malformed":
				f.emit(t, map[string]any{"type": "stdout", "id": id, "data": "invalid"})
			default:
				f.emit(t, map[string]any{"type": scenario.fault, "id": id})
			}
			select {
			case <-watchdog.done:
			case <-time.After(time.Second):
				t.Fatal("CPU IPC did not fence")
			}
			select {
			case <-child.done:
				t.Fatal("IPC fence settled the unresolved helper Wait")
			default:
			}
			out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
			if err != nil || out.State != processcontract.Unknown || out.GroupCleanup != processcontract.CleanupUnverified || out.DescendantCleanup != processcontract.CleanupUnverified {
				t.Fatal("IPC uncertainty hidden behind helper Wait", out, err)
			}
			if out.StdoutBase64 != "QQ==" || out.StderrBase64 != "RQ==" || out.StdoutBytes != 1 || out.StderrBytes != 1 || out.OutputLimitReached != (scenario.fault == "output-limit") || out.OutputDrained != (scenario.root == "close") {
				t.Fatal("fence changed known output facts", out)
			}
			if scenario.root == "" {
				if out.RootState != processcontract.RootRunning || out.RootWaited || out.ExitCode != nil || out.ExitSignal != 0 {
					t.Fatal("fence fabricated root exit", out)
				}
			} else if out.RootState != processcontract.RootExited || !out.RootWaited || out.ExitCode == nil || *out.ExitCode != 7 || out.ExitSignal != 0 {
				t.Fatal("fence erased known root exit", out)
			}
			if _, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"}); err == nil {
				t.Fatal("fenced operation accepted Start")
			}
			for i := 0; i < 2; i++ {
				if scenario.root != "" {
					// Root exit is a no-effect observation while this unknown helper
					// remains held. Expiring that observation cannot signal it.
					ctx, cancel := context.WithCancel(context.Background())
					marked := &settlementContext{Context: ctx, waiting: make(chan struct{})}
					pending := settlementCancel(child, marked)
					settlementReceive(t, marked.waiting)
					cancel()
					result := settlementReceive(t, pending)
					var failure *processsvc.NativeFailure
					if !errors.As(result.err, &failure) || !failure.Unknown {
						t.Fatal("unresolved helper fabricated a cancellation ACK", result)
					}
				} else if _, err := f.route.Cancel(context.Background(), processcontract.CancelRequest{Handle: start.Handle}); err != nil {
					t.Fatal(err)
				}
			}
			if f.host.process.waits.Load() != 1 || f.host.calls.Load() != 1 || f.host.starts.Load() != 1 || f.host.stops.Load() != 0 || f.reservation.calls != 1 || f.preparer.RetainedHandle() != start.Handle {
				t.Fatal("fence replaced ownership or retried an effect")
			}
		})
	}
}

func TestWatchdogLostOrMalformedStartNeverResends(t *testing.T) {
	for _, reply := range []string{"lost", "malformed", "lost-prepared", "start-error"} {
		t.Run(reply, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.host.reply = reply
			f.prepare(t)
			_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil {
				t.Fatal("unknown accepted")
			}
			f.settle(t)
			_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			expected := int32(1)
			if reply == "lost-prepared" || reply == "start-error" {
				expected = 0
			}
			if err == nil || f.host.calls.Load() != 1 || f.host.starts.Load() != expected || f.preparer.RetainedHandle() == "" {
				t.Fatal("unknown replacement")
			}
		})
	}
}

func TestWatchdogLostOrRefusedStopFreezesWithoutReplacement(t *testing.T) {
	for _, reply := range []string{"lost-stop", "refused-stop"} {
		t.Run(reply, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.host.reply = reply
			f.prepare(t)
			start := f.start(t)
			for i := 0; i < 2; i++ {
				_, _ = f.route.Cancel(context.Background(), processcontract.CancelRequest{Handle: start.Handle})
			}
			f.settle(t)
			out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
			if err != nil || out.State != processcontract.Unknown || out.GroupCleanup != processcontract.CleanupUnverified || out.DescendantCleanup != processcontract.CleanupUnverified || f.host.stops.Load() != 1 || f.host.calls.Load() != 1 {
				t.Fatal("control uncertainty escaped", out, err)
			}
		})
	}
}

func TestWatchdogRootExitSurvivesOpenPipesAndLostChannel(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	start := f.start(t)
	prepare := <-f.host.frames
	id := prepare["id"]
	f.emit(t, map[string]any{"type": "exit", "id": id, "code": 0, "signal": nil})
	f.emit(t, map[string]any{"type": "stdout", "id": id, "data": "QQ=="})
	live, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || live.State != processcontract.Unknown || live.RootState != processcontract.RootExited || !live.RootWaited || live.OutputDrained {
		t.Fatal("root hidden behind helper/descendant Wait", live, err)
	}
	select {
	case <-f.child().done:
		t.Fatal("root exit settled retained helper")
	default:
	}
	ctx := &settlementContext{Context: context.Background(), waiting: make(chan struct{})}
	cancel := settlementCancel(f.child(), ctx)
	settlementReceive(t, ctx.waiting)
	f.settle(t) // No close observation: descendant pipes/helper are unknown.
	result := settlementReceive(t, cancel)
	if result.err != nil || result.receipt.Status != processsvc.AlreadyTerminal || f.host.stops.Load() != 0 {
		t.Fatal("exited root caused a new cleanup control", result)
	}
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || out.State != processcontract.Unknown || out.RootState != processcontract.RootExited || !out.RootWaited || out.OutputDrained || out.ExitCode == nil || *out.ExitCode != 0 || out.StdoutBase64 != "QQ==" {
		t.Fatal("root fact erased or false drain", out, err)
	}
}

func TestWatchdogOriginalResponseDoesNotOwnExecutionLifetime(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	response, cancel := context.WithCancel(context.Background())
	start, err := f.route.Start(response, processcontract.StartRequest{OperationID: "operation"})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	prepare := <-f.host.frames
	id := prepare["id"]
	f.emit(t, map[string]any{"type": "stdout", "id": id, "data": "QQ=="})
	f.emit(t, map[string]any{"type": "exit", "id": id, "code": 0, "signal": nil})
	f.emit(t, map[string]any{"type": "close", "id": id, "code": 0, "signal": nil})
	f.settle(t)
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || !out.RootWaited || out.StdoutBase64 != "QQ==" || f.host.stops.Load() != 0 {
		t.Fatal("outer response owned helper", out, err)
	}
}

func TestWatchdogOutputLimitRetainsTruthWithoutInventedBytes(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	start := f.start(t)
	prepare := <-f.host.frames
	f.emit(t, map[string]any{"type": "stdout", "id": prepare["id"], "data": "QQ=="})
	f.emit(t, map[string]any{"type": "output-limit", "id": prepare["id"]})
	f.settle(t)
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || out.State != processcontract.Unknown || !out.OutputLimitReached || out.OutputDrained || out.StdoutBase64 != "QQ==" || out.StdoutBytes != 1 {
		t.Fatal("output limit erased or synthetic bytes", out, err)
	}
}

type watchdogWriteFault struct {
	writes int
	closed bool
	short  bool
}

func (*watchdogWriteFault) Read([]byte) (int, error) { return 0, io.EOF }
func (c *watchdogWriteFault) Write(raw []byte) (int, error) {
	c.writes++
	if c.short {
		return len(raw) - 1, nil
	}
	return 0, errors.New("synthetic write backpressure")
}
func (c *watchdogWriteFault) Close() error                   { c.closed = true; return nil }
func (*watchdogWriteFault) SetReadDeadline(time.Time) error  { return nil }
func (*watchdogWriteFault) SetWriteDeadline(time.Time) error { return nil }

func TestWatchdogPartialOrBackpressuredReleaseConsumesAttempt(t *testing.T) {
	for _, short := range []bool{true, false} {
		c, _ := eventFixture()
		channel := &watchdogWriteFault{short: short}
		c.channel, c.startSent, c.readySeen = channel, false, false
		ctx, cancel := context.WithDeadline(context.Background(), c.deadline)
		defer cancel()
		for i := 0; i < 2; i++ {
			if c.send(ctx, watchdogControl{Type: "start", ID: c.id}) == nil {
				t.Fatal("write accepted")
			}
		}
		if channel.writes != 1 || !channel.closed || !c.uncertain {
			t.Fatal("release reissued")
		}
	}
}
func TestWatchdogQualificationAndMeasurementRemainMandatory(t *testing.T) {
	for _, phase := range []string{"measurement", "qualification"} {
		t.Run(phase, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.prepare(t)
			if phase == "measurement" {
				f.preparer.boundary.measure = func(context.Context, Command, *confinedLaunch) (launchMeasurement, error) {
					return nil, errors.New("synthetic refusal")
				}
			} else {
				f.evidence.err = errors.New("synthetic refusal")
			}
			_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil || f.host.calls.Load() != 0 {
				t.Fatal("qualification bypass")
			}
		})
	}
}
func TestWatchdogRetainsSameInvocationAndSealsHelper(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	first := f.preparer.selected
	same, err := f.preparer.Prepare(context.Background(), first.Invocation())
	if err != nil || same != first {
		t.Fatal("replaced selection")
	}
	changed := first.Invocation()
	changed.Input = []byte("changed")
	if _, err = f.preparer.Prepare(context.Background(), changed); err == nil {
		t.Fatal("input rebind")
	}
	if first.Seal().Digest == first.Prepared.Seal().Digest {
		t.Fatal("helper omitted from reservation seal")
	}
	invalid := first.Invocation()
	invalid.Arguments = []string{string([]byte{0xff})}
	if _, err := f.preparer.Prepare(context.Background(), invalid); err == nil {
		t.Fatal("lossy JSON command selection")
	}
	for _, change := range []func(*WatchdogSelection){func(s *WatchdogSelection) { s.Source[0] = 'X' }, func(s *WatchdogSelection) { s.Executable.SHA256 = "bad" }, func(s *WatchdogSelection) { s.Source = nil }} {
		selection := f.preparer.boundary.selection
		selection.Source = bytes.Clone(selection.Source)
		change(&selection)
		if _, err := NewSupervisedPreparer("cli", f.preparer.base.template, f.preparer.boundary.policy, selection, context.Background(), f.clock); err == nil {
			t.Fatal("unpinned helper")
		}
	}
	if _, err := NewSupervisedPreparer("cli", f.preparer.base.template, nil, f.preparer.boundary.selection, context.Background(), f.clock); err == nil {
		t.Fatal("nil Seatbelt")
	}
}
func TestWatchdogCancelConsumesSingleRetainedControl(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	start := f.start(t)
	for i := 0; i < 2; i++ {
		if _, err := f.route.Cancel(context.Background(), processcontract.CancelRequest{Handle: start.Handle}); err != nil {
			t.Fatal(err)
		}
	}
	if f.host.stops.Load() != 1 {
		t.Fatal("repeat stop")
	}
	f.settle(t)
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || out.State != processcontract.Unknown || out.RootWaited {
		t.Fatal("stop ACK promoted", out, err)
	}
}
func eventFixture() (*watchdogChild, *bytes.Buffer) {
	out := &bytes.Buffer{}
	c := newWatchdogChild(&watchdogTestProcess{ended: make(chan error, 1)}, nil, time.Now().Add(time.Minute), &parentClock{now: time.Now()}, out, io.Discard)
	c.id = strings.Repeat("a", 64)
	c.preparedSeen = true
	c.startSent = true
	c.readySeen = true
	return c, out
}
func TestWatchdogPrivateParserFreezesMalformedOversizeAndCrossedEvents(t *testing.T) {
	for _, raw := range []string{
		`{"type":"stdout","id":"wrong","data":"QQ=="}`,
		`{"type":"stdout","id":"` + strings.Repeat("a", 64) + `","data":"QQ==","data":"Qg=="}`,
		`{"type":"stdout","id":"` + strings.Repeat("a", 64) + `","data":"invalid"}`,
		`{"type":"close","id":"` + strings.Repeat("a", 64) + `","code":0,"signal":9}`,
		`{"type":"signal-refused","id":"` + strings.Repeat("a", 64) + `"}`,
		`{"type":"stdout","id":"` + strings.Repeat("a", 64) + `","data":"` + strings.Repeat("A", watchdogFrameLimit) + `"}`,
	} {
		t.Run(raw[:20], func(t *testing.T) {
			c, out := eventFixture()
			if c.event([]byte(raw)) == nil {
				t.Fatal("malformed accepted")
			}
			c.fence()
			valid := []byte(`{"type":"stdout","id":"` + c.id + `","data":"QQ=="}`)
			if c.event(valid) == nil || out.Len() != 0 {
				t.Fatal("fence corrected/replayed")
			}
		})
	}
	c, _ := eventFixture()
	c.bytes = processsvc.MaximumOutput
	if c.event([]byte(`{"type":"stdout","id":"`+c.id+`","data":"QQ=="}`)) == nil {
		t.Fatal("total output overflow")
	}
}
func TestWatchdogPreservesKnownRootWhenHelperWaitIsUnknown(t *testing.T) {
	c, _ := eventFixture()
	if err := c.event([]byte(`{"type":"close","id":"` + c.id + `","code":0,"signal":null}`)); err != nil {
		t.Fatal(err)
	}
	c.process.(*watchdogTestProcess).ended <- errors.New("unknown helper Wait")
	out, err := c.Wait()
	if err != nil || !out.Waited || out.Code == nil || *out.Code != 0 || !out.Drained || out.cohort {
		t.Fatal("root erased or cleanup forged", out, err)
	}
	if _, err = c.Wait(); err == nil {
		t.Fatal("repeat Wait")
	}
}

// CPU measurement ownership only; no physical or enforcement evidence.
type watchdogMeasurementDouble struct {
	recheck func(context.Context) error
	closes  int
}

func (m *watchdogMeasurementDouble) Recheck(ctx context.Context) error {
	if m.recheck != nil {
		return m.recheck(ctx)
	}
	return ctx.Err()
}
func (m *watchdogMeasurementDouble) Close() { m.closes++ }
