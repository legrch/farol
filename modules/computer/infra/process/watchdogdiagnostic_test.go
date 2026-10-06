//go:build darwin && farol_native_process

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

const watchdogDiagnosticByteLimit = 256 * 1024
const watchdogDiagnosticFrameLimit = 16

type watchdogFrameDiagnostic struct {
	Type      string
	Reason    string // Closed error reason only; never arbitrary wire text.
	Bytes     int
	SHA256    string // Hash of captured wire bytes, including newline if complete.
	Complete  bool
	JSONValid bool
}

type watchdogChannelDiagnostic struct {
	BytesRead, BytesInspected uint64
	Stopped, ReadError        string
	Frames                    []watchdogFrameDiagnostic
}

// ONLY the synthetic test's inbound channel is inspected. Outbound prepare
// carries code/input/env and is forwarded untouched without any recording.
// At most 256 KiB is inspected, one 96 KiB frame is temporarily buffered, and
// at most 16 metadata records survive. No payload bytes or arbitrary type/error
// strings appear in snapshots. Only allowlisted error reasons survive; stdout,
// stderr and other frames never supply a reason. Not a decoder or authority.
type watchdogDiagnosticChannel struct {
	watchdogChannel // Same retained object; all other methods delegate unchanged.
	mutex           sync.Mutex
	state           watchdogChannelDiagnostic
	pending         []byte
}

func (c *watchdogDiagnosticChannel) Read(raw []byte) (int, error) {
	n, err := c.watchdogChannel.Read(raw)
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if c.pending == nil {
		c.pending = make([]byte, 0, watchdogFrameLimit)
	}
	c.state.BytesRead += uint64(n)
	for _, value := range raw[:n] {
		if c.state.Stopped != "" {
			break
		}
		if c.state.BytesInspected == watchdogDiagnosticByteLimit || len(c.pending) == watchdogFrameLimit {
			c.finish(false)
			c.state.Stopped = "byte-limit"
			if c.state.BytesInspected < watchdogDiagnosticByteLimit {
				c.state.Stopped = "frame-byte-limit"
			}
			break
		}
		c.pending = append(c.pending, value)
		c.state.BytesInspected++
		if value == '\n' {
			c.finish(true)
			if len(c.state.Frames) == watchdogDiagnosticFrameLimit {
				c.state.Stopped = "metadata-limit"
			}
		}
	}
	if err != nil {
		if c.state.ReadError == "" {
			c.state.ReadError = watchdogDiagnosticError(err)
		}
		if len(c.pending) > 0 {
			c.finish(false)
		}
	}
	return n, err // Preserve exact underlying bytes and error; no retries.
}

func watchdogFrameMetadata(raw []byte, complete bool) watchdogFrameDiagnostic {
	digest := sha256.Sum256(raw)
	metadata := watchdogFrameDiagnostic{Type: "unparsed", Bytes: len(raw),
		SHA256: hex.EncodeToString(digest[:]), Complete: complete, JSONValid: validWatchdogJSON(raw)}
	if metadata.JSONValid {
		var event struct {
			Type   string
			Reason json.RawMessage
		}
		if json.Unmarshal(raw, &event) == nil {
			switch event.Type {
			case "prepared", "ready", "stdout", "stderr", "exit", "close", "stop-requested",
				"error", "signal-refused", "output-limit", "deadline":
				metadata.Type = event.Type
			default:
				metadata.Type = "unrecognized"
			}
			if event.Type == "error" {
				var reason string
				if json.Unmarshal(event.Reason, &reason) == nil {
					switch reason {
					case "invalid-prepare", "invalid-control", "invalid-start", "invalid-exit",
						"invalid-close", "command-error", "stdin-epipe", "stdin-error", "dispatch-exception":
						metadata.Reason = reason
					}
				}
			}
		}
	}
	return metadata
}

// Caller holds mutex. Clear the temporary synthetic bytes after hashing.
func (c *watchdogDiagnosticChannel) finish(complete bool) {
	if len(c.pending) > 0 && len(c.state.Frames) < watchdogDiagnosticFrameLimit {
		c.state.Frames = append(c.state.Frames, watchdogFrameMetadata(c.pending, complete))
	}
	clear(c.pending)
	c.pending = c.pending[:0]
}

func (c *watchdogDiagnosticChannel) snapshot() watchdogChannelDiagnostic {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	state := c.state
	state.Frames = append([]watchdogFrameDiagnostic(nil), state.Frames...)
	if len(c.pending) > 0 && len(state.Frames) < watchdogDiagnosticFrameLimit {
		state.Frames = append(state.Frames, watchdogFrameMetadata(c.pending, false))
	}
	return state
}

// Error text may contain paths or input. Publish only closed classifications.
func watchdogDiagnosticError(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, io.EOF):
		return "eof"
	case errors.Is(err, net.ErrClosed):
		return "closed"
	case errors.Is(err, os.ErrDeadlineExceeded), errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	}
	var failure *processsvc.NativeFailure
	if errors.As(err, &failure) {
		if failure.Unknown {
			return "native-unknown"
		}
		return "native-refused"
	}
	return "other"
}

