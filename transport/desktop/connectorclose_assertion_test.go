package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// Test-only closure assertion shared with the Darwin fixture. Controlled
// readers below qualify framing/assertion logic, not native socket lifetime.
func connectorCloseProof(reader io.Reader, canceled *wire.Request) error {
	observed := &connectorProofCountingReader{reader: reader}
	frame, err := ipc.ReadFrame(observed)
	if errors.Is(err, io.EOF) || errors.Is(err, syscall.ECONNRESET) {
		if observed.read != 0 {
			return errors.New("partial frame before stream termination")
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("stream did not terminate with EOF/reset: %w", err)
	}
	if canceled == nil || canceled.Params.Context == nil {
		return errors.New("unexpected frame before stream termination")
	}
	if err := ipc.ValidateJSON(frame); err != nil {
		return fmt.Errorf("ambiguous cancellation response: %w", err)
	}
	if err := wire.Validate("Response", frame); err != nil {
		return fmt.Errorf("invalid cancellation response: %w", err)
	}
	var response wire.Response
	if err := json.Unmarshal(frame, &response); err != nil {
		return err
	}
	result := response.Result
	if response.Jsonrpc != "2.0" || response.Error != nil || response.Id == nil || *response.Id != canceled.Id ||
		result == nil || result.RequestId != canceled.Id || result.Context != *canceled.Params.Context ||
		result.Status != "unknown" || result.Code == nil || *result.Code != "owner_outcome_unknown" || len(result.Data) != 0 {
		return errors.New("crossed or nonterminal cancellation response")
	}
	if (result.OperationId == nil) != (canceled.Params.OperationId == nil) ||
		(result.OperationId != nil && *result.OperationId != *canceled.Params.OperationId) {
		return errors.New("crossed cancellation operation identity")
	}
	// Only one exact original owner response is permitted. A second complete or
	// partial frame, timeout or other error is not confirmed stream termination.
	observed.read = 0
	_, err = ipc.ReadFrame(observed)
	if observed.read != 0 || (!errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET)) {
		return fmt.Errorf("stream did not terminate after cancellation with EOF/reset: %v", err)
	}
	return nil
}

type connectorProofCountingReader struct {
	reader io.Reader
	read   int
}

func (r *connectorProofCountingReader) Read(buffer []byte) (int, error) {
	n, err := r.reader.Read(buffer)
	r.read += n
	return n, err
}

type connectorProofReader struct {
	*bytes.Reader
	end error
}

func (r connectorProofReader) Read(buffer []byte) (int, error) {
	n, err := r.Reader.Read(buffer)
	if errors.Is(err, io.EOF) {
		return n, r.end
	}
	return n, err
}

func connectorProofRequest() wire.Request {
	return wire.Request{Jsonrpc: "2.0", Id: "active", Method: "computer.workspace.list", Params: wire.Call{
		Context: &wire.Context{ProfileId: "test", BackendGeneration: "generation"}, Body: json.RawMessage(`{}`),
	}}
}

func connectorProofResponse(request wire.Request) wire.Response {
	return (&Server{config: Config{ProfileID: request.Params.Context.ProfileId, Generation: request.Params.Context.BackendGeneration}}).
		result(request, &Outcome{Status: "unknown", Code: "owner_outcome_unknown"})
}

func connectorProofFrames(t *testing.T, frames ...[]byte) []byte {
	t.Helper()
	var packet bytes.Buffer
	for _, frame := range frames {
		if err := ipc.WriteFrame(&packet, frame); err != nil {
			t.Fatal(err)
		}
	}
	return packet.Bytes()
}

