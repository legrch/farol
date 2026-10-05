package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// Request belongs to this adapter. Module adapters map it to independent contracts.
type Request struct {
	RequestID   string
	OperationID string
	Body        json.RawMessage
}
type Outcome struct {
	Status string
	Code   string
	Data   json.RawMessage
}
type Method struct {
	// Trusted boot opts in only for handlers that await a reciprocal desktop
	// capability. All existing owners remain serialized by default.
	Concurrent bool
	Handle     func(context.Context, Request) (*Outcome, error)
	// AfterReply is a trusted, nonblocking local delivery notification. True
	// means an OK frame was completely written, not received/acknowledged by
	// the peer or retained durably. It is never called for an uninvoked handler.
	AfterReply func(Request, bool)
}
type Config struct {
	BuildID    string
	ProfileID  string
	Generation string
	Methods    map[string]Method
	// TerminalRejection is selected only for one-shot inherited role channels.
	// A rejected request closes that channel after its response; ordinary desktop
	// and connector servers keep their existing false/default behavior.
	TerminalRejection bool
}
type Server struct {
	config    Config
	started   time.Time
	connected bool
	seen      map[string]bool
}

func New(config Config) (*Server, error) {
	identity := wire.Identity{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: config.BuildID, ProfileId: config.ProfileID, BackendGeneration: config.Generation, Capabilities: []string{"core.status"}, MaxFrameBytes: ipc.MaxFrameBytes}
	if err := validate("Identity", identity); err != nil {
		return nil, err
	}
	methods := make(map[string]Method, len(config.Methods))
	for name, method := range config.Methods {
		if !wire.KnownMethod(name) || name == "core.handshake" || name == "core.status" || name == "core.operation.status" || method.Handle == nil {
			return nil, errors.New("invalid method registration")
		}
		methods[name] = method
	}
	config.Methods = methods
	return &Server{config: config, started: time.Now(), seen: make(map[string]bool)}, nil
}

// Serve owns the supplied pipe endpoints for its lifetime. Cancellation closes
// those exact endpoints to interrupt blocked IO and propagates to the handler;
// it does not establish cancellation of module-owned OS/provider work.
func (s *Server) Serve(parent context.Context, in io.ReadCloser, out io.WriteCloser) (result error) {
	ctx, cancel := context.WithCancel(parent)
	var closed sync.Once
	closePipes := func() { closed.Do(func() { _ = in.Close(); _ = out.Close() }) }
	var workers sync.WaitGroup
	var output sync.Mutex
	var outputErr error
	// Bound outstanding reciprocal calls without blocking the reader that must
	// accept their completion. Saturation refuses before invoking any owner.
	pending := make(chan struct{}, 32)
	stop := make(chan struct{})
	terminal := make(chan struct{})
	go func() {
		defer close(terminal)
		select {
		case <-ctx.Done():
			closePipes()
		case <-stop:
		}
	}()
	defer func() {
		cancel()
		closePipes()
		workers.Wait()
		close(stop)
		<-terminal
		result = errors.Join(result, outputErr)
	}()
	write := func(response wire.Response) error {
		output.Lock()
		defer output.Unlock()
		if outputErr != nil {
			return outputErr
		}
		response = boundResponse(response)
		encoded, err := responseJSON(response)
		if err != nil && response.Result != nil {
			response.Result.Status = "unknown"
			response.Result.Code = optional("owner_output_invalid")
			response.Result.Data = nil
			encoded, err = responseJSON(response)
		}
		if err == nil {
			err = ipc.WriteFrame(out, encoded)
		}
		if err != nil {
			outputErr = fmt.Errorf("response delivery unknown: %w", err)
			cancel()
		}
		return outputErr
	}
	invokeAndWrite := func(call *invocation) error {
		response := s.invoke(ctx, call)
		err := write(response)
		if call.method.AfterReply != nil {
			operation := ""
			if call.request.Params.OperationId != nil {
				operation = *call.request.Params.OperationId
			}
			call.method.AfterReply(Request{RequestID: call.request.Id, OperationID: operation, Body: call.request.Params.Body}, err == nil && response.Result != nil && response.Result.Status == "ok")
		}
		if err == nil && s.config.TerminalRejection && (response.Error != nil || response.Result == nil || response.Result.Status != "ok") {
			cancel()
			return errors.New("role request rejected")
		}
		return err
	}
	for attempt := 0; attempt < 4096; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		data, err := ipc.ReadFrame(in)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("protocol frame: %w", err)
		}
		response, call := s.prepareDispatch(data)
		if call != nil && call.method.Concurrent {
			select {
			case pending <- struct{}{}:
				workers.Add(1)
				go func() {
					defer workers.Done()
					defer func() { <-pending }()
					_ = invokeAndWrite(call)
				}()
				continue
			default:
				response = s.result(call.request, &Outcome{Status: "unavailable", Code: "handler_backpressure"})
			}
		} else if call != nil {
			if err := invokeAndWrite(call); err != nil {
				return err
			}
			continue
		}
		if err := write(response); err != nil {
			return err
		}
		if s.config.TerminalRejection && (response.Error != nil || response.Result == nil || response.Result.Status != "ok") {
			return errors.New("role request rejected")
		}
	}
	return errors.New("request attempt budget exhausted")
}