// Pure memory channel for wrapper checks only. No process/socket/exporter,
// filesystem, signal, policy qualification or synthetic native launch.
type watchdogDiagnosticMemoryChannel struct {
	reader                      *bytes.Reader
	writes                      bytes.Buffer
	closed                      bool
	readDeadline, writeDeadline time.Time
}

func (c *watchdogDiagnosticMemoryChannel) Read(raw []byte) (int, error) {
	if len(raw) > 7 {
		raw = raw[:7] // Exercise fragmented frames and partial EOF.
	}
	return c.reader.Read(raw)
}
func (c *watchdogDiagnosticMemoryChannel) Write(raw []byte) (int, error) {
	return c.writes.Write(raw)
}
func (c *watchdogDiagnosticMemoryChannel) Close() error { c.closed = true; return nil }
func (c *watchdogDiagnosticMemoryChannel) SetReadDeadline(deadline time.Time) error {
	c.readDeadline = deadline
	return nil
}
func (c *watchdogDiagnosticMemoryChannel) SetWriteDeadline(deadline time.Time) error {
	c.writeDeadline = deadline
	return nil
}

func TestWatchdogDiagnosticChannelPreservesIOAndOmitsPayload(t *testing.T) {
	const payload = "SYNTHETIC_PAYLOAD_NEVER_LOG"
	frame := []byte("{\"type\":\"stdout\",\"data\":\"" + payload + "\"}\n")
	raw := append(bytes.Clone(frame), []byte("{\"type\":\"stderr\"")...)
	underlying := &watchdogDiagnosticMemoryChannel{reader: bytes.NewReader(raw)}
	channel := &watchdogDiagnosticChannel{watchdogChannel: underlying}
	got, err := io.ReadAll(channel)
	if err != nil || !bytes.Equal(got, raw) || channel.watchdogChannel != underlying {
		t.Fatal("diagnostic wrapper changed owning channel IO")
	}
	state := channel.snapshot()
	digest := sha256.Sum256(frame)
	want := watchdogFrameDiagnostic{Type: "stdout", Bytes: len(frame), SHA256: hex.EncodeToString(digest[:]), Complete: true, JSONValid: true}
	if state.BytesRead != uint64(len(raw)) || state.ReadError != "eof" || len(state.Frames) != 2 ||
		state.Frames[0] != want || state.Frames[1].Complete || state.Frames[1].JSONValid {
		t.Fatal("incomplete or fragmented frame metadata changed")
	}
	deadline := time.Unix(123, 0)
	if channel.SetReadDeadline(deadline) != nil || channel.SetWriteDeadline(deadline) != nil ||
		underlying.readDeadline != deadline || underlying.writeDeadline != deadline {
		t.Fatal("underlying deadline delegation changed")
	}
	const outbound = "SYNTHETIC_OUTBOUND_CODE_INPUT_ENV_NEVER_CAPTURE"
	if n, err := channel.Write([]byte(outbound)); err != nil || n != len(outbound) ||
		underlying.writes.String() != outbound || channel.Close() != nil || !underlying.closed {
		t.Fatal("underlying write/close delegation changed")
	}
	recorded, _ := json.Marshal(channel.snapshot())
	if strings.Contains(string(recorded), payload) || strings.Contains(string(recorded), outbound) ||
		watchdogDiagnosticError(errors.New(payload)) != "other" {
		t.Fatal("diagnostic exposed payload or arbitrary error text")
	}
}

func TestWatchdogDiagnosticChannelEnforcesCaptureBounds(t *testing.T) {
	for _, fixture := range []struct {
		name, raw, stopped string
		frames             int
	}{
		{"frame", strings.Repeat("X", watchdogFrameLimit+1), "frame-byte-limit", 1},
		{"metadata", strings.Repeat("{\"type\":\"ready\"}\n", watchdogDiagnosticFrameLimit+1), "metadata-limit", watchdogDiagnosticFrameLimit},
		{"budget", strings.Repeat("{\"type\":\"stdout\",\"data\":\""+strings.Repeat("X", 70*1024)+"\"}\n", 5), "byte-limit", 4},
		{"unknown-type", "{\"type\":\"SYNTHETIC_TYPE_NEVER_LOG\"}\n", "", 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			underlying := &watchdogDiagnosticMemoryChannel{reader: bytes.NewReader([]byte(fixture.raw))}
			channel := &watchdogDiagnosticChannel{watchdogChannel: underlying}
			got, err := io.ReadAll(channel)
			state := channel.snapshot()
			if err != nil || string(got) != fixture.raw || state.Stopped != fixture.stopped ||
				state.BytesInspected > watchdogDiagnosticByteLimit || len(state.Frames) != fixture.frames {
				t.Fatal("capture budget changed underlying bytes or exceeded bounds")
			}
			for _, frame := range state.Frames {
				if frame.Bytes > watchdogFrameLimit || frame.Type == "SYNTHETIC_TYPE_NEVER_LOG" {
					t.Fatal("frame metadata exceeded bounds or exposed unknown type")
				}
			}
		})
	}
}

