// Package connector owns the closed, original explicit connection-test
// attempt. This is not a connector grant or proof of provider authentication.
// Host effects are described here only by immutable values.
package connector

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const MaxEntries = 48

type Phase string

const (
	Claimed           Phase = "claimed"
	Prepared          Phase = "prepared"
	DispatchIntent    Phase = "dispatch_intent"
	SendAcknowledged  Phase = "send_acknowledged"
	Verified          Phase = "verified"
	RefusedBeforeSend Phase = "refused_before_send"
	OutcomeUnknown    Phase = "outcome_unknown"
)

type Mode string

const (
	Bootstrap Mode = "bootstrap"
	Status    Mode = "status"
)

var (
	ErrRefused  = errors.New("COMPUTER_CONNECTION_CHECK_REFUSED")
	ErrPending  = errors.New("COMPUTER_CONNECTION_CHECK_PENDING")
	ErrCapacity = errors.New("COMPUTER_CONNECTION_CHECK_CAPACITY")
	ErrUnknown  = errors.New("COMPUTER_CONNECTION_CHECK_OUTCOME_UNKNOWN")
)
var uuid = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
var digest = regexp.MustCompile("^[0-9a-f]{64}$")
var identity = regexp.MustCompile("^[A-Za-z0-9._:/-]{1,120}$")

// Request is captured BEFORE mode/scope resolution. Its fingerprint covers the
// validated immutable caller command and route identity. Same ID with different
// fingerprint never becomes a fresh attempt after a lost reply.
type Request struct {
	OperationID string `json:"operationId"`
	Fingerprint string `json:"fingerprint"`
	ProfileID   string `json:"profileId"`
	OwnerID     string `json:"ownerId"`
	ComputerID  string `json:"computerId"`
}

// Scope is selected exactly once by the Go owner after trusted host preflight.
// It cannot be inferred from a prior attachment or changed after dispatch.
type Scope struct {
	Mode                Mode   `json:"mode"`
	ScopeDigest         string `json:"scopeDigest"`
	BuildID             string `json:"buildId"`
	BackendGeneration   string `json:"backendGeneration"`
	RuntimeID           string `json:"runtimeId"`
	ConnectorGeneration string `json:"connectorGeneration"`
	ComputerGeneration  string `json:"computerGeneration"`
	TunnelID            string `json:"tunnelId"`
	AppName             string `json:"appName"`
	WorkspaceID         string `json:"workspaceId"`
	ChallengeDigest     string `json:"challengeDigest"`
	Challenge           string `json:"challenge,omitempty"`
	AttachmentDigest    string `json:"attachmentDigest"`
	CheckID             string `json:"checkId"`
	Model               string `json:"model"`
	PromptDigest        string `json:"promptDigest"`
	// Older retained attempts may lack this field. They remain observation-only;
	// a new preparation and every new Send require the exact document digest.
	DocumentDigest string `json:"documentDigest,omitempty"`
}

type Receipt struct {
	CheckID string `json:"checkId"`
	Kind    string `json:"kind"`
	Digest  string `json:"digest"`
}

// Entry is the durable source of truth. A terminal response is separate from
// historical delivery to the original UI. Unknown effects remain restricted.
type Entry struct {
	Request Request  `json:"request"`
	Phase   Phase    `json:"phase"`
	Scope   *Scope   `json:"scope,omitempty"`
	Receipt *Receipt `json:"receipt,omitempty"`
}

type Journal struct {
	Entries []Entry `json:"entries"`
}

func ValidRequest(r Request) bool {
	return uuid.MatchString(r.OperationID) && digest.MatchString(r.Fingerprint) &&
		identity.MatchString(r.ProfileID) && identity.MatchString(r.OwnerID) &&
		identity.MatchString(r.ComputerID)
}
func ValidScope(s Scope) bool {
	if (s.Mode != Bootstrap && s.Mode != Status) ||
		!digest.MatchString(s.ScopeDigest) || !digest.MatchString(s.BuildID) ||
		!identity.MatchString(s.BackendGeneration) || !identity.MatchString(s.RuntimeID) ||
		!identity.MatchString(s.ConnectorGeneration) || !identity.MatchString(s.ComputerGeneration) ||
		!identity.MatchString(s.TunnelID) || s.AppName == "" ||
		len(s.AppName) > 120 || strings.ContainsAny(s.AppName, "\n\r\t") ||
		s.Model != "temporary-instant" ||
		!digest.MatchString(s.ChallengeDigest) || !digest.MatchString(s.PromptDigest) {
		return false
	}
	if s.DocumentDigest != "" && !digest.MatchString(s.DocumentDigest) {
		return false
	}
	if s.WorkspaceID != "" && !identity.MatchString(s.WorkspaceID) {
		return false
	}
	if s.Mode == Status {
		return uuid.MatchString(s.CheckID) && digest.MatchString(s.AttachmentDigest) && s.Challenge == ""
	}
	if s.CheckID != "" || s.AttachmentDigest != "" ||
		len(s.Challenge) == 0 || len(s.Challenge) > 160 {
		return false
	}
	for _, r := range s.Challenge {
		if r < 33 || r > 126 {
			return false
		}
	}
	h := sha256.Sum256([]byte(s.Challenge))
	return hex.EncodeToString(h[:]) == s.ChallengeDigest
}

