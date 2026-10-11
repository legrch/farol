package process

import (
	"bytes"
	"encoding/base64"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// In-memory IPC only: command output fragmentation must not change its result.
func TestWatchdogReceiveFragmentedOutput(t *testing.T) {
	id := strings.Repeat("a", 64)
	frame := `{"type":"stdout","id":"` + id + `","data":"AP8="}` + "\n"
	terminal := `{"type":"exit","id":"` + id + `","code":7,"signal":null}` + "\n" +
		`{"type":"close","id":"` + id + `","code":7,"signal":null}` + "\n"
	const count = 8193
	channel := &fragmentedWatchdogChannel{reader: strings.NewReader(strings.Repeat(frame, count) + terminal)}
	var stdout bytes.Buffer
	child := newWatchdogChild(nil, channel, time.Unix(123, 0), nil, &stdout, io.Discard)
	child.id, child.preparedSeen, child.readySeen, child.startSent = id, true, true, true
	child.receive()
	if child.uncertain || !child.rootClosed || !child.root.Waited || !child.root.Drained ||
		child.root.Code == nil || *child.root.Code != 7 || child.bytes != count*2 ||
		!bytes.Equal(stdout.Bytes(), bytes.Repeat([]byte{0, 255}, count)) {
		t.Fatal("valid fragmented output lost root completion or bytes", child.bytes, child.uncertain)
	}
}

func TestWatchdogReceiveFragmentationStillBoundsOutput(t *testing.T) {
	id := strings.Repeat("a", 64)
	for _, tc := range []struct {
		name, frame string
		initial     int
		limited     bool
	}{
		{"overflow", `{"type":"stdout","id":"` + id + `","data":"AP8="}`, processsvc.MaximumOutput - 1, true},
		{"empty", `{"type":"stdout","id":"` + id + `","data":""}`, 0, false},
		{"duplicate-ready", `{"type":"ready","id":"` + id + `"}`, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			channel := &fragmentedWatchdogChannel{reader: strings.NewReader(tc.frame + "\n")}
			child := newWatchdogChild(nil, channel, time.Unix(123, 0), nil, io.Discard, io.Discard)
			child.id, child.preparedSeen, child.readySeen, child.startSent = id, true, true, true
			child.bytes = tc.initial
			child.receive()
			if !child.uncertain || !channel.closed || child.rootClosed || child.bytes != tc.initial || child.outputLimit != tc.limited {
				t.Fatal("invalid stream escaped the existing fence or output bound")
			}
		})
	}
}

// A deterministic stream with EOF; no host sockets or process execution.
type fragmentedWatchdogChannel struct {
	reader io.Reader
	closed bool
}

func (c *fragmentedWatchdogChannel) Read(p []byte) (int, error)       { return c.reader.Read(p) }
func (c *fragmentedWatchdogChannel) Write(p []byte) (int, error)      { return len(p), nil }
func (c *fragmentedWatchdogChannel) Close() error                     { c.closed = true; return nil }
func (c *fragmentedWatchdogChannel) SetReadDeadline(time.Time) error  { return nil }
func (c *fragmentedWatchdogChannel) SetWriteDeadline(time.Time) error { return nil }

func TestWatchdogReceivePaddedWireBudget(t *testing.T) {
	id := strings.Repeat("a", 64)
	frame := strings.Repeat(" ", 1024) + `{"type":"stdout","id":"` + id + `","data":"QQ=="}` + "\n"
	channel := &fragmentedWatchdogChannel{reader: strings.NewReader(frame + frame)}
	child := newWatchdogChild(nil, channel, time.Unix(123, 0), nil, io.Discard, io.Discard)
	child.id, child.preparedSeen, child.readySeen, child.startSent = id, true, true, true
	child.receiveBounded(len(frame)*2 - 1)
	if !child.uncertain || !channel.closed || child.bytes != 1 || child.outputLimit || child.rootClosed {
		t.Fatal("wire budget exhaustion parsed another frame or claimed output overflow")
	}
}

func TestWatchdogReceiveExactOutputLimit(t *testing.T) {
	id := strings.Repeat("a", 64)
	var stream strings.Builder
	remaining := processsvc.MaximumOutput
	for remaining > 0 {
		n := min(remaining, watchdogChunkLimit)
		stream.WriteString(`{"type":"stdout","id":"` + id + `","data":"` + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, n)) + `"}` + "\n")
		remaining -= n
	}
	stream.WriteString(`{"type":"close","id":"` + id + `","code":0,"signal":null}` + "\n")
	channel := &fragmentedWatchdogChannel{reader: strings.NewReader(stream.String())}
	child := newWatchdogChild(nil, channel, time.Unix(123, 0), nil, io.Discard, io.Discard)
	child.id, child.preparedSeen, child.readySeen, child.startSent = id, true, true, true
	child.receive()
	if child.uncertain || child.outputLimit || !child.rootClosed || !child.root.Drained || child.bytes != processsvc.MaximumOutput {
		t.Fatal("exact output limit lost terminal observation")
	}
}

func TestWatchdogReceivePartialEOF(t *testing.T) {
	channel := &fragmentedWatchdogChannel{reader: strings.NewReader(`{"type":"close"`)}
	child := newWatchdogChild(nil, channel, time.Unix(123, 0), nil, io.Discard, io.Discard)
	child.rootClosed = true
	child.receive()
	if !child.uncertain || !channel.closed {
		t.Fatal("partial frame EOF accepted")
	}
}

func TestWatchdogReceiveOriginalDeadline(t *testing.T) {
	client, peer := net.Pipe()
	defer peer.Close()
	defer client.Close()
	deadline := time.Now().Add(25 * time.Millisecond)
	child := newWatchdogChild(nil, client, deadline, nil, io.Discard, io.Discard)
	done := make(chan struct{})
	go func() { child.receive(); close(done) }()
	select {
	case <-done:
		if time.Now().Before(deadline) || !child.uncertain {
			t.Fatal("stalled IPC did not retain original deadline fence")
		}
	case <-time.After(time.Second):
		t.Fatal("stalled IPC exceeded its original deadline")
	}
}
