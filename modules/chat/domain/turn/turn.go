// Package turn owns content-free model request and delivery state.
// Its caller serializes transitions and persists intent before invoking a browser.
package turn

import (
	"math"
	"strings"
	"unicode/utf8"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_INVALID"
	Conflict    Code = "CHAT_CONFLICT"
	Transition  Code = "CHAT_TRANSITION"
	Correlation Code = "CHAT_CORRELATION"
	Sequence    Code = "CHAT_SEQUENCE"
	NoDelta     Code = "CHAT_NO_DELTA"
	Unsettled   Code = "CHAT_UNSETTLED"
	Capacity    Code = "CHAT_CAPACITY"
	NotFound    Code = "CHAT_NOT_FOUND"
)

type Phase string

const (
	Admitted      Phase = "admitted"
	Pending       Phase = "pending"
	Running       Phase = "running"
	AwaitingOwner Phase = "awaiting-owner"
	ResultReady   Phase = "result-ready"
	Delivered     Phase = "delivered"
	Cancelled     Phase = "cancelled"
	Unknown       Phase = "unknown"
)

type Outcome string

const (
	Completed        Outcome = "completed"
	Refused          Outcome = "refused"
	Failed           Outcome = "failed"
	CancelledOutcome Outcome = "cancelled"
	UnknownOutcome   Outcome = "unknown"
)

// Identity never contains a slot ordinal. Generation identifies the logical turn.
type Identity struct {
	ProfileID   string
	OwnerID     string
	SessionID   string
	TaskID      string
	TurnID      string
	OperationID string
	Generation  uint64
}

func (i Identity) valid() bool {
	return id(i.ProfileID) && id(i.OwnerID) && id(i.SessionID) && id(i.TaskID) &&
		id(i.TurnID) && id(i.OperationID) && i.Generation > 0
}

// Reservation is a scheduler lease, not a durable task or native view identity.
type Reservation struct {
	Identity          Identity
	Ordinal           uint8
	Generation        uint64
	BackendGeneration string
}

// Document names the exact Desktop-owned surface and navigation observation.
// ConversationID is a validated opaque provider handle, never a caller URL.
type ProviderState string

const (
	ProviderHome  ProviderState = "home"
	ProviderBound ProviderState = "bound"
)

type Document struct {
	ProviderState      ProviderState
	ViewID             string
	ViewGeneration     uint64
	DocumentGeneration uint64
	ConversationID     string
}

// EffectiveProviderState preserves only legacy already-bound values. Home is never inferred.
func (d Document) EffectiveProviderState() ProviderState {
	if d.ProviderState == "" && id(d.ConversationID) {
		return ProviderBound
	}
	return d.ProviderState
}
func (d Document) valid() bool {
	if !id(d.ViewID) || d.ViewGeneration == 0 || d.DocumentGeneration == 0 {
		return false
	}
	switch d.EffectiveProviderState() {
	case ProviderHome:
		return d.ConversationID == ""
	case ProviderBound:
		return id(d.ConversationID)
	}
	return false
}

type Binding struct {
	Reservation Reservation
	Document    Document
}

// QuiescenceEvidence is mapped only from a validated Desktop Quiescent event.
// The application correlates that event to the exact retained result; a result,
// hidden view, disconnect or cancellation intent alone is not this evidence.
type QuiescenceEvidence struct {
	Binding   Binding
	ResultID  string
	Sequence  uint64
	Confirmed bool
}

// DisposalEvidence is mapped only from a confirmed Dispose response for the
// exact reservation. It covers cleanup when Prepare never bound a document.
type DisposalEvidence struct {
	Reservation Reservation
	ResultID    string
	Confirmed   bool
}

// Result is metadata only. Answer bytes belong to the bounded delivery owner.
// Code is a classified identifier; raw errors, prompts and answers are excluded.
type Result struct {
	ID      string
	Outcome Outcome
	Code    string
}

func (r Result) valid() bool {
	if !id(r.ID) || !code(r.Code) {
		return false
	}
	switch r.Outcome {
	case Completed, Refused, Failed, CancelledOutcome, UnknownOutcome:
		return true
	default:
		return false
	}
}

// Snapshot is an Activity projection. Reading or rendering it acknowledges nothing.
type Snapshot struct {
	Identity             Identity
	Phase                Phase
	Reserved             bool
	Reservation          Reservation
	Bound                bool
	Binding              Binding
	SendIntent           bool
	Accepted             bool
	DeltaCount           uint64
	LastSequence         uint64
	OutstandingCallID    string
	HasResult            bool
	Result               Result
	DeliveryAcknowledged bool
	LifecycleSettled     bool
}

// MaxComputerCalls bounds deduplication state without evicting used call IDs.
const MaxComputerCalls = 128

