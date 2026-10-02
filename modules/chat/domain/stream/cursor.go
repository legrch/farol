package stream

import "math"

type WriteStatus string

const (
	Written      WriteStatus = "written"
	Blocked      WriteStatus = "blocked"
	Disconnected WriteStatus = "disconnected"
)

// Cursor belongs to one client connection. Disconnect/timeout leaves the shared
// retained result intact. Time is supplied explicitly; no domain timer or IO runs.
type Cursor struct {
	buffer   *Buffer
	last     uint64
	offered  Frame
	pending  bool
	blocked  bool
	closed   bool
	budget   uint64
	deadline uint64
	time     uint64
}

func (b *Buffer) Subscribe(scope Scope, drainBudgetMillis uint64) (*Cursor, error) {
	if scope != b.scope {
		return nil, Correlation
	}
	if b.failed {
		return nil, Overflow
	}
	if drainBudgetMillis == 0 || drainBudgetMillis > 250 {
		return nil, Invalid
	}
	last := b.sequence
	if len(b.frames) > 0 {
		last = b.frames[0].frame.Sequence - 1
	}
	return &Cursor{buffer: b, last: last, budget: drainBudgetMillis}, nil
}

func (c *Cursor) Next() (Frame, error) {
	if c.closed {
		return Frame{}, Closed
	}
	if c.pending {
		return Frame{}, Pending
	}
	frames, err := c.buffer.After(c.buffer.scope, c.last)
	if err != nil {
		c.closed = true
		return Frame{}, err
	}
	if len(frames) == 0 {
		return Frame{}, Empty
	}
	c.offered, c.pending = frames[0], true
	return clone(c.offered), nil
}

func (c *Cursor) Write(sequence uint64, status WriteStatus, nowMillis uint64) error {
	if c.closed {
		return Closed
	}
	if !c.pending || c.blocked || c.offered.Sequence != sequence {
		return Correlation
	}
	if nowMillis < c.time {
		return Invalid
	}
	switch status {
	case Written:
		c.last, c.pending = c.offered.Sequence, false
		c.offered = Frame{}
	case Blocked:
		if nowMillis > math.MaxUint64-c.budget {
			return Invalid
		}
		c.blocked, c.deadline = true, nowMillis+c.budget
	case Disconnected:
		c.Close()
	default:
		return Invalid
	}
	c.time = nowMillis
	return nil
}
func (c *Cursor) Drain(nowMillis uint64) error {
	if c.closed {
		return Closed
	}
	if !c.blocked {
		return Correlation
	}
	if nowMillis < c.time {
		return Invalid
	}
	c.time = nowMillis
	if nowMillis >= c.deadline {
		c.Close()
		return Timeout
	}
	c.last, c.pending, c.blocked = c.offered.Sequence, false, false
	c.offered = Frame{}
	return nil
}
func (c *Cursor) CheckDeadline(nowMillis uint64) error {
	if c.closed {
		return Closed
	}
	if nowMillis < c.time {
		return Invalid
	}
	c.time = nowMillis
	if c.blocked && nowMillis >= c.deadline {
		c.Close()
		return Timeout
	}
	return nil
}
func (c *Cursor) Close() { c.closed = true; c.offered = Frame{}; c.pending = false; c.blocked = false }
