package stream

import (
	"errors"
	"testing"
)

func cursor(t *testing.T, b *Buffer) *Cursor {
	t.Helper()
	c, err := b.Subscribe(scope(), 250)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func next(t *testing.T, c *Cursor) Frame {
	t.Helper()
	f, err := c.Next()
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestBlockedLiveWriteDrainAndIndependentSubscriber(t *testing.T) {
	b := buffer(t, DefaultLimits())
	slow := cursor(t, b)
	fast := cursor(t, b)
	// Both subscriptions succeed before a live frame encounters backpressure.
	first := appendFrame(t, b, "one")
	appendFrame(t, b, "two")
	f := next(t, slow)
	if f.Sequence != first.Sequence {
		t.Fatal("order")
	}
	if err := slow.Write(f.Sequence, Blocked, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := slow.Next(); !errors.Is(err, Pending) {
		t.Fatal("overtook blocked write")
	}
	if err := slow.Write(f.Sequence, Blocked, 1100); !errors.Is(err, Correlation) {
		t.Fatal("reset drain deadline")
	}
	for n := uint64(1); n <= 2; n++ {
		f := next(t, fast)
		if f.Sequence != n {
			t.Fatal("fast order")
		}
		if err := fast.Write(f.Sequence, Written, 1000); err != nil {
			t.Fatal(err)
		}
	}
	if err := slow.Drain(1249); err != nil {
		t.Fatal(err)
	}
	if f := next(t, slow); f.Sequence != 2 {
		t.Fatal("drain skipped frame")
	}
	if status, err := b.Acknowledge(scope(), 1); err != nil || status != Acknowledged {
		t.Fatal("socket write forged client ack", status, err)
	}
}

func TestTimeoutAndDisconnectKeepResultForReconnect(t *testing.T) {
	for _, leave := range []WriteStatus{Blocked, Disconnected} {
		t.Run(string(leave), func(t *testing.T) {
			b := buffer(t, DefaultLimits())
			c := cursor(t, b)
			appendFrame(t, b, "answer")
			f := next(t, c)
			if err := c.Write(f.Sequence, leave, 1000); err != nil {
				t.Fatal(err)
			}
			if leave == Blocked {
				if err := c.CheckDeadline(1249); err != nil {
					t.Fatal(err)
				}
				if err := c.CheckDeadline(1250); !errors.Is(err, Timeout) {
					t.Fatal(err)
				}
			}
			if _, err := c.Next(); !errors.Is(err, Closed) {
				t.Fatal(err)
			}
			reconnected := cursor(t, b)
			if f := next(t, reconnected); f.Sequence != 1 || string(f.Data) != "answer" {
				t.Fatal("lost retained result")
			}
			if status, err := b.Acknowledge(scope(), 1); err != nil || status != Acknowledged {
				t.Fatal(status, err)
			}
		})
	}
}

func TestEvictionDuringSubscriptionReportsGap(t *testing.T) {
	b := buffer(t, Limits{Frames: 1, FrameBytes: 4, Bytes: 4})
	c := cursor(t, b)
	appendFrame(t, b, "one")
	ack(t, b, 1)
	appendFrame(t, b, "two")
	if _, err := c.Next(); !errors.Is(err, Gap) {
		t.Fatal("subscriber silently skipped event")
	}
}

func TestStaleScopeAndMonotonicClock(t *testing.T) {
	b := buffer(t, DefaultLimits())
	foreign := scope()
	foreign.BackendGeneration = "stale"
	if _, err := b.Subscribe(foreign, 250); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	c := cursor(t, b)
	appendFrame(t, b, "one")
	f := next(t, c)
	if err := c.Write(f.Sequence, Blocked, 1000); err != nil {
		t.Fatal(err)
	}
	if err := c.Drain(999); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if err := c.Drain(1250); !errors.Is(err, Timeout) {
		t.Fatal("late drain extended deadline")
	}
}
