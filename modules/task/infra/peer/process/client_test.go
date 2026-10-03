package process

// The shipping mapper runs against independent public-contract DTO scripts.
// No native process, private Computer import, root binding or model is used.
import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"

	computer "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type contractFixture struct {
	prepares, starts, reads, cancels        int
	request                                 computer.PrepareRequest
	prepareError, startError, cancelError   error
	response                                computer.ReadResponse
	wrongPrepare, wrongHandle, panicPrepare bool
	cancelStatus                            computer.CancelStatus
}

func (f *contractFixture) Prepare(_ context.Context, q computer.PrepareRequest) (*computer.PrepareResponse, error) {
	f.prepares++
	f.request = q
	if f.panicPrepare {
		panic("fixture boundary panic")
	}
	if f.prepareError != nil {
		return nil, f.prepareError
	}
	// Independent exact request oracle; unexpected args/stdin fail before Start.
	if q.OperationID != "operation" || q.Invocation.RuntimeID != "runtime" || q.Invocation.SessionID != "session" || q.Invocation.ModelID != "model-a" || q.Invocation.AdmissionID != "authority-correlation" || !reflect.DeepEqual(q.Invocation.Arguments, []string{"--print", "--model", "model-a"}) || string(q.Invocation.Input) != "fixture prompt\n" {
		return nil, &computer.Failure{Code: "PROCESS_INVOCATION_REFUSED", Outcome: "refused", Retry: "never"}
	}
	result := &computer.PrepareResponse{OperationID: q.OperationID, RuntimeID: q.Invocation.RuntimeID, SessionID: q.Invocation.SessionID, ModelID: q.Invocation.ModelID, AdmissionID: q.Invocation.AdmissionID, Digest: strings.Repeat("a", 64)}
	if f.wrongPrepare {
		result.ModelID = "model-b"
	}
	return result, nil
}
func (f *contractFixture) Start(_ context.Context, q computer.StartRequest) (*computer.StartResponse, error) {
	f.starts++
	if q.OperationID != "operation" {
		return nil, errors.New("foreign operation")
	}
	if f.startError != nil {
		return nil, f.startError
	}
	handle := "owned-handle"
	if f.wrongHandle {
		handle = ""
	}
	return &computer.StartResponse{OperationID: q.OperationID, Handle: handle}, nil
}
func (f *contractFixture) Read(_ context.Context, q computer.ReadRequest) (*computer.ReadResponse, error) {
	f.reads++
	if q.Handle != "owned-handle" {
		return nil, errors.New("foreign handle")
	}
	out := f.response
	return &out, nil
}
func (f *contractFixture) Cancel(_ context.Context, q computer.CancelRequest) (*computer.CancelResponse, error) {
	f.cancels++
	if q.Handle != "owned-handle" {
		return nil, errors.New("foreign handle")
	}
	if f.cancelError != nil {
		return nil, f.cancelError
	}
	return &computer.CancelResponse{Status: f.cancelStatus}, nil
}
func peerFixture() (*Client, *contractFixture, port.ClaudeInvocation) {
	f := &contractFixture{cancelStatus: computer.CancelRequested, response: computer.ReadResponse{Handle: "owned-handle", State: computer.Running, RootState: computer.RootRunning, GroupCleanup: computer.CleanupPending, DescendantCleanup: computer.CleanupPending}}
	c := &Client{contract: f, selected: Selection{"operation", "runtime", "session", "model-a", "authority-correlation"}}
	q := port.ClaudeInvocation{OperationID: "operation", RuntimeID: "runtime", SessionID: "session", ModelID: "model-a", AdmissionID: "authority-correlation", Arguments: []string{"--print", "--model", "model-a"}, Input: []byte("fixture prompt\n")}
	return c, f, q
}
func TestExactPublishedInvocationMappingAndLocalFence(t *testing.T) {
	c, f, q := peerFixture()
	r, err := c.Prepare(context.Background(), q)
	if err != nil || r.ModelID != "model-a" {
		t.Fatal(r, err)
	}
	original := q
	q.Arguments[0] = "--bare"
	q.Input[0] = 'X'
	if f.request.Invocation.Arguments[0] != "--print" || string(f.request.Invocation.Input) != "fixture prompt\n" {
		t.Fatal("contract input aliases caller")
	}
	if _, err := c.Prepare(context.Background(), q); !errors.Is(err, task.ErrConflict) || f.prepares != 1 {
		t.Fatal("payload rebound", err)
	}
	original.Arguments = []string{"--print", "--model", "model-a"}
	original.Input = []byte("fixture prompt\n")
	if again, err := c.Prepare(context.Background(), original); err != nil || again != r || f.prepares != 1 {
		t.Fatal("known prepare reconstructed", again, err)
	}
	h, err := c.Start(context.Background(), "operation")
	if err != nil || h != "owned-handle" {
		t.Fatal(h, err)
	}
	if _, err := c.Start(context.Background(), "operation"); err != nil || f.starts != 1 {
		t.Fatal("start repeated", err)
	}
	if _, err := c.Cancel(context.Background(), "other"); !errors.Is(err, task.ErrIdentity) || f.cancels != 0 {
		t.Fatal("foreign child targeted", err)
	}
	cancel, err := c.Cancel(context.Background(), h)
	if err != nil || cancel.Status != "requested" {
		t.Fatal(cancel, err)
	}
	if _, err := c.Cancel(context.Background(), h); err != nil || f.cancels != 1 {
		t.Fatal("signal repeated", err)
	}
	out, err := c.Read(context.Background(), port.ClaudeRead{Handle: h})
	if err != nil || out.State != "running" {
		t.Fatal("cancel ack became terminal", out, err)
	}
}
func TestUnknownRefusedAndMalformedPrepareOrStartNeverRetry(t *testing.T) {
	for _, mode := range []string{"prepare-unknown", "prepare-refused", "prepare-crossed", "prepare-panic", "start-unknown", "start-refused", "start-malformed"} {
		t.Run(mode, func(t *testing.T) {
			c, f, q := peerFixture()
			failure := &computer.Failure{Code: "PROCESS_FIXTURE_UNKNOWN", Outcome: "outcome_unknown", Retry: "never"}
			switch mode {
			case "prepare-unknown":
				f.prepareError = failure
			case "prepare-refused":
				f.prepareError = &computer.Failure{Code: "PROCESS_REFUSED", Outcome: "refused", Retry: "never"}
			case "prepare-crossed":
				f.wrongPrepare = true
			case "prepare-panic":
				f.panicPrepare = true
			case "start-unknown":
				f.startError = failure
			case "start-refused":
				f.startError = &computer.Failure{Code: "PROCESS_REFUSED", Outcome: "refused", Retry: "never"}
			case "start-malformed":
				f.wrongHandle = true
			}
			c.Prepare(context.Background(), q)
			c.Prepare(context.Background(), q)
			_, err := c.Start(context.Background(), "operation")
			if err == nil {
				t.Fatal("unknown/refusal accepted")
			}
			c.Start(context.Background(), "operation")
			if f.prepares != 1 || f.starts > 1 {
				t.Fatal("boundary repeated", f)
			}
			if _, err := c.Start(context.Background(), "new-operation"); !errors.Is(err, task.ErrIdentity) || f.starts > 1 {
				t.Fatal("new key escaped selected operation", err)
			}
		})
	}
}
func TestReadRequiresExactOffsetAndConfirmedTerminalFacts(t *testing.T) {
	for _, mode := range []string{"running", "native-unverified", "false-terminal", "cross-handle", "cross-offset", "bad-base64", "partial-offset", "drain-missing", "confirmed-fixture"} {
		t.Run(mode, func(t *testing.T) {
			c, f, q := peerFixture()
			c.Prepare(context.Background(), q)
			h, _ := c.Start(context.Background(), "operation")
			r := &f.response
			r.StdoutBase64 = base64.StdEncoding.EncodeToString([]byte("chunk"))
			r.StdoutBytes = 5
			r.StdoutNext = 5
			bad := false
			switch mode {
			case "native-unverified":
				r.State = computer.Unknown
				r.RootState = computer.RootExited
				r.RootWaited = true
				r.OutputDrained = true
				r.GroupCleanup = computer.CleanupUnverified
				r.DescendantCleanup = computer.CleanupUnverified
			case "false-terminal":
				r.State = computer.Terminal
				bad = true
			case "cross-handle":
				r.Handle = "other"
				bad = true
			case "cross-offset":
				r.StdoutOffset = 1
				bad = true
			case "bad-base64":
				r.StdoutBase64 = "!!!"
				bad = true
			case "partial-offset":
				r.StdoutNext = 4
				bad = true
			case "drain-missing", "confirmed-fixture":
				r.State = computer.Terminal
				r.RootState = computer.RootExited
				r.RootWaited = true
				r.GroupCleanup = computer.CleanupConfirmed
				r.DescendantCleanup = computer.CleanupConfirmed
				r.OutputDrained = mode == "confirmed-fixture"
				bad = mode == "drain-missing"
			}
			out, err := c.Read(context.Background(), port.ClaudeRead{Handle: h})
			if bad {
				if err == nil {
					t.Fatal("malformed observation accepted", out)
				}
				return
			}
			if err != nil || string(out.Stdout) != "chunk" {
				t.Fatal(out, err)
			}
			if mode == "native-unverified" && out.State != "unknown" {
				t.Fatal("clean root exit became terminal", out)
			}
			if f.starts != 1 || f.prepares != 1 {
				t.Fatal("read prepared/restarted process")
			}
		})
	}
}
func TestCancellationUnknownNeverSignalsAgain(t *testing.T) {
	c, f, q := peerFixture()
	c.Prepare(context.Background(), q)
	h, _ := c.Start(context.Background(), "operation")
	f.cancelStatus = computer.CancelUnknown
	for n := 0; n < 2; n++ {
		if _, err := c.Cancel(context.Background(), h); err == nil {
			t.Fatal("unknown signal accepted")
		}
	}
	if f.cancels != 1 {
		t.Fatal("signal retried")
	}
	if _, err := New(nil, Selection{}); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestUnpreparedAndForeignInvocationStartNoBoundaryAndErrorClassStaysUnknown(t *testing.T) {
	c, f, q := peerFixture()
	if _, err := c.Start(context.Background(), "operation"); !errors.Is(err, task.ErrState) || f.starts != 0 {
		t.Fatal("unprepared start reached boundary", err)
	}
	q.AdmissionID = "foreign"
	if _, err := c.Prepare(context.Background(), q); !errors.Is(err, task.ErrIdentity) || f.prepares != 0 {
		t.Fatal("foreign correlation reached boundary", err)
	}
	c, f, q = peerFixture()
	f.startError = &computer.Failure{Code: "PROCESS_FIXTURE_UNKNOWN", Outcome: "outcome_unknown", Retry: "never"}
	c.Prepare(context.Background(), q)
	if _, err := c.Start(context.Background(), "operation"); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	if _, err := c.Read(context.Background(), port.ClaudeRead{Handle: "owned-handle"}); !errors.Is(err, task.ErrUnknown) || f.reads != 0 {
		t.Fatal("unknown start read guessed child", err)
	}
	if _, err := c.Cancel(context.Background(), "owned-handle"); !errors.Is(err, task.ErrUnknown) || f.cancels != 0 {
		t.Fatal("unknown start cancellation guessed child", err)
	}
}
