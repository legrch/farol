package codex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// Continue starts one new vendor turn after the exact latest completed parent.
// The owning Task service must first persist a new intent with higher-epoch
// admission and a new Farol turn. This producer never mints or advances either.
func (c *Client) Continue(parent context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	return c.continueTurn(parent, d, progress, nil)
}

// prepare stages observed follow-up metadata inside the same dispatch gate. It
// never publishes a partial new lineage or makes a second provider call.
func (c *Client) continueTurn(parent context.Context, d port.Dispatch, progress func(task.Reference) error, prepare func(uint64)) (task.Receipt, error) {
	if !c.followup.valid(c.selection) {
		return refused("TASK_CONTROL_NOT_QUALIFIED"), task.ErrUnsupported
	}
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return refused("CODEX_TASK_UNAVAILABLE"), nil
	}
	defer leave()
	i := d.Intent
	if i.Action != task.Continue || !task.ID(i.OperationID) || !task.ID(i.TaskID) || !task.ID(i.Digest) ||
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
	c.used[i.OperationID] = fingerprint
	if c.dispatchRecheck == nil {
		c.blocked = true
		return unknown(i.Expected), nil
	}
	// A newly owned continuation must not retain the prior dispatch's sink,
	// including while read-only selection/parent witnesses are in flight.
	c.eventMu.Lock()
	c.events = nil
	c.eventMu.Unlock()
	qualified, err := c.qualify(ctx)
	if err != nil {
		return refused("CODEX_SELECTION_UNAVAILABLE"), nil
	}
	m, err := c.rpc(ctx, "thread/read", map[string]any{"threadId": i.Expected.ThreadID, "includeTurns": false})
	if err != nil {
		return refused("CODEX_PARENT_UNAVAILABLE"), nil
	}
	thread, ok := object(m, "thread")
	if !ok || !equals(thread, "id", i.Expected.ThreadID) || !equals(thread, "projectId", i.Binding.ProjectID) ||
		!equals(thread, "cwd", i.Binding.Writer.Path) || !equals(thread, "model", i.Binding.Model) {
		return refused("CODEX_PARENT_MISMATCH"), nil
	}
	if !c.followupTurns(ctx, i.Expected, task.Reference{}) {
		return refused("CODEX_COMPLETED_PARENT_REQUIRED"), nil
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return refused("CODEX_SELECTION_CHANGED"), nil
	}
	ref := i.Expected
	uncertain := func() (task.Receipt, error) { c.blocked = true; return unknown(ref), nil }
	kind := "readOnly"
	if c.selection.Sandbox == "workspace-write" {
		kind = "workspaceWrite"
	}
	policy := map[string]any{"type": kind, "networkAccess": false}
	if c.selection.Sandbox == "workspace-write" {
		policy["writableRoots"] = []string{i.Binding.Writer.Path}
	}
	params := map[string]any{"threadId": i.Expected.ThreadID, "input": []any{map[string]any{"type": "text", "text": d.Message}}, "cwd": i.Binding.Writer.Path, "model": i.Binding.Model, "approvalPolicy": c.selection.ApprovalPolicy, "sandboxPolicy": policy}
	if i.Binding.Effort != "" {
		params["effort"] = i.Binding.Effort
	}
	// The vendor method has no parent CAS. Pre/post history witnesses detect a
	// changed parent conservatively; any failure from this point is uncertain.
	if prepare != nil {
		prepare(qualified.epoch)
	}
	m, err = c.mutationRPC(ctx, "turn/start", params, i, qualified)
	if err != nil {
		return uncertain()
	}
	turn, ok := object(m, "turn")
	id, haveID := str(turn, "id")
	if !ok || !haveID || !providerID(id) || id == i.Expected.TurnID {
		return uncertain()
	}
	ref.TurnID = id
	if err := publish(progress, ref); err != nil {
		return uncertain()
	}
	if !c.followupTurns(ctx, i.Expected, ref) {
		return uncertain()
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return uncertain()
	}
	return task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, nil
}

// followupTurns checks the exact descending prefix, not an arbitrary matching
// historical turn. A cursor is allowed: older history does not affect the pair.
func (c *Client) followupTurns(ctx context.Context, parent, started task.Reference) bool {
	limit := 1
	if started != (task.Reference{}) {
		limit = 2
	}
	m, err := c.rpc(ctx, "thread/turns/list", map[string]any{"threadId": parent.ThreadID, "cursor": nil, "limit": limit, "sortDirection": "desc", "itemsView": "notLoaded"})
	if err != nil {
		return false
	}
	rows, ok := array(m, "data", limit)
	if !ok || len(rows) != limit {
		return false
	}
	if _, _, ok := next(m); !ok {
		return false
	}
	last, err := parse(rows[limit-1])
	if err != nil || !equals(last, "id", parent.TurnID) || !equals(last, "status", "completed") {
		return false
	}
	if limit == 2 {
		first, err := parse(rows[0])
		if err != nil || !equals(first, "id", started.TurnID) {
			return false
		}
		if _, ok := turnLifecycle(first); !ok {
			return false
		}
	}
	return true
}