type invocation struct {
	request wire.Request
	method  Method
}

func (s *Server) dispatch(ctx context.Context, data []byte) wire.Response {
	response, call := s.prepareDispatch(data)
	if call != nil {
		return s.invoke(ctx, call)
	}
	return response
}

// Called only by the pipe reader. Handshake, request deduplication and all
// boundary validation finish before a handler may run concurrently.
func (s *Server) prepareDispatch(data []byte) (wire.Response, *invocation) {
	if err := ipc.ValidateJSON(data); err != nil {
		return fault("", -32700, "invalid JSON"), nil
	}
	if err := wire.Validate("Request", data); err != nil {
		return fault("", -32600, "invalid request"), nil
	}
	var req wire.Request
	if err := json.Unmarshal(data, &req); err != nil {
		return fault("", -32600, "invalid request"), nil
	}
	if s.seen[req.Id] {
		return fault(req.Id, -32600, "duplicate request ID"), nil
	}
	if len(s.seen) >= 4096 {
		return fault(req.Id, -32000, "request budget exhausted"), nil
	}
	s.seen[req.Id] = true
	if req.Method == "core.handshake" {
		return s.handshake(req), nil
	}
	if !s.connected {
		return fault(req.Id, -32001, "handshake required"), nil
	}
	expected := s.context()
	if req.Params.Context == nil || *req.Params.Context != expected {
		return fault(req.Id, -32002, "stale backend context"), nil
	}
	if !wire.KnownMethod(req.Method) {
		return fault(req.Id, -32601, "unknown method"), nil
	}
	if wire.RequiresOperationID(req.Method) != (req.Params.OperationId != nil) {
		return fault(req.Id, -32602, "invalid operation identity"), nil
	}
	if req.Method == "core.status" {
		if req.Params.OperationId != nil || wire.Validate("Empty", req.Params.Body) != nil {
			return fault(req.Id, -32602, "invalid status parameters"), nil
		}
		data, _ := json.Marshal(wire.Status{Pid: strconv.Itoa(os.Getpid()), StartedAt: s.started.UTC().Format(time.RFC3339Nano), UptimeNanoseconds: strconv.FormatInt(time.Since(s.started).Nanoseconds(), 10), BuildId: s.config.BuildID, ProfileId: s.config.ProfileID, BackendGeneration: s.config.Generation})
		return s.result(req, &Outcome{Status: "ok", Data: data}), nil
	}
	if req.Method == "core.operation.status" {
		return s.result(req, &Outcome{Status: "unsupported", Code: "operation_owner_unavailable"}), nil
	}
	method, exists := s.config.Methods[req.Method]
	if !exists {
		return s.result(req, &Outcome{Status: "unavailable", Code: "capability_unavailable"}), nil
	}
	return wire.Response{}, &invocation{request: req, method: method}
}

