// Package stream owns bounded in-memory delivery, independently of HTTP IO.
// Its single application owner serializes calls. Payload is transient delivery data,
// never a durable journal or an Activity history.
package stream

import (
	"math"
	"unicode/utf8"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_STREAM_INVALID"
	Correlation Code = "CHAT_STREAM_CORRELATION"
	Overflow    Code = "CHAT_STREAM_OVERFLOW"
	Gap         Code = "CHAT_STREAM_GAP"
	Empty       Code = "CHAT_STREAM_EMPTY"
	Closed      Code = "CHAT_STREAM_CLOSED"
	Pending     Code = "CHAT_STREAM_WRITE_PENDING"
	Timeout     Code = "CHAT_STREAM_DRAIN_TIMEOUT"
)

// Scope includes backend incarnation. A stale reconnect cannot acknowledge a new one.
type Scope struct {
	ProfileID         string
	BackendGeneration string
	OwnerID           string
	SessionID         string
	TaskID            string
	TurnID            string
	TurnGeneration    uint64
}

func (s Scope) valid() bool {
	return identifier(s.ProfileID) && identifier(s.BackendGeneration) && identifier(s.OwnerID) && identifier(s.SessionID) && identifier(s.TaskID) && identifier(s.TurnID) && s.TurnGeneration > 0
}

type Kind string

const (
	Phase             Kind = "turn.phase"
	Delta             Kind = "text.delta"
	ComputerRequested Kind = "computer.requested"
	ComputerCompleted Kind = "computer.completed"
	Terminal          Kind = "turn.terminal"
)

func (k Kind) valid() bool {
	switch k {
	case Phase, Delta, ComputerRequested, ComputerCompleted, Terminal:
		return true
	default:
		return false
	}
}

type Limits struct {
	Frames     int
	FrameBytes int
	Bytes      int
}

func DefaultLimits() Limits { return Limits{Frames: 128, FrameBytes: 64 * 1024, Bytes: 256 * 1024} }
func (l Limits) valid() bool {
	max := DefaultLimits()
	return l.Frames > 0 && l.Frames <= max.Frames && l.FrameBytes > 0 && l.FrameBytes <= max.FrameBytes && l.Bytes >= l.FrameBytes && l.Bytes <= max.Bytes
}

// Data is transient bounded payload, copied on ingress and egress. Wire encoding
// remains transport-owned. No private content is exposed by Snapshot.
type Frame struct {
	Sequence uint64
	Kind     Kind
	Data     []byte
}
type retained struct {
	frame        Frame
	acknowledged bool
}
type Snapshot struct {
	Scope          Scope
	LastSequence   uint64
	RetainedFrames int
	RetainedBytes  int
	Failed         bool
	Terminal       bool
}
type Buffer struct {
	scope    Scope
	limits   Limits
	frames   []retained
	bytes    int
	sequence uint64
	failed   bool
	terminal bool
}

func New(scope Scope, limits Limits) (*Buffer, error) {
	if !scope.valid() || !limits.valid() {
		return nil, Invalid
	}
	return &Buffer{scope: scope, limits: limits}, nil
}
func (b *Buffer) Snapshot() Snapshot {
	return Snapshot{Scope: b.scope, LastSequence: b.sequence, RetainedFrames: len(b.frames), RetainedBytes: b.bytes, Failed: b.failed, Terminal: b.terminal}
}
func clone(f Frame) Frame { f.Data = append([]byte(nil), f.Data...); return f }

// Append evicts only acknowledged frames. Overflow is sticky; it does not
// reinterpret lost client delivery as provider failure or authorize another Send.
func (b *Buffer) Append(kind Kind, data []byte) (Frame, error) {
	if b.failed {
		return Frame{}, Overflow
	}
	if b.terminal {
		return Frame{}, Closed
	}
	if !kind.valid() || len(data) > b.limits.FrameBytes {
		return Frame{}, Invalid
	}
	if b.sequence == math.MaxUint64 {
		b.failed = true
		return Frame{}, Overflow
	}
	remaining, bytes := len(b.frames), b.bytes
	evict := make([]bool, len(b.frames))
	for n, item := range b.frames {
		if remaining < b.limits.Frames && bytes+len(data) <= b.limits.Bytes {
			break
		}
		if item.acknowledged {
			evict[n] = true
			remaining--
			bytes -= len(item.frame.Data)
		}
	}
	if remaining >= b.limits.Frames || bytes+len(data) > b.limits.Bytes {
		b.failed = true
		return Frame{}, Overflow
	}
	kept := make([]retained, 0, remaining+1)
	for n, item := range b.frames {
		if !evict[n] {
			kept = append(kept, item)
		}
	}
	b.sequence++
	f := Frame{Sequence: b.sequence, Kind: kind, Data: append([]byte(nil), data...)}
	b.frames = append(kept, retained{frame: f})
	b.bytes = bytes + len(data)
	b.terminal = kind == Terminal
	return clone(f), nil
}

type AckStatus string

const (
	Acknowledged AckStatus = "acknowledged"
	Duplicate    AckStatus = "duplicate"
	Missing      AckStatus = "missing"
)

func (b *Buffer) Acknowledge(scope Scope, sequence uint64) (AckStatus, error) {
	if scope != b.scope {
		return "", Correlation
	}
	for n, item := range b.frames {
		if item.frame.Sequence != sequence {
			continue
		}
		if item.acknowledged {
			return Duplicate, nil
		}
		b.frames[n].acknowledged = true
		return Acknowledged, nil
	}
	return Missing, nil
}

// Replay retains legacy full-history behavior, including acknowledged frames.
// Reading a result, reconnecting and successful socket writes acknowledge nothing.
func (b *Buffer) Replay(scope Scope) ([]Frame, error) {
	if scope != b.scope {
		return nil, Correlation
	}
	if b.failed {
		return nil, Overflow
	}
	frames := make([]Frame, 0, len(b.frames))
	for _, item := range b.frames {
		frames = append(frames, clone(item.frame))
	}
	return frames, nil
}

// After is an observation-only primitive for Core's future snapshot/gap path.
// It cannot silently promise a contiguous replay after acknowledged eviction.
func (b *Buffer) After(scope Scope, sequence uint64) ([]Frame, error) {
	if scope != b.scope {
		return nil, Correlation
	}
	if b.failed {
		return nil, Overflow
	}
	if sequence > b.sequence {
		return nil, Gap
	}
	frames := make([]Frame, 0, len(b.frames))
	next := sequence
	for _, item := range b.frames {
		if item.frame.Sequence <= sequence {
			continue
		}
		if next == math.MaxUint64 || item.frame.Sequence != next+1 {
			return nil, Gap
		}
		next = item.frame.Sequence
		frames = append(frames, clone(item.frame))
	}
	if next != b.sequence {
		return nil, Gap
	}
	return frames, nil
}

func identifier(value string) bool {
	if len(value) < 1 || len(value) > 120 || !utf8.ValidString(value) {
		return false
	}
	for _, ch := range value {
		if ch <= 32 || ch == 127 {
			return false
		}
	}
	return true
}
