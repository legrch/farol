package process

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

const watchdogInputLimit = 2 * 1024 * 1024
const watchdogFrameLimit = 96 * 1024
const watchdogChunkLimit = 48 * 1024

// Compact one-byte output frames need at most 416 MiB at MaximumOutput.
// Allow that fragmentation plus controls, while bounding padded JSON work.
const watchdogWireLimit = 512 * 1024 * 1024

// Node's existing JSON serialization uses newline-delimited private IPC. These
// values are resource-specific messages, not another public authority protocol.
type watchdogPrepare struct {
	Type        string            `json:"type"`
	ID          string            `json:"id"`
	Executable  string            `json:"executable"`
	Args        []string          `json:"args"`
	Cwd         string            `json:"cwd"`
	Environment map[string]string `json:"environment"`
	Stdin       string            `json:"stdinBase64"`
	Deadline    int64             `json:"deadlineAt"`
}
type watchdogControl struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}
type watchdogEvent struct {
	Type   string  `json:"type"`
	ID     string  `json:"id"`
	Data   *string `json:"data"`
	Code   *int    `json:"code"`
	Signal *int    `json:"signal"`
}

type watchdogChild struct {
	mutex, writes                                                  sync.Mutex
	process                                                        watchdogProcess
	channel                                                        watchdogChannel
	deadline                                                       time.Time
	clock                                                          port.Clock
	stdout, stderr                                                 io.Writer
	id                                                             string
	prepared, ready, stopAck                                       chan struct{}
	done, failed                                                   chan struct{}
	closeOnce, failOnce                                            sync.Once
	preparedSeen, readySeen, startSent, stopSent, stopSeen, waited bool
	uncertain, rootExited, rootClosed, outputLimit                 bool
	root                                                           exit
	bytes                                                          int
	cancel                                                         context.CancelFunc
}

func newWatchdogChild(process watchdogProcess, channel watchdogChannel, deadline time.Time, clock port.Clock, stdout, stderr io.Writer) *watchdogChild {
	return &watchdogChild{process: process, channel: channel, deadline: deadline, clock: clock, stdout: stdout, stderr: stderr,
		prepared: make(chan struct{}), ready: make(chan struct{}), stopAck: make(chan struct{}), done: make(chan struct{}), failed: make(chan struct{})}
}
func (c *watchdogChild) close() {
	c.closeOnce.Do(func() {
		if c.channel != nil {
			_ = c.channel.Close()
		}
	})
}
func (c *watchdogChild) fence() {
	c.mutex.Lock()
	c.uncertain = true
	c.mutex.Unlock()
	// Helper Wait may remain unresolved after a refused stop. Publish uncertainty
	// now in the same observation owner, without changing known root/output facts.
	if writer, ok := c.stdout.(output); ok {
		child := writer.child
		child.mutex.Lock()
		child.group, child.descendants = processsvc.CleanupUnverified, processsvc.CleanupUnverified
		if child.supervisor != "" {
			child.supervisor = processsvc.SupervisorUnknown
		}
		child.mutex.Unlock()
	}
	c.failOnce.Do(func() { close(c.failed) })
	c.close()
}
func (c *watchdogChild) await(ctx context.Context, event <-chan struct{}) error {
	select {
	case <-event:
		c.mutex.Lock()
		bad := c.uncertain
		c.mutex.Unlock()
		if !bad && ctx.Err() == nil && c.clock.Now().Before(c.deadline) {
			return nil
		}
	case <-c.failed:
	case <-ctx.Done():
	}
	return &processsvc.NativeFailure{Unknown: true}
}
func (c *watchdogChild) send(ctx context.Context, message any) error {
	c.writes.Lock()
	defer c.writes.Unlock()
	if ctx == nil || ctx.Err() != nil || c.channel == nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	raw, err := json.Marshal(message)
	if err != nil || len(raw)+1 > watchdogInputLimit {
		return &processsvc.NativeFailure{}
	}
	c.mutex.Lock()
	bad := c.uncertain
	if control, ok := message.(watchdogControl); ok && control.Type == "start" {
		bad = bad || !c.preparedSeen || c.startSent || c.stopSent
		c.startSent = true // Attempt consumed BEFORE writing, including short/lost ACK.
	}
	c.mutex.Unlock()
	if bad {
		return &processsvc.NativeFailure{Unknown: true}
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return &processsvc.NativeFailure{}
	}
	if c.channel.SetWriteDeadline(deadline) != nil {
		c.fence()
		return &processsvc.NativeFailure{Unknown: true}
	}
	raw = append(raw, '\n')
	n, err := c.channel.Write(raw)
	if err != nil || n != len(raw) {
		c.fence()
		return &processsvc.NativeFailure{Unknown: true}
	}
	return nil
}