func (s *Server) invoke(ctx context.Context, call *invocation) wire.Response {
	req := call.request

	operationID := ""
	if req.Params.OperationId != nil {
		operationID = *req.Params.OperationId
	}
	outcome, err := call.method.Handle(ctx, Request{RequestID: req.Id, OperationID: operationID, Body: req.Params.Body})
	// Only the owner can establish the effect result. A handler failure is unknown.
	if err != nil || outcome == nil {
		return s.result(req, &Outcome{Status: "unknown", Code: "owner_outcome_unknown"})
	}
	return s.result(req, outcome)
}

func (s *Server) handshake(req wire.Request) wire.Response {
	if s.connected || req.Params.Context != nil || req.Params.OperationId != nil {
		return fault(req.Id, -32001, "invalid handshake lifecycle")
	}
	if err := wire.Validate("Handshake", req.Params.Body); err != nil {
		return fault(req.Id, -32602, "invalid handshake")
	}
	var hello wire.Handshake
	if err := json.Unmarshal(req.Params.Body, &hello); err != nil {
		return fault(req.Id, -32602, "invalid handshake")
	}
	if hello.ProtocolMajor != wire.ProtocolMajor || hello.ProtocolMinor > wire.ProtocolMinor || hello.BuildId != s.config.BuildID || hello.ProfileId != s.config.ProfileID {
		return fault(req.Id, -32003, "incompatible backend identity")
	}
	caps := []string{"core.status"}
	// Stable capability order is part of deterministic handshake generation.
	for _, name := range wire.MethodNames() {
		if _, ok := s.config.Methods[name]; ok {
			caps = append(caps, name)
		}
	}
	identity := wire.Identity{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: s.config.BuildID, ProfileId: s.config.ProfileID, BackendGeneration: s.config.Generation, Capabilities: caps, MaxFrameBytes: ipc.MaxFrameBytes}
	data, _ := json.Marshal(identity)
	s.connected = true
	return s.result(req, &Outcome{Status: "ok", Data: data})
}
func (s *Server) context() wire.Context {
	return wire.Context{ProfileId: s.config.ProfileID, BackendGeneration: s.config.Generation}
}
func (s *Server) result(req wire.Request, outcome *Outcome) wire.Response {
	return wire.Response{Jsonrpc: "2.0", Id: &req.Id, Result: &wire.Outcome{Status: outcome.Status, RequestId: req.Id, Context: s.context(), OperationId: req.Params.OperationId, Data: outcome.Data, Code: optional(outcome.Code)}}
}
func fault(id string, code int32, message string) wire.Response {
	return wire.Response{Jsonrpc: "2.0", Id: optional(id), Error: &wire.Fault{Code: code, Message: message}}
}
func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func validate(name string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return wire.Validate(name, data)
}

// Bound owner output before serialization/validation. Raw JSON expansion is
// conservatively counted without building a second, potentially huge response.
func boundResponse(response wire.Response) wire.Response {
	result := response.Result
	if result == nil {
		return response
	}
	unknown := func() wire.Response {
		result.Status = "unknown"
		result.Data = nil
		result.Code = optional("owner_output_bound")
		return response
	}
	if len(result.Status) > 256 || (result.Code != nil && len(*result.Code) > 256) || len(result.Data) > ipc.MaxFrameBytes {
		return unknown()
	}
	if len(result.Data) == 0 {
		return response
	}
	header := response
	metadata := *result
	metadata.Data = nil
	header.Result = &metadata
	encoded, err := json.Marshal(header)
	if err != nil {
		return unknown()
	}
	bound := len(encoded) + 8 + len(result.Data)
	for _, character := range []byte{'<', '>', '&'} {
		bound += 5 * bytes.Count(result.Data, []byte{character})
	}
	bound += 3 * (bytes.Count(result.Data, []byte{0xe2, 0x80, 0xa8}) + bytes.Count(result.Data, []byte{0xe2, 0x80, 0xa9}))
	if bound > ipc.MaxFrameBytes {
		return unknown()
	}
	return response
}

func responseJSON(response wire.Response) ([]byte, error) {
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, err
	}
	if err := ipc.ValidateJSON(encoded); err != nil {
		return nil, err
	}
	if err := wire.Validate("Response", encoded); err != nil {
		return nil, err
	}
	return encoded, nil
}
