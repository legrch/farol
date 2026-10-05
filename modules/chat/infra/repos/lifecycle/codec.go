package lifecycle

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// These storage records are private to the adapter, never root wire DTOs or
// startup admission proof. No prompt/answer/raw error field exists.
type record struct {
	Root         port.JournalRoot      `json:"root"`
	Incarnations []string              `json:"incarnations"`
	Retirement   *port.RetirementWrite `json:"retirement"`
	Version      int                   `json:"version"`
	Scope        port.JournalScope     `json:"scope"`
	Writes       []port.JournalWrite   `json:"writes"`
}

func encode(value record, limits Limits) ([]byte, error) {
	if err := validate(value, limits); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > limits.Bytes {
		return nil, Invalid
	}
	return raw, nil
}
func decode(raw []byte, limits Limits) (record, error) {
	if !validLimits(limits) || len(raw) == 0 || len(raw) > limits.Bytes || !utf8.Valid(raw) {
		return record{}, Invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var value record
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		return record{}, Invalid
	}
	canonical, err := encode(value, limits)
	// Exact canonical bytes reject duplicate keys, alternate number encodings,
	// ambiguous null/omitted fields, malformed Unicode and trailing JSON.
	if err != nil || !bytes.Equal(raw, canonical) {
		return record{}, Invalid
	}
	return value, nil
}

// Replay is ONLY validation of stored queue transitions. Its queue/registry never
// escapes this function, creates a Handle or supplies current admission.
func validate(value record, limits Limits) error {
	if !validLimits(limits) || (value.Version != 2 && value.Version != 3) || value.Root.Device == 0 || value.Root.Inode == 0 || !validIncarnations(value.Incarnations, value.Scope, limits) || value.Writes == nil || len(value.Writes) > limits.Records {
		return Invalid
	}
	q, err := turn.NewQueue(value.Scope.ProfileID, value.Scope.BackendGeneration)
	if err != nil {
		return Invalid
	}
	bindings := make(map[string]port.TurnBinding)
	promoted := make(map[string]bool)
	pending := port.JournalEntry{}
	proofs := make(map[string]port.RetirementTurn)
	unresolvedCalls := make(map[string]string)
	for n, w := range value.Writes {
		if w.Scope != value.Scope || w.PreviousRevision != uint64(n) || w.Revision != uint64(n)+1 {
			return Invalid
		}
		e := w.Entry
		if p := e.ResultPublication; p != (port.ResultPublication{}) {
			if value.Version != 3 || !p.Valid() || p.Root != value.Root || (e.Kind != "finish" && e.Kind != "send-settled") || e.Before.HasResult || !e.After.HasResult {
				return Invalid
			}
		}
		if !validBinding(e.Binding, value.Scope) {
			return Invalid
		}
		if (e.Kind != "settle" && e.Quiescence != (turn.QuiescenceEvidence{})) || (e.Kind != "settle-prepared" && e.Disposal != (turn.DisposalEvidence{})) {
			return Invalid
		}
		i := identity(e.Binding)
		if e.Kind == "admit" {
			if _, exists := bindings[i.OperationID]; exists || e.Before != (turn.Snapshot{}) || e.CallID != "" || e.Effect != "" || e.Closed || pending.Effect != "" {
				return Invalid
			}
			after, err := q.Admit(i, e.IntentDigest)
			if err != nil || after != e.After {
				return Invalid
			}
			bindings[i.OperationID] = e.Binding
			proofs[i.OperationID] = port.RetirementTurn{Binding: e.Binding, Snapshot: after}
			continue
		}
		if bindings[i.OperationID] != e.Binding || (e.Kind != "promote-conversation" && e.IntentDigest != "") {
			return Invalid
		}
		before, err := q.Snapshot(i)
		if err != nil || before != e.Before {
			return Invalid
		}
		if e.Kind == "promote-conversation" {
			if promoted[i.OperationID] || before.Phase != turn.Admitted || before.Reserved || before.Bound || before.SendIntent || before.HasResult || before.OutstandingCallID != "" || e.After.Phase != turn.Pending || !validIntentDigest(e.IntentDigest) {
				return Invalid
			}
			promoted[i.OperationID] = true
		}
		if pending.Effect != "" && (pending.Binding != e.Binding || (pending.Effect == "prepare" && e.Kind != "prepared") || (pending.Effect == "send" && e.Kind != "send-settled")) {
			return Invalid
		}
		if e.Kind != "request-computer" && e.Kind != "resolve-computer" && e.CallID != "" {
			return Invalid
		}
		after, err := transition(q, e, before, pending)
		if err != nil || after != e.After || e.Closed != after.HasResult {
			return Invalid
		}
		expectedEffect := ""
		if e.Kind == "reserve" {
			expectedEffect = "prepare"
		}
		if e.Kind == "dispatch" {
			expectedEffect = "send"
		}
		if e.Effect != expectedEffect {
			return Invalid
		}
		proof := proofs[i.OperationID]
		proof.Snapshot = after
		if !before.HasResult && after.HasResult {
			proof.ResultPublication = e.ResultPublication
		}
		switch e.Kind {
		case "request-computer":
			unresolvedCalls[i.OperationID] = e.CallID
		case "resolve-computer":
			delete(unresolvedCalls, i.OperationID)
		case "acknowledge":
			if proof.AcknowledgedRevision == 0 {
				proof.AcknowledgedRevision = w.Revision
			}
		case "settle":
			if proof.SettledRevision == 0 {
				proof.Quiescence, proof.SettledRevision = e.Quiescence, w.Revision
			}
		case "settle-prepared":
			if proof.SettledRevision == 0 {
				proof.Disposal, proof.SettledRevision = e.Disposal, w.Revision
			}
		case "release":
			proof.ReleasedRevision = w.Revision
		}
		proofs[i.OperationID] = proof
		if expectedEffect != "" {
			pending = e
		} else {
			pending = port.JournalEntry{}
		}
	}
	return validateRetirement(value, limits, proofs, pending.Effect != "" || len(unresolvedCalls) != 0)
}