// Kill sends one stop on the exact retained IPC, never signals a numeric ID.
// Local send completion and stop-requested ACK are not cleanup evidence.
func (c *watchdogChild) Kill() error {
	c.mutex.Lock()
	if c.stopSent || c.uncertain {
		c.mutex.Unlock()
		return &processsvc.NativeFailure{Unknown: true}
	}
	c.stopSent = true
	c.mutex.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if c.send(ctx, watchdogControl{Type: "stop", ID: c.id}) != nil || c.await(ctx, c.stopAck) != nil {
		c.fence()
		return &processsvc.NativeFailure{Unknown: true}
	}
	return nil
}

func (c *watchdogChild) receive() {
	c.receiveBounded(watchdogWireLimit)
}

func (c *watchdogChild) receiveBounded(remaining int) {
	defer close(c.done)
	if c.channel.SetReadDeadline(c.deadline) != nil {
		c.fence()
		return
	}
	reader := bufio.NewReaderSize(c.channel, watchdogFrameLimit)
	// Bound output by decoded bytes, independent of pipe fragmentation. Every
	// accepted output frame consumes at least one byte of MaximumOutput; each
	// control transition is single-use. Frame size and the original read deadline
	// remain bounded. A fixed frame count could discard a small valid output
	// stream before its exit/close observations arrived.
	for {
		raw, err := reader.ReadSlice('\n')
		if err != nil {
			c.mutex.Lock()
			known := err == io.EOF && len(raw) == 0 && c.rootClosed
			c.mutex.Unlock()
			if !known {
				c.fence()
			}
			return
		}
		if len(raw) > watchdogFrameLimit || len(raw) > remaining {
			c.fence()
			return
		}
		remaining -= len(raw)
		if c.event(raw) != nil {
			c.fence()
			return
		}
	}
}

