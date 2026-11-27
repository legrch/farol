package codex

import (
	"context"
	"encoding/json"

	"github.com/legrch/farol/modules/task/app/port"
	task "github.com/legrch/farol/modules/task/domain"
)

func (c *Client) Observe(parent context.Context, b task.Binding, ref task.Reference) (port.Observation, error) {
	return c.observe(parent, b, ref, nil)
}

// observe keeps an optional sealed read selection inside the original Client
// gate/budget and carries one connection witness through the last awaited check.
// Public Observe retains its existing producer port and binding-only authority.
func (c *Client) observe(parent context.Context, b task.Binding, ref task.Reference, recheckSelection func(context.Context) error) (port.Observation, error) {
	ctx, leave, err := c.enter(parent)
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	defer leave()
	if b != c.selection.Binding || !ref.Complete(task.Codex) || !providerID(ref.ThreadID) || !providerID(ref.TurnID) {
		return port.Observation{}, task.ErrIdentity
	}
	if recheckSelection != nil {
		if err := recheckSelection(ctx); err != nil {
			return port.Observation{}, err
		}
	}
	if err := c.verify(ctx); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if err := c.ensure(ctx); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	qualified := qualification{connection: c.connection, epoch: c.connection.epoch.Load()}
	read := c.rpc
	if recheckSelection != nil {
		read = func(ctx context.Context, method string, params any) (map[string]json.RawMessage, error) {
			return c.rpcChecked(ctx, method, params, func() error {
				// After binding checks, frame construction and write-lock waiting:
				// the sealed selection must still authorize this exact history read.
				if err := qualified.check(c); err != nil {
					return err
				}
				if err := recheckSelection(ctx); err != nil {
					return err
				}
				return c.readWitness(ctx, qualified)
			})
		}
	}
	if err := readThread(ctx, read, b, ref.ThreadID); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	lifecycle, err := readTurn(ctx, read, ref)
	if err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	text := ""
	if lifecycle == task.Completed {
		text, err = readFinal(ctx, read, ref)
		if err != nil {
			return port.Observation{}, task.ErrUnknown
		}
	}
	// History is a non-atomic read. Check exact membership again after awaited
	// turn/item pages; a changed project/writer/model cannot disclose the result.
	if err := readThread(ctx, read, b, ref.ThreadID); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return port.Observation{}, task.ErrUnknown
	}
	if recheckSelection != nil {
		if err := recheckSelection(ctx); err != nil {
			return port.Observation{}, err
		}
		if err := c.readWitness(ctx, qualified); err != nil {
			return port.Observation{}, task.ErrUnknown
		}
	}
	return port.Observation{Reference: ref, Lifecycle: lifecycle, Result: text}, nil
}

// readWitness is value-only and runs after the last awaited selection check.
// It never acquires a newer epoch or invokes a grant/native/provider callback.
func (c *Client) readWitness(ctx context.Context, qualified qualification) error {
	now := c.now()
	if ctx.Err() != nil || c.lifetime.Err() != nil || c.closed.Load() || now.Before(c.selection.GrantedAt) || !now.Before(c.selection.ExpiresAt) {
		return task.ErrUnknown
	}
	return qualified.check(c)
}

type historyRead func(context.Context, string, any) (map[string]json.RawMessage, error)

func readThread(ctx context.Context, read historyRead, b task.Binding, id string) error {
	m, err := read(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false})
	if err != nil {
		return err
	}
	thread, ok := object(m, "thread")
	if !ok || !equals(thread, "id", id) || !equals(thread, "projectId", b.ProjectID) || !equals(thread, "cwd", b.Writer.Path) || !equals(thread, "model", b.Model) {
		return task.ErrUnknown
	}
	return nil
}

func readTurn(ctx context.Context, read historyRead, ref task.Reference) (task.Lifecycle, error) {
	var cursor any
	seen := map[string]bool{}
	ids := map[string]bool{}
	lifecycle := task.Unknown
	matches := 0
	for page := 0; page < maxPages; page++ {
		m, err := read(ctx, "thread/turns/list", map[string]any{"threadId": ref.ThreadID, "cursor": cursor, "limit": pageSize, "itemsView": "notLoaded"})
		if err != nil {
			return task.Unknown, err
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return task.Unknown, protocolError()
		}
		for _, raw := range rows {
			r, err := parse(raw)
			if err != nil {
				return task.Unknown, err
			}
			id, ok := str(r, "id")
			if !ok || !providerID(id) || ids[id] {
				return task.Unknown, protocolError()
			}
			ids[id] = true
			if id == ref.TurnID {
				lifecycle, ok = turnLifecycle(r)
				if !ok {
					return task.Unknown, protocolError()
				}
				matches++
			}
		}
		n, done, ok := next(m)
		if !ok {
			return task.Unknown, protocolError()
		}
		if done {
			if matches == 1 {
				return lifecycle, nil
			}
			return task.Unknown, task.ErrUnknown
		}
		if seen[n] {
			return task.Unknown, protocolError()
		}
		seen[n] = true
		cursor = n
	}
	return task.Unknown, protocolError()
}
func readFinal(ctx context.Context, read historyRead, ref task.Reference) (string, error) {
	var cursor any
	seen := map[string]bool{}
	ids := map[string]bool{}
	matches := 0
	text := ""
	for page := 0; page < maxPages; page++ {
		m, err := read(ctx, "thread/items/list", map[string]any{"threadId": ref.ThreadID, "turnId": ref.TurnID, "cursor": cursor, "limit": pageSize})
		if err != nil {
			return "", err
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return "", protocolError()
		}
		for _, raw := range rows {
			r, err := parse(raw)
			if err != nil {
				return "", err
			}
			item, ok := object(r, "item")
			id, haveID := str(item, "id")
			if !equals(r, "turnId", ref.TurnID) || !ok || !haveID || !providerID(id) || ids[id] {
				return "", protocolError()
			}
			ids[id] = true
			if equals(item, "type", "agentMessage") && equals(item, "phase", "final_answer") {
				s, ok := str(item, "text")
				if !ok || !task.Text(s, maxResultBytes) {
					return "", protocolError()
				}
				matches++
				text = s
			}
		}
		n, done, ok := next(m)
		if !ok {
			return "", protocolError()
		}
		if done {
			if matches == 1 {
				return text, nil
			}
			return "", task.ErrUnknown
		}
		if seen[n] {
			return "", protocolError()
		}
		seen[n] = true
		cursor = n
	}
	return "", protocolError()
}
