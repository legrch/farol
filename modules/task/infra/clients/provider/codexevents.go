package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"sync"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/domain"
)

// CodexEventSelection comes from the existing selected connection AFTER exact
// dispatch lineage is retained. It grants no authority and never opens transport.
type CodexEventSelection struct {
	Binding                     task.Binding
	RunID, DispatchID, StreamID string
	Generation                  uint64
	Reference                   task.Reference
}
type CodexEvents struct {
	mu       sync.Mutex
	selected CodexEventSelection
	recheck  func(context.Context, task.Binding) error
	record   func(context.Context, task.ExecutionEvent) error
	now      func() uint64
}

func NewCodexEvents(selected CodexEventSelection, recheck func(context.Context, task.Binding) error, record func(context.Context, task.ExecutionEvent) error, now func() uint64) (*CodexEvents, error) {
	if !selected.Binding.Valid() || selected.Binding.Provider != task.Codex || !selected.Reference.Complete(task.Codex) || !task.ID(selected.RunID) || !task.ID(selected.DispatchID) || !task.ID(selected.StreamID) || selected.Generation == 0 || recheck == nil || record == nil || now == nil {
		return nil, task.ErrInvalid
	}
	return &CodexEvents{selected: selected, recheck: recheck, record: record, now: now}, nil
}

// Record consumes one actual App Server notification. Source sequence is the
// trusted transport receive position; JSON has no authority/sequence selectors.
// No transcript, command, arguments, output or reasoning is persisted.
func (c *CodexEvents) Record(ctx context.Context, sequence uint64, raw []byte) (err error) {
	defer func() {
		if recover() != nil {
			err = task.ErrUnknown
		}
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	if ctx == nil || ctx.Err() != nil {
		return task.ErrUnavailable
	}
	if err := c.recheck(ctx, c.selected.Binding); err != nil {
		return err
	}
	e, err := c.decode(raw)
	if err != nil {
		return err
	}
	if e.Kind == "" {
		return nil
	}
	e.SourceSequence = sequence
	e.TimestampMillis = c.now()
	if !e.Valid(task.Codex) {
		return task.ErrInvalid
	}
	if err := c.record(ctx, e); err != nil {
		return err
	}
	return c.recheck(ctx, c.selected.Binding)
}
func eventObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var result map[string]json.RawMessage
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, task.ErrInvalid
	}
	return result, nil
}
func eventString(m map[string]json.RawMessage, key string) string {
	var s string
	_ = json.Unmarshal(m[key], &s)
	return s
}
func (c *CodexEvents) decode(raw []byte) (task.ExecutionEvent, error) {
	if len(raw) == 0 || len(raw) > 65536 || !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 || strictEventJSON(raw) != nil {
		return task.ExecutionEvent{}, task.ErrInvalid
	}
	m, err := eventObject(raw)
	if err != nil {
		return task.ExecutionEvent{}, err
	}
	if _, ok := m["id"]; ok {
		return task.ExecutionEvent{}, task.ErrUnsupported
	} // A request is never approval progress.
	method := eventString(m, "method")
	switch method {
	case "turn/started", "turn/completed", "item/started", "item/completed", "turn/plan/updated":
	default:
		return task.ExecutionEvent{}, nil
	}
	params, err := eventObject(m["params"])
	if err != nil {
		return task.ExecutionEvent{}, err
	}
	ref := c.selected.Reference
	if eventString(params, "threadId") != ref.ThreadID {
		return task.ExecutionEvent{}, task.ErrIdentity
	}
	e := task.ExecutionEvent{RunID: c.selected.RunID, DispatchID: c.selected.DispatchID, StreamID: c.selected.StreamID, Generation: c.selected.Generation, Reference: ref, Source: task.RuntimeEvidence}
	if method == "turn/started" || method == "turn/completed" {
		turn, err := eventObject(params["turn"])
		if err != nil || eventString(turn, "id") != ref.TurnID {
			return e, task.ErrIdentity
		}
		e.Kind = task.ProviderStarted
		if method == "turn/completed" {
			switch eventString(turn, "status") {
			case "completed", "failed", "interrupted":
			default:
				return e, task.ErrInvalid
			}
			e.Kind = task.ProviderTerminal
			e.ReportedLifecycle = task.Lifecycle(eventString(turn, "status"))
		}
	} else {
		if eventString(params, "turnId") != ref.TurnID {
			return e, task.ErrIdentity
		}
		if method == "turn/plan/updated" {
			var plan []map[string]json.RawMessage
			if bytes.Equal(bytes.TrimSpace(params["plan"]), []byte("null")) || json.Unmarshal(params["plan"], &plan) != nil || len(plan) > 128 {
				return e, task.ErrInvalid
			}
			e.Kind, e.Source, e.ItemID, e.PlanSteps = task.CheckpointReady, task.AdvisoryEvidence, "plan", uint16(len(plan))
			for _, step := range plan {
				switch eventString(step, "status") {
				case "completed":
					e.CompletedSteps++
				case "pending", "inProgress":
				default:
					return e, task.ErrInvalid
				}
			}
		} else {
			item, err := eventObject(params["item"])
			if err != nil {
				return e, err
			}
			e.ItemID = eventString(item, "id")
			switch eventString(item, "type") {
			case "commandExecution", "dynamicToolCall", "mcpToolCall", "fileChange":
				e.Kind = task.ToolStarted
				if method == "item/completed" {
					e.Kind = task.ToolFinished
					if eventString(item, "type") == "commandExecution" && eventString(item, "status") == "completed" && !bytes.Equal(bytes.TrimSpace(item["exitCode"]), []byte("null")) && len(item["exitCode"]) > 0 {
						if json.Unmarshal(item["exitCode"], &e.ExitCode) != nil || e.ExitCode < 0 || e.ExitCode > 255 {
							return e, task.ErrInvalid
						}
						e.HasExitCode = true
						e.Source = task.ToolReceiptEvidence
					}
				}
			case "agentMessage":
				if method != "item/completed" {
					return task.ExecutionEvent{}, nil
				}
				e.Kind, e.Source = task.ModelClaim, task.AdvisoryEvidence
			default:
				return task.ExecutionEvent{}, nil // Reasoning and token deltas are deliberately ignored.
			}
		}
	}
	if e.ItemID != "" && !codexFactID(e.ItemID) {
		return e, task.ErrInvalid
	}
	// Item/turn facts have a stable identity independent of their evidence values:
	// a contradictory repeated completion must conflict, not become a new event.
	// Plan notifications lack an item revision, so their compact counts identify
	// distinct advisory snapshots. Private bodies never enter either identity.
	key := e
	key.Source, key.HasExitCode, key.ExitCode, key.ReportedLifecycle = "", false, 0, ""
	identity, _ := json.Marshal(key)
	sum := sha256.Sum256(identity)
	e.EventID = hex.EncodeToString(sum[:])
	return e, nil
}
func strictEventJSON(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	count := 0
	var read func(int) error
	read = func(depth int) error {
		count++
		if depth > 32 || count > 8192 {
			return task.ErrInvalid
		}
		token, err := d.Token()
		if err != nil {
			return task.ErrInvalid
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return task.ErrInvalid
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return task.ErrInvalid
				}
				seen[name] = true
				if err := read(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return task.ErrInvalid
			}
		case '[':
			for d.More() {
				if err := read(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return task.ErrInvalid
			}
		default:
			return task.ErrInvalid
		}
		return nil
	}
	if err := read(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return task.ErrInvalid
	}
	return nil
}

func codexFactID(s string) bool {
	if len(s) == 0 || len(s) > 120 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
