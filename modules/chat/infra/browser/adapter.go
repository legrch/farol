package browser

import (
	"context"
	"math"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid   Code = "CHAT_BROWSER_BRIDGE_INVALID"
	Mismatch  Code = "CHAT_BROWSER_BRIDGE_MISMATCH"
	Expired   Code = "CHAT_BROWSER_BRIDGE_EXPIRED"
	Unsettled Code = "CHAT_BROWSER_BRIDGE_UNKNOWN"
)
const MaxPromptBytes = 8192

// Adapter owns only immutable composition and mapping. The live Chat owner owns
// one-shot intent/queue/result state; Root/Desktop own physical correlation and
// witness consumption. There is no retry loop, fallback or private scheduler.
type Adapter struct {
	lifetime context.Context
	scope    Scope
	exchange Exchange
	clock    Clock
}

var _ port.VerifiedBrowser = (*Adapter)(nil)

func New(ctx context.Context, scope Scope, exchange Exchange, clock Clock) (*Adapter, error) {
	if nilCapability(ctx) || ctx.Err() != nil || nilCapability(exchange) || nilCapability(clock) || !validID(scope.ProfileID) || !validID(scope.BackendGeneration) {
		return nil, Invalid
	}
	return &Adapter{lifetime: ctx, scope: scope, exchange: exchange, clock: clock}, nil
}

// call sends once. The remaining budget is relative only for ctx cancellation;
// the command retains the exact absolute UTC deadline for Root/physical checks.
// No goroutine is started to abandon or duplicate an Exchange that ignores ctx.
func (a *Adapter) call(command Command, deadline uint64) (Reply, error) {
	if a == nil || a.lifetime.Err() != nil {
		return nil, Expired
	}
	now := a.clock.NowMillis()
	if deadline == 0 || deadline <= now {
		return nil, Expired
	}
	remaining := deadline - now
	if remaining > uint64(math.MaxInt64/int64(time.Millisecond)) {
		return nil, Invalid
	}
	ctx, cancel := context.WithTimeout(a.lifetime, time.Duration(remaining)*time.Millisecond)
	defer cancel()
	if ctx.Err() != nil {
		return nil, Expired
	}
	reply, err := a.exchange.Exchange(ctx, command)
	if err != nil || reply == nil || ctx.Err() != nil || a.lifetime.Err() != nil || a.clock.NowMillis() >= deadline {
		return nil, Unsettled
	}
	return reply, nil
}
func (a *Adapter) validLease(lease port.BrowserLease) bool {
	if a == nil {
		return false
	}
	i := lease.Identity
	for _, id := range []string{i.ProfileID, i.OwnerID, i.SessionID, i.TaskID, i.TurnID, i.OperationID, lease.BackendGeneration} {
		if !validID(id) {
			return false
		}
	}
	return i.ProfileID == a.scope.ProfileID && lease.BackendGeneration == a.scope.BackendGeneration && i.TurnGeneration > 0 && lease.SlotOrdinal >= 1 && lease.SlotOrdinal <= 5 && lease.SlotGeneration > 0
}
func (a *Adapter) validBinding(b port.BrowserBinding) bool {
	return a.validLease(b.Lease) && validID(b.ViewID) && b.ViewGeneration > 0 && b.DocumentGeneration > 0 && validID(b.ConversationID)
}
func validID(s string) bool {
	if len(s) < 1 || len(s) > 120 || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c <= 32 || c == 127 {
			return false
		}
	}
	return true
}
func validDigest(s string) bool {
	return len(s) == 64 && strings.IndexFunc(s, func(c rune) bool { return !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) }) == -1
}
func validCode(s string) bool {
	if len(s) > 120 {
		return false
	}
	for n, c := range s {
		if c >= 'A' && c <= 'Z' {
			continue
		}
		if n > 0 && ((c >= '0' && c <= '9') || c == '_') {
			continue
		}
		return false
	}
	return true
}
func validPrevious(user, reply string) bool {
	return (user == "" && reply == "") || (validID(user) && validID(reply))
}