// Prompt is a closed, Go-produced document bound to the ORIGINAL operation.
// It selects exactly one app/tool and carries the exact Go-minted status nonce.
func Prompt(scope Scope) string {
	switch scope.Mode {
	case Status:
		return "Use the selected " + strconv.Quote(scope.AppName) +
			" app to call computer_connection_status ONCE with no arguments ({})." +
			" Do not call any other tool. Report the observed result briefly."
	case Bootstrap:
		if scope.WorkspaceID == "" {
			return "Use the selected " + strconv.Quote(scope.AppName) +
				" app to call farol_connector_verify_catalogue ONCE with challenge " +
				strconv.Quote(scope.Challenge) +
				". No workspace is configured. Do not read files or run commands. Report the observed result briefly."
		}
		return "Use the selected " + strconv.Quote(scope.AppName) +
			" app to call farol_connector_verify ONCE with challenge " +
			strconv.Quote(scope.Challenge) + " and workspaceId " +
			strconv.Quote(scope.WorkspaceID) +
			". Do not read file contents or run commands. Report the observed result briefly."
	}
	return ""
}
func (p Phase) Terminal() bool {
	return p == Verified || p == RefusedBeforeSend
}

// Settled phases can no longer advance. An unknown outcome is not terminal
// (it never becomes verified), but it no longer blocks a new owner check.
func (p Phase) Settled() bool {
	return p.Terminal() || p == OutcomeUnknown
}
func (e Entry) Valid() bool {
	if !ValidRequest(e.Request) {
		return false
	}
	if e.Scope != nil && !ValidScope(*e.Scope) {
		return false
	}
	if e.Receipt != nil {
		if !digest.MatchString(e.Receipt.Digest) || (e.Receipt.Kind != "bootstrap" && e.Receipt.Kind != "status") ||
			(e.Scope == nil || e.Scope.CheckID != e.Receipt.CheckID) {
			return false
		}
	}
	switch e.Phase {
	case Claimed:
		return e.Scope == nil && e.Receipt == nil
	case Prepared, DispatchIntent, SendAcknowledged, OutcomeUnknown:
		return e.Scope != nil && e.Receipt == nil
	case RefusedBeforeSend:
		return e.Receipt == nil
	case Verified:
		return e.Scope != nil && e.Receipt != nil && string(e.Scope.Mode) == e.Receipt.Kind
	}
	return false
}
func (j Journal) Valid() bool {
	if j.Entries == nil || len(j.Entries) > MaxEntries {
		return false
	}
	seen := make(map[string]bool)
	unsettled := 0
	for _, e := range j.Entries {
		if !e.Valid() || seen[e.Request.OperationID] {
			return false
		}
		seen[e.Request.OperationID] = true
		if !e.Phase.Settled() {
			unsettled++
		}
	}
	return unsettled <= 1
}
func (j Journal) Clone() Journal {
	out := Journal{Entries: make([]Entry, len(j.Entries))}
	for i, e := range j.Entries {
		out.Entries[i] = e
		if e.Scope != nil {
			s := *e.Scope
			out.Entries[i].Scope = &s
		}
		if e.Receipt != nil {
			r := *e.Receipt
			out.Entries[i].Receipt = &r
		}
	}
	return out
}
func (j Journal) Find(id string) (Entry, bool) {
	for _, e := range j.Entries {
		if e.Request.OperationID == id {
			x := Entry{Request: e.Request, Phase: e.Phase}
			if e.Scope != nil {
				s := *e.Scope
				x.Scope = &s
			}
			if e.Receipt != nil {
				r := *e.Receipt
				x.Receipt = &r
			}
			return x, true
		}
	}
	return Entry{}, false
}
func (j Journal) Pending() bool {
	for _, e := range j.Entries {
		if !e.Phase.Settled() {
			return true
		}
	}
	return false
}
func (j Journal) Begin(req Request) (Journal, bool, error) {
	if !j.Valid() || !ValidRequest(req) {
		return Journal{}, false, ErrRefused
	}
	if old, ok := j.Find(req.OperationID); ok {
		if old.Request != req {
			return Journal{}, false, ErrRefused
		}
		return j.Clone(), false, nil
	}
	// Owner-clicked checks are unlimited. A new click supersedes an earlier
	// attempt that never settled (lost reply, quit mid-test): it is retained as
	// refused-before-send when nothing was prepared, otherwise as unknown. The
	// earlier record is never rewritten to verified and never re-sent.
	out := j.Clone()
	for i, e := range out.Entries {
		out.Entries[i] = settle(e)
	}
	// The journal is bounded history, not a quota: forget the oldest settled
	// attempts so repeated owner checks never hit a capacity refusal.
	for len(out.Entries) >= MaxEntries {
		out.Entries = out.Entries[1:]
	}
	out.Entries = append(out.Entries, Entry{Request: req, Phase: Claimed})
	if !out.Valid() {
		return Journal{}, false, ErrRefused
	}
	return out, true, nil
}