type Turn struct {
	identity     Identity
	digest       string
	phase        Phase
	reserved     bool
	reservation  Reservation
	bound        bool
	binding      Binding
	sendIntent   bool
	accepted     bool
	deltaCount   uint64
	lastSequence uint64
	hasResult    bool
	result       Result
	acknowledged bool
	settled      bool
	resume       Phase
	callID       string
	usedCallIDs  [MaxComputerCalls]string
	callCount    int
}

func New(identity Identity, digest string) (Turn, error) {
	if !identity.valid() || !sha256(digest) {
		return Turn{}, Invalid
	}
	return Turn{identity: identity, digest: digest, phase: Admitted}, nil
}

func (t Turn) Snapshot() Snapshot {
	return Snapshot{Identity: t.identity, Phase: t.phase, Reserved: t.reserved,
		Reservation: t.reservation, Bound: t.bound, Binding: t.binding, SendIntent: t.sendIntent,
		Accepted: t.accepted, DeltaCount: t.deltaCount, LastSequence: t.lastSequence,
		OutstandingCallID: t.callID, HasResult: t.hasResult, Result: t.result, DeliveryAcknowledged: t.acknowledged,
		LifecycleSettled: t.settled}
}

func (t Turn) wait() (Turn, error) {
	if t.phase != Admitted {
		return t, Transition
	}
	t.phase = Pending
	return t, nil
}

func (t Turn) reserve(r Reservation) (Turn, error) {
	if t.phase != Pending || t.reserved {
		return t, Transition
	}
	if r.Identity != t.identity || r.Ordinal < 1 || r.Ordinal > Slots || r.Generation == 0 || !id(r.BackendGeneration) {
		return t, Correlation
	}
	t.reserved, t.reservation = true, r
	return t, nil
}

func (t Turn) Bind(r Reservation, d Document) (Turn, error) {
	if !t.reserved || t.reservation != r {
		return t, Correlation
	}
	if t.phase != Pending || t.bound {
		return t, Transition
	}
	if !d.valid() {
		return t, Invalid
	}
	t.bound, t.binding = true, Binding{Reservation: r, Document: d}
	return t, nil
}

func (t Turn) matches(b Binding) bool { return t.bound && t.binding == b }

// Dispatch records the one Send intent. Even a lost native reply cannot undo it.
func (t Turn) Dispatch(b Binding) (Turn, error) {
	if !t.matches(b) {
		return t, Correlation
	}
	if t.phase != Pending || t.sendIntent {
		return t, Transition
	}
	t.phase, t.sendIntent = Running, true
	return t, nil
}

// AcceptConversation adopts the first real provider ID only on exact accepted Home evidence.
func (t Turn) AcceptConversation(b Binding, cid string) (Turn, error) {
	if !t.matches(b) || t.binding.Document.EffectiveProviderState() != ProviderHome || !id(cid) {
		return t, Correlation
	}
	if t.phase != Running || !t.sendIntent || t.accepted {
		return t, Transition
	}
	t.binding.Document.ProviderState, t.binding.Document.ConversationID = ProviderBound, cid
	t.accepted = true
	return t, nil
}

func (t Turn) Accept(b Binding) (Turn, error) {
	if b.Document.EffectiveProviderState() != ProviderBound {
		return t, Correlation
	}
	if !t.matches(b) {
		return t, Correlation
	}
	if t.phase != Running || !t.sendIntent || t.accepted {
		return t, Transition
	}
	t.accepted = true
	return t, nil
}

func (t Turn) AwaitOwner(b Binding) (Turn, error) {
	if !t.matches(b) {
		return t, Correlation
	}
	if t.phase != Pending && t.phase != Running {
		return t, Transition
	}
	t.resume, t.phase = t.phase, AwaitingOwner
	return t, nil
}

func (t Turn) Resume(b Binding) (Turn, error) {
	if !t.matches(b) {
		return t, Correlation
	}
	if t.phase != AwaitingOwner {
		return t, Transition
	}
	t.phase, t.resume = t.resume, ""
	return t, nil
}

func (t Turn) Delta(b Binding, sequence uint64) (Turn, error) {
	if !t.matches(b) {
		return t, Correlation
	}
	if t.phase != Running || !t.accepted || t.callID != "" {
		return t, Transition
	}
	if sequence <= t.lastSequence || t.deltaCount == math.MaxUint64 {
		return t, Sequence
	}
	t.lastSequence, t.deltaCount = sequence, t.deltaCount+1
	return t, nil
}

// RequestComputer pauses incremental output until the exact call is resolved.
// It does not execute a tool or submit its result to the provider.
func (t Turn) RequestComputer(b Binding, callID string) (Turn, error) {
	if !t.matches(b) {
		return t, Correlation
	}
	if t.phase != Running || !t.accepted || t.callID != "" {
		return t, Transition
	}
	if !id(callID) {
		return t, Invalid
	}
	for _, used := range t.usedCallIDs[:t.callCount] {
		if used == callID {
			return t, Conflict
		}
	}
	if t.callCount >= MaxComputerCalls {
		return t, Capacity
	}
	// The fixed array is copied with Turn. No old state shares a mutable map.
	t.usedCallIDs[t.callCount], t.callCount = callID, t.callCount+1
	t.callID = callID
	return t, nil
}
func (t Turn) ResolveComputer(b Binding, callID string) (Turn, error) {
	if !t.matches(b) || t.callID == "" || t.callID != callID {
		return t, Correlation
	}
	if t.phase != Running {
		return t, Transition
	}
	t.callID = ""
	return t, nil
}

