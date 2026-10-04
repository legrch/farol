package codex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	providerevents "github.com/legrch/farol/modules/task/infra/clients/provider"
)

type eventRoute struct {
	dispatch             port.Dispatch
	ref                  task.Reference
	stream               string
	generation, sequence uint64
	record               func(context.Context, task.ExecutionEvent) error
	queued               []task.ExecutionEvent
}

var _ port.ObservedProvider = (*Client)(nil)

// DispatchObserved uses the same producer and RPC effects as Dispatch. The
// pending turn's compact facts are released only AFTER durable exact lineage.
func (c *Client) DispatchObserved(ctx context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	if progress == nil || record == nil {
		return refused("CODEX_TASK_INVALID"), nil
	}
	var route *eventRoute
	// Callers hold eventMu; installation happens under the existing dispatch
	// gate, after operation ownership and before the one follow-up effect.
	install := func(ref task.Reference, epoch uint64) {
		identity, _ := json.Marshal(struct {
			Selection Selection
			Operation string
		}{c.selection, d.Intent.OperationID})
		hash := sha256.Sum256(identity)
		route = &eventRoute{dispatch: port.Dispatch{Intent: d.Intent}, ref: ref, stream: hex.EncodeToString(hash[:]), generation: epoch + 1, record: record}
		c.events = route
	}
	lineage := func(ref task.Reference) error {
		if err := publish(progress, ref); err != nil {
			return err
		}
		c.eventMu.Lock()
		defer c.eventMu.Unlock()
		if route == nil {
			install(ref, c.connection.epoch.Load())
		}
		if c.events != route || c.connection.epoch.Load()+1 != route.generation || c.guard(c.lifetime) != nil {
			return task.ErrUnknown
		}
		if ref.Complete(task.Codex) {
			// Validate the ENTIRE pending queue before publishing any prefix.
			// A crossed turn remains unknown even if it arrived after valid facts.
			for _, e := range route.queued {
				if e.Reference != ref {
					return task.ErrIdentity
				}
			}
		}
		route.ref = ref
		if ref.Complete(task.Codex) {
			for _, e := range route.queued {
				if err := route.record(c.lifetime, e); err != nil {
					c.events = nil
					return err
				}
			}
			route.queued = nil
		}
		return nil
	}
	var receipt task.Receipt
	var err error
	if d.Intent.Action == task.Continue {
		receipt, err = c.continueTurn(ctx, d, lineage, func(epoch uint64) {
			c.eventMu.Lock()
			defer c.eventMu.Unlock()
			// Thread is selected, but the new turn is not acknowledged yet.
			// This is staging only; progress receives the complete new ref once.
			install(task.Reference{ThreadID: d.Intent.Expected.ThreadID}, epoch)
		})
	} else {
		receipt, err = c.Dispatch(ctx, d, lineage)
	}
	if err != nil || receipt.State != task.Known {
		c.eventMu.Lock()
		if c.events == route {
			c.events = nil
		}
		c.eventMu.Unlock()
	}
	return receipt, err
}
func (c *Client) notification(m map[string]json.RawMessage) error {
	c.eventMu.Lock()
	defer c.eventMu.Unlock()
	route := c.events
	if route == nil {
		return nil
	}
	method, _ := str(m, "method")
	switch method {
	case "turn/started", "turn/completed", "item/started", "item/completed", "turn/plan/updated":
	default:
		return nil
	}
	params, ok := object(m, "params")
	if !ok {
		return protocolError()
	}
	if !equals(params, "threadId", route.ref.ThreadID) {
		return nil
	}
	turnID, _ := str(params, "turnId")
	if method == "turn/started" || method == "turn/completed" {
		turn, ok := object(params, "turn")
		if !ok {
			return protocolError()
		}
		turnID, _ = str(turn, "id")
	}
	if !providerID(turnID) {
		return protocolError()
	}
	if route.dispatch.Intent.Action == task.Continue && turnID == route.dispatch.Intent.Expected.TurnID {
		return nil // Delayed parent traffic never enters the new stream/queue.
	}
	if route.ref.TurnID != "" && turnID != route.ref.TurnID {
		return nil
	}
	if c.connection.epoch.Load()+1 != route.generation || c.guard(c.lifetime) != nil {
		return task.ErrUnknown
	}
	// Project to compact fields BEFORE encoding; large/private tool bodies and
	// reasoning/transcript content never enter the queue or persistence sink.
	projected := map[string]any{"threadId": route.ref.ThreadID, "turnId": turnID}
	switch method {
	case "turn/started", "turn/completed":
		turn, _ := object(params, "turn")
		projected["turn"] = map[string]any{"id": turnID, "status": turn["status"]}
	case "item/started", "item/completed":
		item, ok := object(params, "item")
		if !ok {
			return protocolError()
		}
		projected["item"] = map[string]any{"id": item["id"], "type": item["type"], "status": item["status"], "exitCode": item["exitCode"]}
	case "turn/plan/updated":
		steps, ok := array(params, "plan", 128)
		if !ok {
			return protocolError()
		}
		plan := []any{}
		for _, raw := range steps {
			step, err := parse(raw)
			if err != nil {
				return err
			}
			plan = append(plan, map[string]any{"status": step["status"]})
		}
		projected["plan"] = plan
	}
	raw, err := json.Marshal(map[string]any{"method": method, "params": projected})
	if err != nil {
		return protocolError()
	}
	route.sequence++
	selected := providerevents.CodexEventSelection{Binding: c.selection.Binding, RunID: route.dispatch.Intent.TaskID, DispatchID: route.dispatch.Intent.OperationID, StreamID: route.stream, Generation: route.generation, Reference: task.Reference{ThreadID: route.ref.ThreadID, TurnID: turnID}}
	mapper, err := providerevents.NewCodexEvents(selected, c.recheck, func(ctx context.Context, e task.ExecutionEvent) error {
		if !route.ref.Complete(task.Codex) {
			if len(route.queued) >= task.EventCapacity {
				return task.ErrUnavailable
			}
			route.queued = append(route.queued, e)
			return nil
		}
		return route.record(ctx, e)
	}, func() uint64 {
		value := c.now().UnixMilli()
		if value <= 0 {
			return 0
		}
		return uint64(value)
	})
	if err != nil {
		return err
	}
	return mapper.Record(c.lifetime, route.sequence, raw)
}
