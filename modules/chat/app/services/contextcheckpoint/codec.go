package contextcheckpoint

import (
	"bytes"
	"encoding/json"
	"github.com/legrch/farol/modules/chat/domain/contextbudget"
)

const MaxCheckpointBytes = 8 * 1024 * 1024

// A typed port response remains untrusted and must be bounded BEFORE copying or
// encoding it. This also protects callers that did not use DecodeCheckpoint.
func boundedWindow(w contextbudget.Window) bool {
	if !w.Source.Valid() || len(w.Events) > contextbudget.MaxEvents || len(w.Unresolved) > contextbudget.MaxEvents || w.Usage.Bytes < 0 || w.Usage.Bytes > MaxCheckpointBytes || w.Usage.CodePoints < 0 || w.Usage.CodePoints > MaxCheckpointBytes || w.Usage.EstimatedTokens < 0 || w.Usage.EstimatedTokens > MaxCheckpointBytes {
		return false
	}
	total := 0
	turnBytes := func(t contextbudget.Turn) int {
		return len(t.SessionID) + len(t.TaskID) + len(t.ParticipantID) + len(t.TurnID) + len(t.OperationID)
	}
	for _, e := range w.Events {
		if !contextbudget.ID(e.ID) || len(e.Text) > contextbudget.MaxEventBytes || len(e.Kind) > 120 || len(e.Outcome) > 120 || len(e.CallID) > 120 || len(e.ToolOperationID) > 120 || len(e.Name) > 120 || (e.Kind != contextbudget.Instruction && !e.Turn.Valid()) {
			return false
		}
		if e.Kind == contextbudget.Instruction && e.Turn != (contextbudget.Turn{}) {
			return false
		}
		// Raw string bytes are a lower bound on JSON size. Estimated fixed
		// overhead must not reject a valid checkpoint that admission accepts.
		total += len(e.Text) + len(e.ID) + len(e.CallID) + len(e.ToolOperationID) + len(e.Name) + len(e.Kind) + len(e.Outcome) + turnBytes(e.Turn)
		if total > MaxCheckpointBytes {
			return false
		}
	}
	for _, u := range w.Unresolved {
		if !u.Turn.Valid() || !contextbudget.ID(u.CallID) || !contextbudget.ID(u.ToolOperationID) || !contextbudget.ID(u.CallEventID) || !contextbudget.ID(u.ResultEventID) || u.Outcome != contextbudget.Unknown {
			return false
		}
		total += len(u.CallID) + len(u.ToolOperationID) + len(u.CallEventID) + len(u.ResultEventID) + len(u.Outcome) + turnBytes(u.Turn)
		if total > MaxCheckpointBytes {
			return false
		}
	}
	if w.Summary != nil {
		v := w.Summary
		if v.Source != w.Source || len(v.Text) > contextbudget.MaxEventBytes || !contextbudget.ID(v.PromptVersion) || v.Trust != contextbudget.Untrusted {
			return false
		}
		total += len(v.Text)
		if total > MaxCheckpointBytes {
			return false
		}
	}
	return true
}

// DecodeCheckpoint is an untrusted storage/import boundary. Closed decoding
// rejects invented permission/instruction fields instead of interpreting them.
// Semantic acceptance still requires Recover against the current original source.
func DecodeCheckpoint(raw []byte) (contextbudget.Checkpoint, error) {
	if len(raw) == 0 || len(raw) > MaxCheckpointBytes || !json.Valid(raw) {
		return contextbudget.Checkpoint{}, Invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var checkpoint contextbudget.Checkpoint
	if decoder.Decode(&checkpoint) != nil || checkpoint.Version != 1 || !contextbudget.ID(checkpoint.ID) || !contextbudget.ID(checkpoint.OperationID) || !boundedWindow(checkpoint.Window) {
		return contextbudget.Checkpoint{}, Invalid
	}
	return checkpoint, nil
}