func (t Turn) Finish(b Binding, result Result) (Turn, error) {
	if !t.matches(b) {
		return t, Correlation
	}
	if !result.valid() {
		return t, Invalid
	}
	if t.hasResult {
		if t.result == result {
			return t, nil
		}
		return t, Conflict
	}
	if t.phase != Pending && t.phase != Running && t.phase != AwaitingOwner {
		return t, Transition
	}
	switch result.Outcome {
	case Completed:
		if t.phase != Running || !t.accepted || t.callID != "" {
			return t, Transition
		}
		if t.deltaCount == 0 {
			return t, NoDelta
		}
	case UnknownOutcome:
		if !t.sendIntent {
			return t, Transition
		}
	case CancelledOutcome:
		// Generic provider results cannot prove cancellation/disposal. The current
		// Cancel path preserves the legacy unknown-after-Send policy; a future
		// confirmed cancellation path requires its own correlated evidence API.
		return t, Transition
	case Refused, Failed:
	default:
		return t, Invalid
	}
	t.hasResult, t.result, t.callID = true, result, ""
	t.phase = ResultReady
	if result.Outcome == UnknownOutcome {
		t.phase = Unknown
	}
	return t, nil
}

// Cancel records local intent. After Send it cannot claim provider cancellation.
func (t Turn) Cancel(resultID string) (Turn, error) {
	if !t.identity.valid() {
		return t, Invalid
	}
	if t.hasResult {
		return t, Transition
	}
	if !id(resultID) {
		return t, Invalid
	}
	if t.sendIntent {
		t.phase = Unknown
		t.result = Result{ID: resultID, Outcome: UnknownOutcome, Code: "CANCEL_AFTER_SEND"}
	} else {
		t.phase = Cancelled
		t.result = Result{ID: resultID, Outcome: CancelledOutcome, Code: "NOT_DISPATCHED"}
		// Reserved/prepared surfaces still require separate cleanup evidence.
		t.settled = !t.reserved
	}
	t.hasResult, t.callID = true, ""
	return t, nil
}

func (t Turn) Acknowledge(identity Identity, resultID string) (Turn, error) {
	if identity != t.identity || !t.hasResult || resultID != t.result.ID {
		return t, Correlation
	}
	t.acknowledged = true
	if t.phase == ResultReady {
		t.phase = Delivered
	}
	// An acknowledged unknown remains unknown, never idle or reusable.
	return t, nil
}

// Settle requires affirmative, correlated quiescence after the latest delta.
// Unknown outcomes cannot be reconciled by ordinary cleanup observations.
func (t Turn) Settle(evidence QuiescenceEvidence) (Turn, error) {
	if !t.matches(evidence.Binding) {
		return t, Correlation
	}
	if !t.hasResult || t.result.Outcome == UnknownOutcome {
		return t, Unsettled
	}
	if evidence.ResultID != t.result.ID {
		return t, Correlation
	}
	if !evidence.Confirmed {
		return t, Unsettled
	}
	if evidence.Sequence <= t.lastSequence {
		return t, Sequence
	}
	t.settled = true
	return t, nil
}

// SettlePrepared requires confirmed disposal before a document was bound.
func (t Turn) SettlePrepared(evidence DisposalEvidence) (Turn, error) {
	if !t.reserved || t.reservation != evidence.Reservation {
		return t, Correlation
	}
	if t.bound || t.sendIntent || !t.hasResult || t.result.Outcome != CancelledOutcome {
		return t, Unsettled
	}
	if evidence.ResultID != t.result.ID {
		return t, Correlation
	}
	if !evidence.Confirmed {
		return t, Unsettled
	}
	t.settled = true
	return t, nil
}

func (t Turn) Reusable() bool {
	return t.hasResult && t.result.Outcome != UnknownOutcome && t.acknowledged && t.settled
}

func id(value string) bool {
	if len(value) < 1 || len(value) > 120 || !utf8.ValidString(value) {
		return false
	}
	for _, ch := range value {
		if ch <= 32 || ch == 127 {
			return false
		}
	}
	return true
}

func code(value string) bool {
	if len(value) < 1 || len(value) > 120 {
		return false
	}
	for n, ch := range value {
		if ch >= 'A' && ch <= 'Z' {
			continue
		}
		if n > 0 && ((ch >= '0' && ch <= '9') || ch == '_') {
			continue
		}
		return false
	}
	return true
}

func sha256(value string) bool {
	return len(value) == 64 && strings.IndexFunc(value, func(ch rune) bool {
		return !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))
	}) == -1
}
