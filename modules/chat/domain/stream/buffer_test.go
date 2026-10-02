package stream

import (
	"errors"
	"math"
	"testing"
)

func scope() Scope {
	return Scope{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend", OwnerID: "fixture-owner", SessionID: "fixture-session", TaskID: "fixture-task", TurnID: "fixture-turn", TurnGeneration: 7}
}
func buffer(t *testing.T, limits Limits) *Buffer {
	t.Helper()
	b, err := New(scope(), limits)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func appendFrame(t *testing.T, b *Buffer, data string) Frame {
	t.Helper()
	f, err := b.Append(Delta, []byte(data))
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func ack(t *testing.T, b *Buffer, seq uint64) {
	t.Helper()
	if _, err := b.Acknowledge(scope(), seq); err != nil {
		t.Fatal(err)
	}
}

func TestReplayCopiesAndExactAcknowledgement(t *testing.T) {
	b := buffer(t, DefaultLimits())
	data := []byte("synthetic answer")
	first, err := b.Append(Delta, data)
	if err != nil {
		t.Fatal(err)
	}
	data[0] = 'X'
	first.Data[0] = 'Y'
	replay, err := b.Replay(scope())
	if err != nil {
		t.Fatal(err)
	}
	if string(replay[0].Data) != "synthetic answer" {
		t.Fatal("input/output aliases retained bytes")
	}
	replay[0].Data[0] = 'Z'
	for _, foreign := range []Scope{func() Scope { s := scope(); s.BackendGeneration = "old"; return s }(), func() Scope { s := scope(); s.TaskID = "other"; return s }(), func() Scope { s := scope(); s.TurnGeneration++; return s }()} {
		if _, err := b.Acknowledge(foreign, 1); !errors.Is(err, Correlation) {
			t.Fatal(err)
		}
		if _, err := b.Replay(foreign); !errors.Is(err, Correlation) {
			t.Fatal(err)
		}
	}
	if status, err := b.Acknowledge(scope(), 1); err != nil || status != Acknowledged {
		t.Fatal(status, err)
	}
	if status, err := b.Acknowledge(scope(), 1); err != nil || status != Duplicate {
		t.Fatal(status, err)
	}
	if status, err := b.Acknowledge(scope(), 2); err != nil || status != Missing {
		t.Fatal(status, err)
	}
	replay, err = b.Replay(scope())
	if err != nil {
		t.Fatal(err)
	}
	if len(replay) != 1 || string(replay[0].Data) != "synthetic answer" {
		t.Fatal("ack removed retained replay")
	}
}

func TestOverflowKeepsUnacknowledgedResultsAndFailsClosed(t *testing.T) {
	b := buffer(t, Limits{Frames: 2, FrameBytes: 4, Bytes: 8})
	appendFrame(t, b, "one")
	appendFrame(t, b, "two")
	if _, err := b.Append(Delta, []byte("tri")); !errors.Is(err, Overflow) {
		t.Fatal(err)
	}
	s := b.Snapshot()
	if !s.Failed || s.LastSequence != 2 || s.RetainedFrames != 2 || s.RetainedBytes != 6 {
		t.Fatalf("lost result on overflow: %+v", s)
	}
	if _, err := b.Replay(scope()); !errors.Is(err, Overflow) {
		t.Fatal(err)
	}
	if _, err := b.Append(Terminal, []byte("end")); !errors.Is(err, Overflow) {
		t.Fatal(err)
	}
	if _, err := b.Subscribe(scope(), 250); !errors.Is(err, Overflow) {
		t.Fatal(err)
	}
}

func TestEvictionNeedsAckAndReportsReconnectGap(t *testing.T) {
	b := buffer(t, Limits{Frames: 3, FrameBytes: 4, Bytes: 8})
	appendFrame(t, b, "aa")
	appendFrame(t, b, "bbbb")
	ack(t, b, 1)
	third := appendFrame(t, b, "cccc")
	if third.Sequence != 3 {
		t.Fatal("sequence reset after eviction")
	}
	if _, err := b.After(scope(), 0); !errors.Is(err, Gap) {
		t.Fatal("silent reconnect gap")
	}
	replay, err := b.Replay(scope())
	if err != nil {
		t.Fatal(err)
	}
	if len(replay) != 2 || replay[0].Sequence != 2 {
		t.Fatal("incorrect retained history")
	}
	if _, err := b.After(scope(), 4); !errors.Is(err, Gap) {
		t.Fatal(err)
	}
	if frames, err := b.After(scope(), 1); err != nil || len(frames) != 2 {
		t.Fatal(frames, err)
	}
}

func TestSizeAndCounterBoundsDoNotWrap(t *testing.T) {
	b := buffer(t, Limits{Frames: 2, FrameBytes: 4, Bytes: 8})
	if _, err := b.Append(Delta, []byte("12345")); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if b.Snapshot().LastSequence != 0 {
		t.Fatal("invalid event allocated sequence")
	}
	if _, err := b.Append(Kind("arbitrary"), nil); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	b.sequence = math.MaxUint64
	if _, err := b.Append(Delta, nil); !errors.Is(err, Overflow) {
		t.Fatal("wrapped event counter")
	}
}

func TestTerminalIsLastButRemainsAvailableForDelivery(t *testing.T) {
	b := buffer(t, DefaultLimits())
	appendFrame(t, b, "synthetic answer")
	terminal, err := b.Append(Terminal, []byte("completed"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Append(Delta, []byte("late")); !errors.Is(err, Closed) {
		t.Fatal("frame after terminal", err)
	}
	if s := b.Snapshot(); !s.Terminal || s.Failed || s.LastSequence != terminal.Sequence {
		t.Fatalf("terminal result changed: %+v", s)
	}
	replay, err := b.Replay(scope())
	if err != nil || len(replay) != 2 {
		t.Fatal(replay, err)
	}
	if _, err := b.Subscribe(scope(), 250); err != nil {
		t.Fatal("terminal must allow redelivery", err)
	}
}