// settle closes an attempt whose process lifetime ended without settling it:
// nothing was prepared means it was never sent; anything later is unknown.
func settle(e Entry) Entry {
	if e.Phase.Settled() {
		return e
	}
	if e.Phase == Claimed {
		e.Phase = RefusedBeforeSend
	} else {
		e.Phase = OutcomeUnknown
	}
	return e
}

// Import absorbs a predecessor journal into this one. The predecessor image
// (0.5.24) reads and writes only its own journal, which this build leaves
// untouched; after a rollback and a roll-forward that journal can hold
// attempts this one has never seen. Each one is appended and settled, because
// the lifetime that could advance it has ended. An attempt both journals know
// must be the same attempt, at most less advanced in the predecessor's copy;
// anything else refuses, it is never merged or guessed.
func (j Journal) Import(legacy Journal) (Journal, error) {
	if !j.Valid() || !legacy.Valid() {
		return Journal{}, ErrRefused
	}
	out := j.Clone()
	for _, e := range legacy.Clone().Entries {
		known, ok := out.Find(e.Request.OperationID)
		if !ok {
			out.Entries = append(out.Entries, settle(e))
			continue
		}
		if known.Request != e.Request ||
			(e.Scope != nil && (known.Scope == nil || *known.Scope != *e.Scope)) ||
			(e.Receipt != nil && (known.Receipt == nil || *known.Receipt != *e.Receipt)) ||
			(e.Phase.Settled() && known.Phase != e.Phase) {
			return Journal{}, ErrRefused
		}
	}
	if !out.Valid() {
		return Journal{}, ErrRefused
	}
	return out, nil
}
func (j Journal) Advance(id string, next Entry) (Journal, error) {
	if !j.Valid() || !next.Valid() || next.Request.OperationID != id {
		return Journal{}, ErrRefused
	}
	out := j.Clone()
	for i, old := range out.Entries {
		if old.Request.OperationID != id {
			continue
		}
		if old.Request != next.Request || old.Phase.Terminal() || old.Phase == OutcomeUnknown ||
			(old.Scope != nil && (next.Scope == nil || *old.Scope != *next.Scope)) ||
			(old.Receipt != nil && (next.Receipt == nil || *old.Receipt != *next.Receipt)) {
			return Journal{}, ErrRefused
		}
		allowed := false
		switch old.Phase {
		case Claimed:
			allowed = next.Phase == Prepared || next.Phase == RefusedBeforeSend
		case Prepared:
			allowed = next.Phase == DispatchIntent || next.Phase == RefusedBeforeSend
		case DispatchIntent:
			// A matching Go-socket receipt is stronger than a lost browser Send
			// acknowledgement. It may close the original WITHOUT redispatch.
			allowed = next.Phase == SendAcknowledged ||
				next.Phase == Verified || next.Phase == OutcomeUnknown
		case SendAcknowledged:
			allowed = next.Phase == Verified || next.Phase == OutcomeUnknown
		}
		if !allowed {
			return Journal{}, ErrRefused
		}
		if next.Phase == Verified && next.Receipt == nil {
			return Journal{}, ErrRefused
		}
		out.Entries[i] = next
		if !out.Valid() {
			return Journal{}, ErrRefused
		}
		return out, nil
	}
	return Journal{}, ErrRefused
}