func (a *Adapter) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	if !a.validLease(r.Lease) || !r.Target.Valid() {
		return nil, Invalid
	}
	raw, err := a.call(PrepareCommand{Target: targetFromPort(r.Target), Lease: leaseFromPort(r.Lease), DeadlineMillis: r.DeadlineMillis}, r.DeadlineMillis)
	if err != nil {
		return nil, err
	}
	reply, ok := raw.(PreparedReply)
	if !ok {
		return nil, Unsettled
	}
	b := bindingToPort(reply.Binding)
	if !a.validBinding(b) || b.Lease != r.Lease || !validCode(reply.Code) {
		return nil, Unsettled
	}
	switch port.Readiness(reply.Readiness) {
	case port.Ready, port.OwnerRequired, port.SignInRequired, port.Unavailable:
	default:
		return nil, Unsettled
	}
	if (reply.Readiness == string(port.Ready) || reply.Readiness == string(port.OwnerRequired)) && !reply.Saved {
		return nil, Unsettled
	}
	if r.Target.Mode == port.OwnedSaved && b.ConversationID != r.Target.ConversationID {
		return nil, Unsettled
	}
	return &port.PrepareResponse{Saved: reply.Saved, Readiness: port.Readiness(reply.Readiness), Binding: b, Code: reply.Code}, nil
}
func (a *Adapter) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	if !a.validBinding(r.Binding) || !r.Requested.Valid() || !validDigest(r.IntentDigest) || !validPrevious(r.PreviousUserTurnID, r.PreviousReplyID) {
		return nil, Invalid
	}
	raw, err := a.call(VerifySendCommand{Binding: bindingFromPort(r.Binding), Requested: selectionFromPort(r.Requested), PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: r.IntentDigest, DeadlineMillis: r.DeadlineMillis}, r.DeadlineMillis)
	if err != nil {
		return nil, err
	}
	reply, ok := raw.(VerifiedReply)
	if !ok {
		return nil, Unsettled
	}
	proof := verificationToPort(reply.Verification)
	if !port.ValidVerification(r, &proof) {
		return nil, Unsettled
	}
	return &proof, nil
}
func (a *Adapter) Send(r port.SendRequest) (*port.SendResponse, error) {
	v := r.Verification
	expected := port.VerifySendRequest{Binding: r.Binding, Requested: v.Observed, PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, IntentDigest: r.IntentDigest}
	if !a.validBinding(r.Binding) || !validDigest(r.IntentDigest) || len(r.Prompt) < 1 || len(r.Prompt) > MaxPromptBytes || !utf8.ValidString(r.Prompt) || !validPrevious(v.PreviousUserTurnID, v.PreviousReplyID) || !port.ValidVerification(expected, &v) {
		return nil, Invalid
	}
	raw, err := a.call(SendCommand{Binding: bindingFromPort(r.Binding), Verification: verificationFromPort(v), IntentDigest: r.IntentDigest, Prompt: r.Prompt, DeadlineMillis: r.DeadlineMillis}, r.DeadlineMillis)
	if err != nil {
		return nil, err
	}
	reply, ok := raw.(SentReply)
	if !ok || bindingToPort(reply.Binding) != r.Binding || reply.VerificationID != v.EvidenceID || !validCode(reply.Code) {
		return nil, Unsettled
	}
	switch port.SendStatus(reply.Status) {
	case port.Submitted, port.NotSent, port.SendUnknown:
	default:
		return nil, Unsettled
	}
	return &port.SendResponse{Binding: r.Binding, VerificationID: reply.VerificationID, Status: port.SendStatus(reply.Status), Code: reply.Code}, nil
}
func (a *Adapter) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	limit := r.Limit
	if limit == 0 {
		limit = port.MaxObserveEvents
	}
	if !a.validBinding(r.Binding) || limit < 1 || limit > port.MaxObserveEvents || r.AfterSequence == math.MaxUint64 {
		return nil, Invalid
	}
	raw, err := a.call(ObserveCommand{Binding: bindingFromPort(r.Binding), AfterSequence: r.AfterSequence, Limit: limit, DeadlineMillis: r.DeadlineMillis}, r.DeadlineMillis)
	if err != nil {
		return nil, err
	}
	reply, ok := raw.(ObservedReply)
	if !ok || len(reply.Events) > limit {
		return nil, Unsettled
	}
	// Validate semantic byte/ID bounds BEFORE allocating the port event slice.
	bytes := 0
	for _, e := range reply.Events {
		if len(e.Text) > port.MaxObserveTextBytes || !utf8.ValidString(e.Text) || !validCode(e.Code) || (e.UserTurnID != "" && !validID(e.UserTurnID)) || (e.ReplyID != "" && !validID(e.ReplyID)) || (e.SegmentID != "" && !validID(e.SegmentID)) {
			return nil, Unsettled
		}
		bytes += len(e.Text) + len(e.Code) + len(e.UserTurnID) + len(e.ReplyID) + len(e.SegmentID)
		if bytes > port.MaxObservePageBytes {
			return nil, Unsettled
		}
	}
	events := make([]port.BrowserObservation, 0, len(reply.Events))
	for _, e := range reply.Events {
		events = append(events, port.BrowserObservation{Binding: bindingToPort(e.Binding), Sequence: e.Sequence, ObservedAtMillis: e.ObservedAtMillis, Kind: port.ObservationKind(e.Kind), Text: e.Text, Code: e.Code, UserTurnID: e.UserTurnID, ReplyID: e.ReplyID, SegmentID: e.SegmentID})
	}
	result := &port.ObserveResponse{Events: events, Gap: reply.Gap}
	if err := port.ValidateObserveResponse(r, result); err != nil {
		return nil, Unsettled
	}
	return result, nil
}
func (a *Adapter) Cancel(r port.CancelRequest) (*port.CancelResponse, error) {
	if !a.validBinding(r.Binding) {
		return nil, Invalid
	}
	raw, err := a.call(CancelCommand{Binding: bindingFromPort(r.Binding), DeadlineMillis: r.DeadlineMillis}, r.DeadlineMillis)
	if err != nil {
		return nil, err
	}
	reply, ok := raw.(CancelledReply)
	if !ok || bindingToPort(reply.Binding) != r.Binding || !validCode(reply.Code) {
		return nil, Unsettled
	}
	switch port.CancelStatus(reply.Status) {
	case port.CancelRequested, port.CancelConfirmed, port.AlreadyTerminal, port.CancelUnknown:
	default:
		return nil, Unsettled
	}
	return &port.CancelResponse{Binding: r.Binding, Status: port.CancelStatus(reply.Status), Code: reply.Code}, nil
}
func (a *Adapter) Dispose(r port.DisposeRequest) (*port.DisposeResponse, error) {
	if !a.validLease(r.Lease) {
		return nil, Invalid
	}
	raw, err := a.call(DisposeCommand{Lease: leaseFromPort(r.Lease), DeadlineMillis: r.DeadlineMillis}, r.DeadlineMillis)
	if err != nil {
		return nil, err
	}
	reply, ok := raw.(DisposedReply)
	if !ok || leaseToPort(reply.Lease) != r.Lease || !validCode(reply.Code) {
		return nil, Unsettled
	}
	return &port.DisposeResponse{Lease: r.Lease, Confirmed: reply.Confirmed, Code: reply.Code}, nil
}

func nilCapability(value any) bool {
	if value == nil {
		return true
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface, reflect.Map, reflect.Func, reflect.Slice, reflect.Chan:
		return v.IsNil()
	}
	return false
}
