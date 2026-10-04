package lifecycle

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// One bounded external round, on the existing owner. Private bodies live only
// in transient delivery memory; the journal retains the existing call ID/kinds.
const CallerArgumentBytesLimit = 64 * 1024
const CallerOutputBytesLimit = 512 * 1024
const callerInputBytesLimit = 1024 * 1024

type callerPhase string

const (
	callerPending   callerPhase = "pending"
	callerAccepted  callerPhase = "accepted"
	callerReturning callerPhase = "returning"
	callerReturned  callerPhase = "returned"
	callerUnknown   callerPhase = "unknown"
)

// No public constructor, executor, replacement ID or retry route. The original
// ComputerCall is deliberately private: output acceptance cannot resolve it.
type CallerToolCall struct {
	original        *ComputerCall
	request         port.BeginCallerToolRequest
	phase           callerPhase
	output          port.CallerOutput
	textOffset      int
	roundOpened     bool
	dispatchClaimed bool
	// Owner-captured original group bounds; no duplicate private body buffer.
	deliveryFirst, deliveryLast uint64
	deliveryIssued              bool
}

func cloneCallerFunction(c port.CallerFunctionCall) port.CallerFunctionCall {
	if c.Namespace != nil {
		value := *c.Namespace
		c.Namespace = &value
	}
	return c
}
func callerScopeValid(s port.CallerScope) bool {
	for _, v := range []string{s.SessionID, s.ThreadID, s.TurnID, s.RootTurnID} {
		if v == "" || !utf8.ValidString(v) || len(utf16.Encode([]rune(v))) > 160 {
			return false
		}
	}
	return validID(s.Model)
}
func callerFunctionEqual(a, b port.CallerFunctionCall) bool {
	if a.ItemID != b.ItemID || a.CallID != b.CallID || a.Name != b.Name || a.Arguments != b.Arguments {
		return false
	}
	if (a.Namespace == nil) != (b.Namespace == nil) {
		return false
	}
	an, bn := "", ""
	if a.Namespace != nil {
		an = *a.Namespace
	}
	if b.Namespace != nil {
		bn = *b.Namespace
	}
	return an == bn
}
func (c *Conversation) BeginCallerTool(ctx context.Context, input port.BeginCallerToolRequest) (*CallerToolCall, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return nil, Invalid
	}
	input.Call = cloneCallerFunction(input.Call)
	if !callerScopeValid(input.Scope) || !validID(input.ProducerOperationID) || !validID(input.Call.ItemID) || !validID(input.Call.Name) || (input.Call.Namespace != nil && !validID(*input.Call.Namespace)) || len(input.Call.Arguments) > CallerArgumentBytesLimit || !utf8.ValidString(input.Call.Arguments) {
		return nil, Invalid
	}
	var arguments map[string]json.RawMessage
	if json.Unmarshal([]byte(input.Call.Arguments), &arguments) != nil || arguments == nil {
		return nil, Invalid
	}
	s, h := c.owner, c.handle
	// Preserve the existing external call prefix/tag contract. IDs are supplied
	// by the already selected producer; this pure service mints no random values.
	identity := []byte(`{"rootTurnId":` + callerJSONString(input.Scope.RootTurnID) + `,"sessionId":` + callerJSONString(input.Scope.SessionID) + `,"threadId":` + callerJSONString(input.Scope.ThreadID) + `,"turnId":` + callerJSONString(input.Scope.TurnID) + `}`)
	if s.deps.IntentDigests == nil {
		return nil, Unavailable
	}
	tag, err := s.deps.IntentDigests.Digest(identity)
	if err != nil || !callerHex(tag, 64) || !callerHex(strings.TrimPrefix(input.Call.CallID, "farol_next_call_"), 32) || !strings.HasPrefix(input.Call.CallID, "farol_next_call_"+tag[:16]) {
		return nil, Invalid
	}
	call := &CallerToolCall{original: &ComputerCall{conversation: c, correlation: input.Context, callID: input.ProducerOperationID}, request: input, phase: callerPending}
	var frames *stream.Buffer
	m, err := s.stage(ctx, h, false, func(q *turn.Queue, before turn.Snapshot) (port.JournalEntry, error) {
		current, err := c.computerContext(before)
		if err != nil {
			return port.JournalEntry{}, err
		}
		if current != input.Context || input.Scope.Model != h.target.Selection.Alias || input.Call.ItemID == current.ReplyID || input.Call.ItemID == "resp-"+h.fixed.OperationID {
			return port.JournalEntry{}, Mismatch
		}
		if h.caller != nil || h.unresolvedCallID != "" {
			return port.JournalEntry{}, Unsettled
		}
		frames = h.frames.Clone()
		call.textOffset = len(h.output.Text())
		groupBefore := frames.Snapshot().LastSequence
		if err := callerToolFrames(h, call, frames); err != nil {
			if err == stream.Overflow {
				s.unknown = true
			}
			return port.JournalEntry{}, err
		}
		// Bounds belong to this candidate and are published with this exact call
		// only after its original known request-computer commit.
		call.deliveryFirst, call.deliveryLast = groupBefore+1, frames.Snapshot().LastSequence
		after, err := q.RequestComputer(before.Binding, input.ProducerOperationID)
		return port.JournalEntry{Binding: h.fixed, Kind: "request-computer", Before: before, After: after, CallID: input.ProducerOperationID, Closed: h.closed}, err
	})
	if err != nil {
		return nil, err
	}
	// One atomic publication after known durable intent. Neither cancellation
	// during unlocked journal IO nor a lost commit reply can expose the frames.
	m.caller, m.frames = call, frames
	if err := s.commit(ctx, m, true); err != nil {
		return nil, err
	}
	return call, nil
}
func callerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, ch := range value {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}
func (call *CallerToolCall) current(ctx context.Context) (*Service, *Handle, error) {
	c := call.original.conversation
	s, h := c.owner, c.handle
	if err := s.settlementAvailable(ctx); err != nil {
		return nil, nil, err
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || h.caller != call {
		return nil, nil, Mismatch
	}
	current, err := c.computerContext(view)
	if err != nil {
		return nil, nil, err
	}
	if current.SourceSequence < call.request.Context.SourceSequence {
		return nil, nil, Mismatch
	}
	current.SourceSequence = call.request.Context.SourceSequence
	if current != call.request.Context || view.OutstandingCallID != call.request.ProducerOperationID || h.unresolvedCallID != call.request.ProducerOperationID {
		return nil, nil, Mismatch
	}
	return s, h, nil
}
func (call *CallerToolCall) valid() bool {
	return call != nil && call.original != nil && call.original.conversation != nil && call.original.conversation.owner != nil && call.original.conversation.handle != nil
}

// ClaimDispatch preserves the original one-time compatibility/settlement edge.
// The selected HTTP path MUST obtain IssueDelivery before its executable write;
// a claim, CheckDispatch snapshot or retained Events alone is not write authority.
// Loss never permits another claim, issuance or executable send.
func (call *CallerToolCall) ClaimDispatch(ctx context.Context) error {
	if !call.valid() || ctx == nil {
		return Invalid
	}
	s := call.original.conversation.owner
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	// Freeze blocks this first executable delivery, while original output and
	// return methods deliberately keep settlementAvailable semantics.
	if err := s.available(ctx); err != nil {
		return err
	}
	if _, _, err := call.current(ctx); err != nil {
		return err
	}
	if call.phase != callerPending || call.dispatchClaimed {
		return Unsettled
	}
	call.dispatchClaimed = true
	return nil
}
func (call *CallerToolCall) AcceptOutput(ctx context.Context, input port.AcceptCallerOutputRequest) (*port.CallerOutput, error) {
	if !call.valid() || ctx == nil {
		return nil, Invalid
	}
	if input.Context != call.request.Context || input.Scope != call.request.Scope || len(input.Calls) != 1 || len(input.Outputs) != 1 || !callerFunctionEqual(input.Calls[0], call.request.Call) || input.Outputs[0].CallID != call.request.Call.CallID {
		return nil, Mismatch
	}
	output, err := normalizeCallerOutput(append([]byte(nil), input.Outputs[0].Raw...))
	if err != nil {
		return nil, err
	}
	s := call.original.conversation.owner
	hash, err := s.deps.IntentDigests.Digest([]byte(output))
	if err != nil || !callerHex(hash, 64) {
		return nil, Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	_, h, err := call.current(ctx)
	if err != nil {
		return nil, err
	}
	if call.phase != callerPending || !call.dispatchClaimed {
		return nil, Unsettled
	}
	frames := h.frames.Clone()
	// The continuation opens another HTTP round, never another Chat turn or Send.
	response := map[string]any{"id": "resp-" + h.fixed.OperationID + "-1", "object": "response", "model": call.request.Scope.Model, "status": "in_progress", "output": []any{}}
	if err := appendModelFrame(frames, "response.created", stream.Phase, map[string]any{"response": response}); err != nil {
		call.phase, s.unknown = callerUnknown, true
		return nil, err
	}
	call.output = port.CallerOutput{Output: output, SHA256: hash, Bytes: uint64(len(output))}
	call.phase, call.roundOpened, h.frames = callerAccepted, true, frames
	result := call.output
	return &result, nil
}

// Only the trusted original parsed-result receipt supplies this edge. Acceptance,
// reading Events, socket writes and AcknowledgeFrame never call it automatically.
func (call *CallerToolCall) AcknowledgeReturn(ctx context.Context, ack *port.CallerReturn) error {
	if !call.valid() || ctx == nil {
		return Invalid
	}
	if ack == nil || !ack.Returned {
		return Unsettled
	}
	s := call.original.conversation.owner
	s.deps.Gate.Lock()
	if _, _, err := call.current(ctx); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	if call.phase != callerAccepted {
		s.deps.Gate.Unlock()
		return Unsettled
	}
	if ack.Context != call.request.Context || ack.ProducerOperationID != call.request.ProducerOperationID || ack.CallID != call.request.Call.CallID || ack.OutputSHA256 != call.output.SHA256 || ack.OutputBytes != call.output.Bytes {
		s.deps.Gate.Unlock()
		return Mismatch
	}
	call.phase = callerReturning // consume before unlocked original journal IO
	s.deps.Gate.Unlock()
	err := call.original.AcknowledgeReturn(ctx, &port.ComputerReturn{Context: call.request.Context, CallID: call.request.ProducerOperationID, Returned: true})
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err != nil {
		// An observation may have started between the receipt guard and the
		// original Resolve stage. Keep the consumed phase immutable for its
		// unlocked encoder, and fence the actual owner under Gate instead.
		s.unknown = true
	}
	return err
}
func normalizeCallerOutput(raw []byte) (string, error) {
	if len(raw) == 0 || len(raw) > callerInputBytesLimit || !utf8.Valid(raw) || !json.Valid(raw) || !callerUnicode(raw) {
		return "", Invalid
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return "", Invalid
	}
	output, ok := value.(string)
	if !ok {
		parts, valid := value.([]any)
		if !valid {
			return "", Invalid
		}
		texts := make([]string, 0, len(parts))
		for _, part := range parts {
			p, valid := part.(map[string]any)
			if !valid {
				return "", Invalid
			}
			kind, _ := p["type"].(string)
			text, valid := p["text"].(string)
			if !valid || (kind != "input_text" && kind != "output_text" && kind != "text") {
				return "", Invalid
			}
			texts = append(texts, text)
		}
		output = strings.Join(texts, "\n")
	}
	if len(output) > CallerOutputBytesLimit || !utf8.ValidString(output) {
		return "", Invalid
	}
	return output, nil
}

// encoding/json replaces lone UTF-16 surrogates. Reject that lossy boundary
// instead of claiming a receipt for output bytes that the caller did not send.
func callerUnicode(raw []byte) bool {
	for n := 0; n < len(raw); n++ {
		if raw[n] != '\\' {
			continue
		}
		n++
		if n >= len(raw) {
			return false
		}
		if raw[n] != 'u' {
			continue
		}
		if n+4 >= len(raw) {
			return false
		}
		v, err := strconv.ParseUint(string(raw[n+1:n+5]), 16, 16)
		if err != nil {
			return false
		}
		n += 4
		if v >= 0xdc00 && v <= 0xdfff {
			return false
		}
		if v >= 0xd800 && v <= 0xdbff {
			if n+6 >= len(raw) || raw[n+1] != '\\' || raw[n+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[n+3:n+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			n += 6
		}
	}
	return true
}

// Match the existing canonicalJson/JSON.stringify identity bytes. Go's HTML
// and U+2028/U+2029 escapes differ; decode only those generated escapes, never
// a caller's literal backslash-u sequence.
func callerJSONString(value string) string {
	raw, _ := json.Marshal(value)
	var out strings.Builder
	for n := 0; n < len(raw); n++ {
		if raw[n] == '\\' && n+1 < len(raw) {
			if raw[n+1] == 'u' && n+5 < len(raw) {
				hex := string(raw[n+2 : n+6])
				switch hex {
				case "003c", "003e", "0026", "2028", "2029":
					v, _ := strconv.ParseUint(hex, 16, 16)
					out.WriteRune(rune(v))
					n += 5
					continue
				}
			}
			out.WriteByte(raw[n])
			n++
			out.WriteByte(raw[n])
			continue
		}
		out.WriteByte(raw[n])
	}
	return out.String()
}

// CheckDispatch observes only this already-claimed original call under its owner
// gate. Success is a snapshot, not a transport mutex/fence or a new grant: the
// owner may change immediately after return, including across an awaited drain.
// It neither claims again nor executes, journals, ACKs or changes owner state.
func (call *CallerToolCall) CheckDispatch(ctx context.Context) error {
	if !call.valid() || ctx == nil {
		return Invalid
	}
	c := call.original.conversation
	s, h := c.owner, c.handle
	if s.deps.Gate == nil || s.queue == nil || h.owner != s {
		return Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	return call.checkDispatchCurrent(ctx)
}

// checkDispatchCurrent is read-only and is called only with the actual owner
// gate held, after valid/context/owner checks by CheckDispatch or IssueDelivery.
func (call *CallerToolCall) checkDispatchCurrent(ctx context.Context) error {
	s := call.original.conversation.owner
	if ctx.Err() != nil {
		return Cancelled
	}
	// Unlike available/settlementAvailable, this read must not set sticky unknown
	// at counter exhaustion. These checks also make current's availability read
	// non-mutating while the same gate remains held.
	if s.unknown || s.revision == math.MaxUint64 || s.fence == math.MaxUint64 {
		return Unsettled
	}
	if s.pending != nil || s.retiring {
		return Busy
	}
	if s.frozen || s.retired != nil {
		return Frozen
	}
	if !call.dispatchClaimed || call.phase != callerPending {
		return Unsettled
	}
	if _, _, err := call.current(ctx); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}