func TestWatchdogDiagnosticErrorReasonAllowlistAndRedaction(t *testing.T) {
	for _, reason := range []string{
		"invalid-prepare", "invalid-control", "invalid-start", "invalid-exit", "invalid-close",
		"command-error", "stdin-epipe", "stdin-error", "dispatch-exception",
	} {
		t.Run(reason, func(t *testing.T) {
			raw := []byte(`{"type":"error","reason":"` + reason + `","data":"PRIVATE_PAYLOAD","path":"PRIVATE_PATH","code":"PRIVATE_CODE","environment":"PRIVATE_ENV","message":"PRIVATE_EXCEPTION"}` + "\n")
			underlying := &watchdogDiagnosticMemoryChannel{reader: bytes.NewReader(raw)}
			channel := &watchdogDiagnosticChannel{watchdogChannel: underlying}
			got, err := io.ReadAll(channel)
			state := channel.snapshot()
			if err != nil || !bytes.Equal(got, raw) || len(state.Frames) != 1 ||
				state.Frames[0].Type != "error" || state.Frames[0].Reason != reason {
				t.Fatal("allowlisted error reason changed underlying IO or was lost")
			}
			recorded, err := json.Marshal(state)
			if err != nil || strings.Contains(string(recorded), "PRIVATE") {
				t.Fatal("diagnostic exposed arbitrary error fields")
			}
		})
	}
	for _, raw := range []string{
		`{"type":"error"}`, // Original generic error stays unclassified.
		`{"type":"error","reason":"PRIVATE_PATH_ENV_CODE_EXCEPTION"}`,
		`{"type":"error","reason":"EPIPE"}`,
		`{"type":"error","reason":"STDIN-EPIPE"}`,
		`{"type":"error","reason":null}`,
		`{"type":"error","reason":1}`,
		`{"type":"error","reason":{"text":"PRIVATE_EXCEPTION"}}`,
		`{"type":"error","reason":["stdin-epipe"]}`,
		`{"type":"error","reason":"stdin-epipe","reason":"PRIVATE_EXCEPTION"}`,
		`{"type":"error","reason":"stdin-epipe"`, // Truncated frame.
		`{"type":"stdout","reason":"stdin-epipe","data":"PRIVATE_STDOUT"}`,
		`{"type":"stderr","reason":"stdin-epipe","data":"PRIVATE_STDERR"}`,
		`{"type":"ready","reason":"stdin-epipe"}`,
		`{"type":"PRIVATE_TYPE","reason":"stdin-epipe"}`,
	} {
		metadata := watchdogFrameMetadata([]byte(raw), false)
		recorded, err := json.Marshal(metadata)
		if metadata.Reason != "" || err != nil || strings.Contains(string(recorded), "PRIVATE") {
			t.Fatal("non-error, malformed or unknown reason escaped diagnostic allowlist")
		}
	}
}

func TestWatchdogDiagnosticErrorFramesStillFenceProductionDecoder(t *testing.T) {
	for _, reason := range []string{
		"", "invalid-prepare", "invalid-control", "invalid-start", "invalid-exit", "invalid-close",
		"command-error", "stdin-epipe", "stdin-error", "dispatch-exception", "PRIVATE_UNKNOWN",
	} {
		t.Run(reason, func(t *testing.T) {
			id := strings.Repeat("a", 64)
			fields := map[string]string{"type": "error", "id": id}
			if reason != "" {
				fields["reason"] = reason
			}
			raw, err := json.Marshal(fields)
			if err != nil {
				t.Fatal("synthetic frame could not be encoded")
			}
			// Pure memory only: receive observes the error before any corrected
			// close. No host, process, socket, helper Wait, admission or launch.
			raw = append(raw, []byte("\n"+`{"type":"close","id":"`+id+`","code":0,"signal":null}`+"\n")...)
			underlying := &watchdogDiagnosticMemoryChannel{reader: bytes.NewReader(raw)}
			channel := &watchdogDiagnosticChannel{watchdogChannel: underlying}
			child := newWatchdogChild(nil, channel, time.Unix(123, 0), nil, io.Discard, io.Discard)
			child.id, child.preparedSeen, child.readySeen, child.startSent = id, true, true, true
			child.receive()
			if !child.uncertain || child.rootExited || child.rootClosed || child.bytes != 0 ||
				child.outputLimit || child.stopSeen || !underlying.closed {
				t.Fatal("diagnostic error changed production fence or claimed root facts")
			}
			select {
			case <-child.failed:
			default:
				t.Fatal("production decoder did not publish failure")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if child.send(ctx, watchdogControl{Type: "start", ID: id}) == nil ||
				child.Kill() == nil || child.Kill() == nil || underlying.writes.Len() != 0 ||
				child.event([]byte(`{"type":"ready","id":"`+id+`"}`)) == nil {
				t.Fatal("fenced decoder accepted corrected ACK, resend or new control dispatch")
			}
		})
	}
}
