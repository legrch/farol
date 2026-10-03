package codex

import (
	"context"
	"encoding/json"

	"github.com/legrch/farol/modules/task/domain"
)

func (c *Client) catalogue(ctx context.Context) error {
	cursor := ""
	seenCursor := map[string]bool{}
	ids := map[string]bool{}
	names := map[string]bool{}
	found := false
	for page := 0; page < 20; page++ {
		params := map[string]any{"limit": pageSize, "includeHidden": true}
		if cursor != "" {
			params["cursor"] = cursor
		}
		m, err := c.rpc(ctx, "model/list", params)
		if err != nil {
			return err
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return protocolError()
		}
		for _, raw := range rows {
			r, err := parse(raw)
			if err != nil {
				return err
			}
			id, a := str(r, "id")
			name, b := str(r, "model")
			label, d := str(r, "displayName")
			_, e := boolean(r, "hidden")
			efforts, f := array(r, "supportedReasoningEfforts", 32)
			if !a || !b || !d || !e || !f || !token(id, 160) || !modelName(name) || len(label) > 240 || ids[id] || names[name] {
				return protocolError()
			}
			for _, ch := range label {
				if ch < 32 || ch == 127 {
					return protocolError()
				}
			}
			ids[id] = true
			names[name] = true
			options := map[string]bool{}
			for _, item := range efforts {
				x, err := parse(item)
				if err != nil {
					return err
				}
				effort, ok := str(x, "reasoningEffort")
				if !ok || !token(effort, 40) || options[effort] {
					return protocolError()
				}
				options[effort] = true
			}
			def, hasDefault := str(r, "defaultReasoningEffort")
			if len(options) > 0 && (!hasDefault || !options[def]) {
				return protocolError()
			}
			if hasDefault && !options[def] {
				return protocolError()
			}
			if name == c.selection.Binding.Model {
				// The resolved binding must already contain its effective effort.
				// Never mutate the binding by resolving a default inside the client.
				if c.selection.Binding.Effort == "" && len(options) > 0 || c.selection.Binding.Effort != "" && !options[c.selection.Binding.Effort] {
					return task.ErrUnsupported
				}
				found = true
			}
		}
		n, done, ok := next(m)
		if !ok {
			return protocolError()
		}
		if done {
			if found {
				return nil
			}
			return task.ErrUnsupported
		}
		if seenCursor[n] {
			return protocolError()
		}
		seenCursor[n] = true
		cursor = n
	}
	return protocolError()
}

func (c *Client) project(ctx context.Context) error {
	var cursor any
	seen := map[string]bool{}
	matches := 0
	matched := false
	ids := map[string]bool{}
	for page := 0; page < maxPages; page++ {
		m, err := c.rpc(ctx, "project/list", map[string]any{"cursor": cursor, "limit": pageSize})
		if err != nil {
			return err
		}
		rows, ok := array(m, "data", pageSize)
		if !ok {
			return protocolError()
		}
		for _, raw := range rows {
			r, err := parse(raw)
			if err != nil {
				return err
			}
			id, ok := str(r, "id")
			roots, haveRoots := array(r, "roots", 100)
			if !ok || !providerID(id) || ids[id] || !haveRoots {
				return protocolError()
			}
			ids[id] = true
			for _, rawRoot := range roots {
				root, err := parse(rawRoot)
				if err != nil {
					return err
				}
				p, ok := str(root, "path")
				if !ok || !canonical(p) {
					return protocolError()
				}
				if p == c.selection.Binding.Project.Path {
					matches++
					matched = id == c.selection.Binding.ProjectID
				}
			}
		}
		n, done, ok := next(m)
		if !ok {
			return protocolError()
		}
		if done {
			if matches == 1 && matched {
				return nil
			}
			return task.ErrIdentity
		}
		if seen[n] {
			return protocolError()
		}
		seen[n] = true
		cursor = n
	}
	return protocolError()
}

func turnLifecycle(m map[string]json.RawMessage) (task.Lifecycle, bool) {
	s, ok := str(m, "status")
	if !ok {
		return task.Unknown, false
	}
	switch s {
	case "inProgress":
		return task.Running, true
	case "completed":
		return task.Completed, true
	case "failed":
		return task.Failed, true
	case "interrupted":
		return task.Interrupted, true
	}
	return task.Unknown, false
}
