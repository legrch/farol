// Package contextbudget selects complete source exchanges. It owns no transcript,
// permission, provider session, delivery acknowledgement or operation dispatcher.
package contextbudget

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

type Code string

func (c Code) Error() string { return string(c) }

// Failure retains exact unanswered call identities when no valid provider
// request can be emitted. Pending is not promoted into a known tool outcome.
type Failure struct {
	Code       Code
	Unresolved []UnknownReference
}

func (f *Failure) Error() string { return string(f.Code) }
func (f *Failure) Unwrap() error { return f.Code }

const (
	Invalid          Code = "CHAT_CONTEXT_INVALID"
	SourceLimit      Code = "CHAT_CONTEXT_SOURCE_LIMIT"
	Pairing          Code = "CHAT_CONTEXT_PAIRING"
	Incomplete       Code = "CHAT_CONTEXT_INCOMPLETE"
	RequiredTooLarge Code = "CHAT_CONTEXT_REQUIRED_TOO_LARGE"
	EstimateFailed   Code = "CHAT_CONTEXT_ESTIMATE_FAILED"
	Stale            Code = "CHAT_CONTEXT_STALE"
)

// Hard ingestion limits are independent of the outbound model budget.
const MaxEvents = 8192
const MaxEventBytes = 64 * 1024
const MaxSourceBytes = 16 * 1024 * 1024
const MaxWindowBytes = 4 * 1024 * 1024

type Binding struct {
	ProfileID, BackendGeneration, OwnerID                 string
	AccountID, Provider, ModelID, Effort, CapabilityEpoch string
}

func ID(s string) bool {
	return len(s) > 0 && len(s) <= 120 && utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool { return r <= 32 || r == 127 }) == -1
}
func (b Binding) Valid() bool {
	for _, s := range []string{b.ProfileID, b.BackendGeneration, b.OwnerID, b.AccountID, b.Provider, b.ModelID, b.Effort, b.CapabilityEpoch} {
		if !ID(s) {
			return false
		}
	}
	return true
}

type Turn struct {
	SessionID, TaskID, ParticipantID, TurnID, OperationID string
	TaskEpoch, TurnGeneration                             uint64
}

func (t Turn) Valid() bool {
	return ID(t.SessionID) && ID(t.TaskID) && ID(t.ParticipantID) && ID(t.TurnID) && ID(t.OperationID) && t.TaskEpoch > 0 && t.TurnGeneration > 0
}

type Kind string

const (
	Instruction Kind = "instruction"
	User        Kind = "user"
	Assistant   Kind = "assistant"
	Call        Kind = "function_call"
	Result      Kind = "function_result"
)

type Outcome string

const (
	Completed Outcome = "COMPLETED"
	Failed    Outcome = "FAILED"
	Refused   Outcome = "REFUSED"
	Cancelled Outcome = "CANCELLED"
	Unknown   Outcome = "UNKNOWN"
	Pending   Outcome = "PENDING"
)

type Event struct {
	ID                            string
	Sequence                      uint64
	Turn                          Turn
	Kind                          Kind
	Text                          string
	CallID, ToolOperationID, Name string
	Outcome                       Outcome
}

// UnknownReference is source identity, never summary prose or a retry grant.
type UnknownReference struct {
	Turn                                                Turn
	CallID, ToolOperationID, CallEventID, ResultEventID string
	Outcome                                             Outcome
}
type Source struct {
	Binding  Binding
	Revision uint64
	Events   []Event
}
type SourceRef struct {
	Binding                               Binding
	Revision, FirstSequence, LastSequence uint64
	FirstEventID, LastEventID, SHA256     string
}

func Digest(s string) bool {
	return len(s) == 64 && strings.IndexFunc(s, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) == -1
}
func (r SourceRef) Valid() bool {
	return r.Binding.Valid() && r.Revision > 0 && r.FirstSequence > 0 && r.LastSequence >= r.FirstSequence && ID(r.FirstEventID) && ID(r.LastEventID) && Digest(r.SHA256)
}

type Metrics struct{ Bytes, CodePoints, EstimatedTokens int }
type Policy struct {
	Limit Metrics
	// Reservations include transport envelope/system overhead in addition to
	// response and tool space. Instructions in Events are also counted.
	Reserve Metrics
}
type Estimator interface{ EstimateTokens(string) (int, error) }

func (p Policy) Valid() bool {
	return p.Limit.Bytes > 0 && p.Limit.Bytes <= MaxWindowBytes && p.Limit.CodePoints > 0 && p.Limit.CodePoints <= MaxWindowBytes && p.Limit.EstimatedTokens > 0 && p.Limit.EstimatedTokens <= MaxWindowBytes && p.Reserve.Bytes >= 0 && p.Reserve.CodePoints >= 0 && p.Reserve.EstimatedTokens >= 0 && p.Reserve.Bytes < p.Limit.Bytes && p.Reserve.CodePoints < p.Limit.CodePoints && p.Reserve.EstimatedTokens < p.Limit.EstimatedTokens
}
func (p Policy) Fits(m Metrics) bool {
	return p.Valid() && m.Bytes >= 0 && m.CodePoints >= 0 && m.EstimatedTokens >= 0 && m.Bytes <= p.Limit.Bytes-p.Reserve.Bytes && m.CodePoints <= p.Limit.CodePoints-p.Reserve.CodePoints && m.EstimatedTokens <= p.Limit.EstimatedTokens-p.Reserve.EstimatedTokens
}
func add(a, b Metrics) Metrics {
	return Metrics{a.Bytes + b.Bytes, a.CodePoints + b.CodePoints, a.EstimatedTokens + b.EstimatedTokens}
}
func measure(raw []byte, e Estimator) (Metrics, error) {
	n, err := e.EstimateTokens(string(raw))
	if err != nil || n < 0 || n > MaxSourceBytes {
		return Metrics{}, EstimateFailed
	}
	return Metrics{len(raw), utf8.RuneCount(raw), n}, nil
}

// Summary cannot carry an instruction role or replace original event identity.
type Summary struct {
	Source        SourceRef
	PromptVersion string
	Trust         string
	Text          string
}

const Untrusted = "untrusted-source-summary"

type Window struct {
	Source        SourceRef
	Events        []Event
	Unresolved    []UnknownReference
	Summary       *Summary
	Usage         Metrics
	OmittedEvents int
}
type Checkpoint struct {
	Version         int
	ID, OperationID string
	Window          Window
}

// CanonicalSource covers every original event and the full account/model binding.
// The concrete SHA-256 implementation is injected by the application owner.
func CanonicalSource(s Source) ([]byte, error) {
	if _, _, err := group(s); err != nil {
		return nil, err
	}
	return json.Marshal(s)
}