func (c *watchdogChild) event(raw []byte) error {
	if len(raw) > watchdogFrameLimit || !validWatchdogJSON(raw) {
		return errors.New("invalid watchdog observation")
	}
	var fields map[string]json.RawMessage
	var event watchdogEvent
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &event) != nil || event.ID != c.id {
		return errors.New("crossed watchdog observation")
	}
	keys := func(expected ...string) bool {
		if len(fields) != len(expected) {
			return false
		}
		for _, key := range expected {
			if _, ok := fields[key]; !ok {
				return false
			}
		}
		return true
	}
	c.mutex.Lock()
	if c.uncertain {
		c.mutex.Unlock()
		return errors.New("fenced watchdog")
	}
	var writer io.Writer
	var data []byte
	var observed *exit
	valid := false
	switch event.Type {
	case "prepared":
		valid = keys("type", "id") && !c.preparedSeen && !c.startSent && !c.stopSent
		if valid {
			c.preparedSeen = true
			close(c.prepared)
		}
	case "ready":
		valid = keys("type", "id") && c.preparedSeen && c.startSent && !c.readySeen && !c.rootClosed && !c.stopSent
		if valid {
			c.readySeen = true
			close(c.ready)
		}
	case "stdout", "stderr":
		valid = keys("type", "id", "data") && c.readySeen && !c.rootClosed && event.Data != nil
		if valid {
			var err error
			data, err = base64.StdEncoding.Strict().DecodeString(*event.Data)
			valid = err == nil && len(data) > 0 && len(data) <= watchdogChunkLimit && base64.StdEncoding.EncodeToString(data) == *event.Data
			if valid && c.bytes+len(data) > processsvc.MaximumOutput {
				c.outputLimit, valid = true, false
			}
			if valid {
				c.bytes += len(data)
				writer = c.stdout
				if event.Type == "stderr" {
					writer = c.stderr
				}
			}
		}
	case "exit", "close":
		valid = keys("type", "id", "code", "signal") && c.readySeen && !c.rootClosed &&
			(event.Code != nil && *event.Code >= 0 && *event.Code <= 255 && event.Signal == nil || event.Code == nil && event.Signal != nil && *event.Signal > 0 && *event.Signal <= 128)
		if valid && c.rootExited {
			valid = event.Type == "close" && sameWatchdogExit(c.root, event)
		}
		if valid {
			c.rootExited = true
			c.rootClosed = event.Type == "close"
			c.root = exit{Code: copyCode(event.Code), Waited: true, Drained: c.rootClosed && !c.outputLimit}
			if event.Signal != nil {
				c.root.Signal = *event.Signal
			}
			root := c.root
			observed = &root
		}
	case "stop-requested":
		valid = keys("type", "id") && c.stopSent && !c.stopSeen
		if valid {
			c.stopSeen = true
			close(c.stopAck)
		}
	case "error", "signal-refused", "output-limit", "deadline":
		valid = false // Any such observation freezes; no corrected ACK or resend.
		if event.Type == "output-limit" && keys("type", "id") && c.readySeen && !c.rootClosed {
			c.outputLimit = true
		}
	}
	limited := c.outputLimit
	c.mutex.Unlock()
	if observed != nil {
		// Publish root facts in the SAME retained Child while helper Wait and
		// its existing current-authority/deadline watches remain outstanding.
		// An exited shell must not hide behind a descendant's still-open pipe.
		if writer, ok := c.stdout.(output); ok {
			child := writer.child
			child.mutex.Lock()
			child.root, child.waited, child.drained = processsvc.RootExited, true, observed.Drained
			child.code, child.signal = copyCode(observed.Code), observed.Signal
			child.group, child.descendants = processsvc.CleanupUnverified, processsvc.CleanupUnverified
			child.mutex.Unlock()
		}
	}
	if limited {
		// Use the existing retained output owner for a truthful limit flag, not
		// a fabricated overflow write or another journal/lifecycle producer.
		if writer, ok := c.stdout.(output); ok {
			writer.child.mutex.Lock()
			writer.child.outputLimit = true
			writer.child.mutex.Unlock()
		}
	}
	if !valid {
		return errors.New("unknown watchdog observation")
	}
	if writer != nil {
		n, err := writer.Write(data)
		if err != nil || n != len(data) {
			return errors.New("watchdog output unavailable")
		}
	}
	return nil
}

func (c *watchdogChild) Wait() (exit, error) {
	c.mutex.Lock()
	if c.waited {
		c.mutex.Unlock()
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	c.waited = true
	c.mutex.Unlock()
	defer c.close()
	if c.cancel != nil {
		defer c.cancel()
	}
	helperErr := c.process.Wait() // Exact Go-owned helper, once; never a reconstructed PID.
	if c.channel != nil {
		<-c.done
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if !c.rootExited {
		return exit{}, &processsvc.NativeFailure{Unknown: true}
	}
	result := c.root
	result.Code = copyCode(result.Code)
	result.Drained = result.Drained && !c.uncertain
	result.supervisorExited = helperErr == nil && c.rootClosed && result.Drained && !c.uncertain
	// Retain known root exit even when helper/IPC/cleanup is uncertain. The
	// existing Child keeps cleanup unverified. Only the separate supervisor fact
	// can preserve a known root result; this NEVER supplies cohort=true.
	return result, nil
}

func sameWatchdogExit(root exit, event watchdogEvent) bool {
	if root.Code != nil {
		return event.Code != nil && *root.Code == *event.Code && event.Signal == nil
	}
	return event.Code == nil && event.Signal != nil && root.Signal == *event.Signal
}

// Strict duplicate/depth/UTF-8 validation for this private resource channel.
func validWatchdogJSON(raw []byte) bool {
	if !utf8.Valid(raw) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 8 {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return true
		}
		if delim != '{' && delim != '[' {
			return false
		}
		seen := map[string]bool{}
		for decoder.More() {
			if delim == '{' {
				key, err := decoder.Token()
				name, ok := key.(string)
				if err != nil || !ok || seen[name] {
					return false
				}
				seen[name] = true
			}
			if !value(depth + 1) {
				return false
			}
		}
		end, err := decoder.Token()
		return err == nil && (delim == '{' && end == json.Delim('}') || delim == '[' && end == json.Delim(']'))
	}
	if !value(0) {
		return false
	}
	_, err := decoder.Token()
	return err == io.EOF
}
