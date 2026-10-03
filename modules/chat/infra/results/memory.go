// Package results retains bounded delivery bytes outside journal and Activity.
package results

import (
	"bytes"
	"context"
	"reflect"
	"sync"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_RESULT_RETENTION_INVALID"
	Mismatch    Code = "CHAT_RESULT_RETENTION_MISMATCH"
	Conflict    Code = "CHAT_RESULT_RETENTION_CONFLICT"
	Capacity    Code = "CHAT_RESULT_RETENTION_CAPACITY"
	Unavailable Code = "CHAT_RESULT_RETENTION_UNAVAILABLE"
	Active      Code = "CHAT_RESULT_RETENTION_ACTIVE"
)

const MaxResults = turn.MaxRequests
const MaxResultBytes = 8192
const MaxTotalBytes = MaxResults * MaxResultBytes

type Limits struct{ Results, ResultBytes, TotalBytes int }

func TextLimits() Limits {
	return Limits{Results: MaxResults, ResultBytes: MaxResultBytes, TotalBytes: MaxTotalBytes}
}

type retained struct {
	receipt port.RetainReceipt
	payload []byte
}

// Memory belongs to one backend lifetime. The operation key is only an index;
// every retained value and known duplicate must match the full TurnBinding.
// It never evicts, acknowledges, persists or reconstructs admission authority.
type Memory struct {
	mu        sync.Mutex
	lifetime  context.Context
	scope     port.JournalScope
	limits    Limits
	entries   map[string]retained
	usedBytes int
	closed    bool
}

var _ port.ResultRetention = (*Memory)(nil)

func NewMemory(lifetime context.Context, scope port.JournalScope, limits Limits) (*Memory, error) {
	if nilContext(lifetime) || lifetime.Err() != nil || !validID(scope.ProfileID) || !validID(scope.BackendGeneration) ||
		limits.Results < 1 || limits.Results > MaxResults || limits.ResultBytes < 1 || limits.ResultBytes > MaxResultBytes ||
		limits.TotalBytes < limits.ResultBytes || limits.TotalBytes > MaxTotalBytes {
		return nil, Invalid
	}
	return &Memory{lifetime: lifetime, scope: scope, limits: limits, entries: make(map[string]retained)}, nil
}

// Retain copies real bytes before attesting them. An exact known duplicate reads
// the existing receipt, including at capacity; any changed binding/result/bytes
// conflicts without overwriting it. An error authorizes no lifecycle retry.
func (m *Memory) Retain(ctx context.Context, request port.RetainRequest) (*port.RetainReceipt, error) {
	if m == nil || nilContext(ctx) {
		return nil, Invalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lifetime == nil || m.closed || m.lifetime.Err() != nil || ctx.Err() != nil {
		return nil, Unavailable
	}
	if !validBinding(request.Binding) || !validResult(request.Result) || len(request.Payload) > m.limits.ResultBytes {
		return nil, Invalid
	}
	if request.Binding.ProfileID != m.scope.ProfileID || request.Binding.BackendGeneration != m.scope.BackendGeneration {
		return nil, Mismatch
	}
	if old, found := m.entries[request.Binding.OperationID]; found {
		if old.receipt.Binding != request.Binding || old.receipt.Result != request.Result || !bytes.Equal(old.payload, request.Payload) {
			return nil, Conflict
		}
		receipt := old.receipt
		return &receipt, nil
	}
	if len(m.entries) >= m.limits.Results || len(request.Payload) > m.limits.TotalBytes-m.usedBytes {
		return nil, Capacity
	}
	payload := append([]byte(nil), request.Payload...)
	if ctx.Err() != nil || m.lifetime.Err() != nil {
		return nil, Unavailable
	}
	receipt := port.RetainReceipt{Binding: request.Binding, Result: request.Result, Bytes: len(payload)}
	m.entries[request.Binding.OperationID] = retained{receipt: receipt, payload: payload}
	m.usedBytes += len(payload)
	return &receipt, nil
}

// Close drops only this store's RAM references after its lifetime has ended.
// Root calls it after stopping the owner; it is not ACK, secure erasure, clean
// retirement evidence or permission to replace a retained journal claim.
func (m *Memory) Close() error {
	if m == nil {
		return Invalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	if m.lifetime == nil || m.lifetime.Err() == nil {
		return Active
	}
	m.closed = true
	m.entries = nil
	m.usedBytes = 0
	return nil
}

func validBinding(b port.TurnBinding) bool {
	for _, s := range []string{b.ProfileID, b.BackendGeneration, b.OwnerID, b.SessionID, b.TaskID, b.ParticipantID, b.TurnID, b.OperationID} {
		if !validID(s) {
			return false
		}
	}
	return b.TaskEpoch > 0 && b.TurnGeneration > 0
}
func validID(s string) bool {
	if len(s) < 1 || len(s) > 120 || !utf8.ValidString(s) {
		return false
	}
	for _, ch := range s {
		if ch <= 32 || ch == 127 {
			return false
		}
	}
	return true
}
func validResult(r turn.Result) bool {
	if !validID(r.ID) || len(r.Code) < 1 || len(r.Code) > 120 {
		return false
	}
	for n, ch := range r.Code {
		if ch >= 'A' && ch <= 'Z' {
			continue
		}
		if n > 0 && ((ch >= '0' && ch <= '9') || ch == '_') {
			continue
		}
		return false
	}
	switch r.Outcome {
	case turn.Completed, turn.Refused, turn.Failed, turn.CancelledOutcome, turn.UnknownOutcome:
		return true
	default:
		return false
	}
}
func nilContext(ctx context.Context) bool {
	if ctx == nil {
		return true
	}
	v := reflect.ValueOf(ctx)
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return v.IsNil()
	default:
		return false
	}
}
