package process

import (
	"bytes"
	"io"
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
