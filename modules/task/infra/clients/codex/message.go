package codex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"sync/atomic"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// steerWitness exists only inside the original dispatch gate. A terminal notice
// invalidates its exact target while qualification or the pre-write hook awaits.
// It is neither persistent admission nor a substitute for the vendor turn CAS.
type steerWitness struct {
	ref    task.Reference
	closed atomic.Bool
}

// Message steers one exact active vendor turn through the existing Task owner.
// The trusted handoff schema selection covers turn/steer and its expectedTurnId
// precondition; unlike Continue, it needs no descending-history schema witness.
func (c *Client) Message(parent context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return refused("CODEX_TASK_UNAVAILABLE"), nil
	}
	defer leave()
	i := d.Intent
	if i.Action != task.Message || !task.ID(i.OperationID) || !task.ID(i.TaskID) || !task.ID(i.Digest) ||
		i.Binding != c.selection.Binding || !i.Parent.Valid() || !i.Admission.Valid() || i.Admission.TaskID != i.TaskID ||
		!i.Expected.Complete(task.Codex) || !providerID(i.Expected.ThreadID) || !providerID(i.Expected.TurnID) ||
		!task.Text(d.Message, 8192) || strings.TrimSpace(d.Message) == "" || progress == nil {
		return refused("CODEX_TASK_INVALID"), nil
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return refused("CODEX_TASK_INVALID"), nil
	}
	fingerprint := sha256.Sum256(raw)
	if old, ok := c.used[i.OperationID]; ok {
		if old != fingerprint {
			return refused("CODEX_OPERATION_CONFLICT"), nil
		}
		return unknown(i.Expected), nil
	}
	if c.blocked {
		return unknown(i.Expected), nil
	}
	if len(c.used) >= maxOperations {
		return refused("CODEX_OPERATION_CAPACITY"), nil
	}
	// The owning journal has already persisted the intent. Retain the shared
	// bounded local fence before all awaited qualification and history reads.
	c.used[i.OperationID] = fingerprint
	if c.dispatchRecheck == nil {
		c.blocked = true
		return unknown(i.Expected), nil
	}
	witness := &steerWitness{ref: i.Expected}
	c.steer.Store(witness)
	defer c.steer.CompareAndSwap(witness, nil)
	qualified, err := c.qualify(ctx)
	if err != nil {
		return refused("CODEX_SELECTION_UNAVAILABLE"), nil
	}
	if err := readThread(ctx, c.rpc, i.Binding, i.Expected.ThreadID); err != nil {
		return refused("CODEX_PARENT_MISMATCH"), nil
	}
	if !c.activeTurn(ctx, i.Expected) || witness.closed.Load() {
		return refused("CODEX_ACTIVE_TURN_REQUIRED"), nil
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return refused("CODEX_SELECTION_CHANGED"), nil
	}
	uncertain := func() (task.Receipt, error) { c.blocked = true; return unknown(i.Expected), nil }
	// Every error from this write boundary is uncertain. No RPC error, missing
	// ACK or callback failure attests that the vendor did not accept the input.
	m, err := c.mutationRPC(ctx, "turn/steer", map[string]any{
		"threadId": i.Expected.ThreadID, "expectedTurnId": i.Expected.TurnID,
		"input": []any{map[string]any{"type": "text", "text": d.Message}},
	}, i, qualified)
	if err != nil || !equals(m, "turnId", i.Expected.TurnID) {
		return uncertain()
	}
	if err := publish(progress, i.Expected); err != nil {
		return uncertain()
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return uncertain()
	}
	// Running describes this nonterminal control acknowledgement only. A turn
	// may already have completed after accepting the steer; only Observe and
	// the original execution-event owner can provide that terminal evidence.
	return task.Receipt{State: task.Known, Reference: i.Expected, Lifecycle: task.Running}, nil
}

func (c *Client) steerCurrent(ref task.Reference) error {
	witness := c.steer.Load()
	if witness == nil || witness.ref != ref || witness.closed.Load() {
		return task.ErrUnknown
	}
	return nil
}

// activeTurn establishes a unique active target through bounded vendor pages.
// The vendor expectedTurnId precondition is still required after this read.
func (c *Client) activeTurn(ctx context.Context, ref task.Reference) bool {
	var cursor any
	cursors := map[string]bool{}
	ids := map[string]bool{}
	active := ""
	for page := 0; page < maxPages; page++ {
		m, err := c.rpc(ctx, "thread/turns/list", map[string]any{"threadId": ref.ThreadID, "cursor": cursor, "limit": pageSize, "itemsView": "notLoaded"})
		if err != nil {
			return false
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return false
		}
		for _, raw := range rows {
			row, err := parse(raw)
			id, haveID := str(row, "id")
			lifecycle, valid := turnLifecycle(row)
			if err != nil || !haveID || !providerID(id) || ids[id] || !valid {
				return false
			}
			ids[id] = true
			if lifecycle == task.Running {
				if active != "" {
					return false
				}
				active = id
			}
		}
		nextCursor, done, valid := next(m)
		if !valid {
			return false
		}
		if done {
			return active == ref.TurnID
		}
		if cursors[nextCursor] {
			return false
		}
		cursors[nextCursor] = true
		cursor = nextCursor
	}
	return false
}