func connectorProofJSON(t *testing.T, response wire.Response) []byte {
	t.Helper()
	frame, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestConnectorCloseProofExactCancellation(t *testing.T) {
	request := connectorProofRequest()
	frame := connectorProofJSON(t, connectorProofResponse(request))
	for _, end := range []error{io.EOF, syscall.ECONNRESET} {
		for _, buffered := range []bool{false, true} {
			t.Run(fmt.Sprintf("%v/frame=%v", end, buffered), func(t *testing.T) {
				var packet []byte
				if buffered {
					packet = connectorProofFrames(t, frame)
				}
				if err := connectorCloseProof(connectorProofReader{bytes.NewReader(packet), end}, &request); err != nil {
					t.Fatal("exact original cancellation and stream termination refused:", err)
				}
			})
		}
	}
	request.Params.OperationId = optional("original-operation")
	frame = connectorProofJSON(t, connectorProofResponse(request))
	if err := connectorCloseProof(bytes.NewReader(connectorProofFrames(t, frame)), &request); err != nil {
		t.Fatal("original operation identity refused:", err)
	}
}

func TestConnectorCloseProofUsesCurrentCanceledOwnerResult(t *testing.T) {
	entered, returned := make(chan struct{}), make(chan struct{})
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{
		"computer.workspace.list": {Handle: func(ctx context.Context, _ Request) (*Outcome, error) {
			close(entered)
			<-ctx.Done()
			close(returned)
			return nil, ctx.Err()
		}},
	}})
	if err != nil || handshake(s).Result == nil {
		t.Fatal("controlled owner fixture was not admitted", err)
	}
	request := connectorProofRequest()
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	_, call := s.prepareDispatch(raw)
	if call == nil {
		t.Fatal("original owner-active request was not admitted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	response := make(chan wire.Response, 1)
	go func() { response <- s.invoke(ctx, call) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("controlled owner did not enter")
	}
	cancel()
	var result wire.Response
	select {
	case result = <-response:
	case <-time.After(time.Second):
		t.Fatal("original canceled owner did not settle")
	}
	select {
	case <-returned:
	default:
		t.Fatal("response preceded owner settlement")
	}
	frame, err := responseJSON(result)
	if err != nil {
		t.Fatal("current owner terminal response failed its real encoder:", err)
	}
	if err := connectorCloseProof(bytes.NewReader(connectorProofFrames(t, frame)), &request); err != nil {
		t.Fatal("buffered current owner cancellation before EOF refused:", err)
	}
}

func TestConnectorCloseProofRejectsCrossedOrNonterminalFrames(t *testing.T) {
	request := connectorProofRequest()
	for _, test := range []struct {
		name   string
		change func(*wire.Response)
	}{
		{"envelope-id", func(r *wire.Response) { r.Id = optional("other") }},
		{"missing-envelope-id", func(r *wire.Response) { r.Id = nil }},
		{"request-id", func(r *wire.Response) { r.Result.RequestId = "other" }},
		{"profile", func(r *wire.Response) { r.Result.Context.ProfileId = "other" }},
		{"generation", func(r *wire.Response) { r.Result.Context.BackendGeneration = "other" }},
		{"unexpected-operation", func(r *wire.Response) { r.Result.OperationId = optional("other") }},
		{"status", func(r *wire.Response) { r.Result.Status = "ok" }},
		{"refused", func(r *wire.Response) { r.Result.Status = "refused" }},
		{"code", func(r *wire.Response) { r.Result.Code = optional("owner_output_invalid") }},
		{"missing-code", func(r *wire.Response) { r.Result.Code = nil }},
		{"data", func(r *wire.Response) { r.Result.Data = json.RawMessage(`{}`) }},
		{"null-data", func(r *wire.Response) { r.Result.Data = json.RawMessage(`null`) }},
		{"error-and-result", func(r *wire.Response) { r.Error = &wire.Fault{Code: -32000, Message: "unexpected"} }},
		{"fault-only", func(r *wire.Response) { r.Result = nil; r.Error = &wire.Fault{Code: -32000, Message: "refused"} }},
		{"jsonrpc", func(r *wire.Response) { r.Jsonrpc = "1.0" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := connectorProofResponse(request)
			test.change(&response)
			if connectorCloseProof(bytes.NewReader(connectorProofFrames(t, connectorProofJSON(t, response))), &request) == nil {
				t.Fatal("crossed/nonterminal response accepted")
			}
		})
	}
	withOperation := request
	withOperation.Params.OperationId = optional("original-operation")
	for _, operation := range []*string{nil, optional("other-operation")} {
		response := connectorProofResponse(withOperation)
		response.Result.OperationId = operation
		if connectorCloseProof(bytes.NewReader(connectorProofFrames(t, connectorProofJSON(t, response))), &withOperation) == nil {
			t.Fatal("crossed/missing original operation accepted")
		}
	}
	valid := connectorProofJSON(t, connectorProofResponse(request))
	for _, malformed := range [][]byte{
		[]byte(`{`),
		[]byte(strings.Replace(string(valid), `"jsonrpc":"2.0"`, `"jsonrpc":"2.0","extra":true`, 1)),
		[]byte(strings.Replace(string(valid), `"requestId":"active"`, `"requestId":"other","requestId":"active"`, 1)),
		append(append([]byte{}, valid...), []byte(` {}`)...),
	} {
		if connectorCloseProof(bytes.NewReader(connectorProofFrames(t, malformed)), &request) == nil {
			t.Fatal("malformed, extra-key or ambiguous response accepted")
		}
	}
}

func TestConnectorCloseProofRequiresExactTermination(t *testing.T) {
	request := connectorProofRequest()
	valid := connectorProofJSON(t, connectorProofResponse(request))
	for _, packet := range [][]byte{
		connectorProofFrames(t, valid, valid),
		connectorProofFrames(t, valid, []byte(`{"jsonrpc":"2.0","id":"other","error":{"code":-32000,"message":"refused"}}`)),
		append(connectorProofFrames(t, valid), 0, 0),
		append(connectorProofFrames(t, valid), 0, 0, 0, 2, '{'),
		{0, 0},
		{0, 0, 0, 2, '{'},
		{0, 0, 0, 0},
	} {
		if connectorCloseProof(bytes.NewReader(packet), &request) == nil {
			t.Fatal("extra frame or incomplete stream accepted")
		}
	}
	for _, packet := range [][]byte{nil, connectorProofFrames(t, valid)} {
		if connectorCloseProof(connectorProofReader{bytes.NewReader(packet), os.ErrDeadlineExceeded}, &request) == nil {
			t.Fatal("timeout was misreported as stream termination")
		}
	}
}

func TestConnectorCloseProofKeepsRefusedStreamsStrict(t *testing.T) {
	request := connectorProofRequest()
	for _, end := range []error{io.EOF, syscall.ECONNRESET} {
		if err := connectorCloseProof(connectorProofReader{bytes.NewReader(nil), end}, nil); err != nil {
			t.Fatal("strict empty stream termination refused", err)
		}
	}
	for _, response := range []wire.Response{
		connectorProofResponse(request),
		fault(request.Id, -32001, "unauthenticated"),
	} {
		if connectorCloseProof(bytes.NewReader(connectorProofFrames(t, connectorProofJSON(t, response))), nil) == nil {
			t.Fatal("unauthenticated/refused stream frame accepted")
		}
	}
}

func TestConnectorCloseProofRejectsPartialReset(t *testing.T) {
	request := connectorProofRequest()
	valid := connectorProofJSON(t, connectorProofResponse(request))
	for _, first := range []bool{false, true} {
		for _, partial := range [][]byte{{0, 0}, {0, 0, 0, 2, '{'}} {
			var packet []byte
			if first {
				packet = connectorProofFrames(t, valid)
			}
			packet = append(packet, partial...)
			if connectorCloseProof(connectorProofReader{bytes.NewReader(packet), syscall.ECONNRESET}, &request) == nil {
				t.Errorf("partial response followed by reset accepted (first=%v, partial=%v)", first, partial)
			}
		}
	}
}
