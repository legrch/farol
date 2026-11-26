package codex

import (
	"context"
	"encoding/json"

	task "github.com/legrch/farol/modules/task/domain"
)

func (c *Client) rpc(ctx context.Context, method string, params any) (map[string]json.RawMessage, error) {
	return c.rpcChecked(ctx, method, params, nil)
}

// mutationRPC carries the actual immutable intent explicitly to the write
// boundary. It never stores operation authority in context or retargets a Client.
func (c *Client) mutationRPC(ctx context.Context, method string, params any, intent task.Intent, qualified qualification) (map[string]json.RawMessage, error) {
	if !mutationMethod(method) {
		return nil, task.ErrIdentity
	}
	return c.rpcChecked(ctx, method, params, func() error {
		// The write lock has been acquired. Retain the originally qualified
		// connection/epoch across lock waiting; do not snapshot a newer epoch.
		if err := qualified.check(c); err != nil {
			return err
		}
		// Binding checks can await. Keep the Parent/intent check last, while the
		// transport write lock is held, after all qualification and frame work.
		if err := c.guard(ctx); err != nil {
			return err
		}
		if c.dispatchRecheck == nil {
			return task.ErrUnsupported
		}
		if err := checkDispatch(c.dispatchRecheck, ctx, intent); err != nil {
			return task.ErrIdentity
		}
		if ctx.Err() != nil || c.closed.Load() || !c.now().Before(c.selection.ExpiresAt) {
			return task.ErrUnavailable
		}
		// Account notifications are consumed independently while either guard
		// awaits. Match the same connection/epoch again, just before writing.
		if method == "turn/steer" {
			if err := c.steerCurrent(intent.Expected); err != nil {
				return err
			}
		}
		return qualified.check(c)
	})
}

// The callback is an injected authority boundary. A panic refuses dispatch,
// without leaking a diagnostic or crashing the asynchronous transport writer.
func checkDispatch(check func(context.Context, task.Intent) error, ctx context.Context, intent task.Intent) (err error) {
	defer func() {
		if recover() != nil {
			err = task.ErrIdentity
		}
	}()
	return check(ctx, intent)
}

func (c *Client) rpcChecked(ctx context.Context, method string, params any, beforeWrite func() error) (map[string]json.RawMessage, error) {
	if err := c.guard(ctx); err != nil {
		return nil, err
	}
	m, err := c.connection.requestChecked(ctx, method, params, beforeWrite)
	if err != nil {
		return nil, err
	}
	if err := c.guard(ctx); err != nil {
		return nil, err
	}
	return m, nil
}

// qualification is a retained connection/account-epoch witness, not new Task
// admission or a grant. The selected connection is never replaced/requalified
// to recover an invalidated witness.
type qualification struct {
	connection *proxy
	epoch      uint64
}

func (q qualification) check(c *Client) error {
	c.mu.Lock()
	same := q.connection != nil && c.connection == q.connection
	c.mu.Unlock()
	if !same || q.connection.lost.Load() || q.connection.epoch.Load() != q.epoch {
		return task.ErrUnknown
	}
	return nil
}

func (c *Client) qualify(ctx context.Context) (qualification, error) {
	if err := c.verify(ctx); err != nil {
		return qualification{}, err
	}
	if err := c.ensure(ctx); err != nil {
		return qualification{}, err
	}
	qualified := qualification{connection: c.connection, epoch: c.connection.epoch.Load()}
	if err := c.catalogue(ctx); err != nil {
		return qualification{}, err
	}
	if err := c.project(ctx); err != nil {
		return qualification{}, err
	}
	if err := c.current(ctx, qualified.epoch); err != nil {
		return qualification{}, err
	}
	if err := qualified.check(c); err != nil {
		return qualification{}, err
	}
	return qualified, nil
}
func (c *Client) current(ctx context.Context, epoch uint64) error {
	if err := c.verify(ctx); err != nil {
		return err
	}
	if c.connection.lost.Load() || c.connection.epoch.Load() != epoch {
		return task.ErrUnknown
	}
	return nil
}