func transition(q *turn.Queue, e port.JournalEntry, before turn.Snapshot, pending port.JournalEntry) (turn.Snapshot, error) {
	i, b := before.Identity, before.Binding
	switch e.Kind {
	case "enqueue", "promote-conversation":
		return q.Enqueue(i)
	case "reserve":
		r, err := q.Reserve()
		if err != nil || r != e.After.Reservation {
			return turn.Snapshot{}, Invalid
		}
		return q.Snapshot(i)
	case "prepared":
		if pending.Effect != "prepare" {
			return turn.Snapshot{}, Invalid
		}
		after, err := q.Bind(before.Reservation, e.After.Binding.Document)
		if err == nil && e.After.Phase == turn.AwaitingOwner {
			return q.AwaitOwner(after.Binding)
		}
		return after, err
	case "dispatch":
		return q.Dispatch(b)
	case "send-settled":
		if pending.Effect != "send" {
			return turn.Snapshot{}, Invalid
		}
		if e.After.HasResult {
			r := e.After.Result
			if (r.Outcome != turn.Failed || r.Code != "SEND_NOT_SENT") && (r.Outcome != turn.UnknownOutcome || r.Code != "SEND_OUTCOME_UNKNOWN") {
				return turn.Snapshot{}, Invalid
			}
			return q.Finish(b, r)
		}
		return before, nil
	case "accept":
		if b.Document.ProviderState == turn.ProviderHome {
			return q.AcceptConversation(b, e.After.Binding.Document.ConversationID)
		}
		return q.Accept(b)
	case "await-owner":
		return q.AwaitOwner(b)
	case "resume":
		return q.Resume(b)
	case "delta":
		return q.Delta(b, e.After.LastSequence)
	case "request-computer":
		return q.RequestComputer(b, e.CallID)
	case "resolve-computer":
		return q.ResolveComputer(b, e.CallID)
	case "finish":
		if before.HasResult {
			return turn.Snapshot{}, Invalid
		}
		return q.Finish(b, e.After.Result)
	case "cancel":
		return q.Cancel(i, e.After.Result.ID)
	case "acknowledge":
		return q.Acknowledge(i, e.After.Result.ID)
	case "settle":
		return q.Settle(e.Quiescence)
	case "settle-prepared":
		return q.SettlePrepared(e.Disposal)
	case "release":
		if err := q.Release(before.Reservation); err != nil {
			return turn.Snapshot{}, err
		}
		return q.Snapshot(i)
	}
	return turn.Snapshot{}, Invalid
}

func validIntentDigest(digest string) bool {
	return len(digest) == 64 && strings.IndexFunc(digest, func(c rune) bool { return !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) }) == -1
}

func identity(b port.TurnBinding) turn.Identity {
	return turn.Identity{ProfileID: b.ProfileID, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TurnID: b.TurnID, OperationID: b.OperationID, Generation: b.TurnGeneration}
}
func validBinding(b port.TurnBinding, s port.JournalScope) bool {
	if b.ProfileID != s.ProfileID || b.BackendGeneration != s.BackendGeneration || b.TurnGeneration == 0 {
		return false
	}
	for _, v := range []string{b.OwnerID, b.SessionID, b.TaskID, b.ParticipantID, b.TurnID, b.OperationID} {
		if !validID(v) {
			return false
		}
	}
	return true
}
func validID(value string) bool {
	if len(value) < 1 || len(value) > 120 || !utf8.ValidString(value) {
		return false
	}
	return strings.IndexFunc(value, func(ch rune) bool { return ch <= 32 || ch == 127 }) < 0
}
