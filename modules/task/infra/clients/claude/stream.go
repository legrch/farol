package claude

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/domain"
)

const StreamLimit = 65536
const ResultLimit = 32768

type Expected struct{ SessionID, Cwd, Model, PermissionMode string }
type ObservedModel struct{ SessionID, Cwd, Model, PermissionMode, Evidence, EffortEvidence string }
type Result struct {
	Lifecycle task.Lifecycle
	Text      string
}
type Event struct{ Kind, Text string }
type Snapshot struct {
	Observed       ObservedModel
	ProviderResult *Result
	Bytes          uint64
	Ended, Unknown bool
}
type Stream struct {
	mu            sync.Mutex
	expected      Expected
	pending       []byte
	snapshot      Snapshot
	failed, ended bool
}

func NewStream(e Expected) (*Stream, error) {
	if !sessionShape.MatchString(e.SessionID) || !task.Text(e.Cwd, 4096) || !task.ID(e.Model) || e.PermissionMode != "default" {
		return nil, task.ErrInvalid
	}
	return &Stream{expected: e}, nil
}

// Feed parses bounded actual bytes. Useful text is transient opt-in output,
// never retained transcript or permission to execute a tool. Failure is sticky.
func (s *Stream) Feed(fragment []byte) (events []Event, err error) {
	if s == nil {
		return nil, task.ErrUnavailable
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed {
		return nil, task.ErrUnknown
	}
	if s.ended {
		return nil, task.ErrState
	}
	defer func() {
		if err != nil {
			s.failed = true
			s.pending = nil
			events = nil
		}
	}()
	if len(fragment) > StreamLimit-int(s.snapshot.Bytes) || bytes.IndexByte(fragment, 0) >= 0 {
		return nil, task.ErrInvalid
	}
	s.snapshot.Bytes += uint64(len(fragment))
	s.pending = append(s.pending, fragment...)
	for {
		end := bytes.IndexByte(s.pending, '\n')
		if end < 0 {
			return events, nil
		}
		line := bytes.TrimSuffix(s.pending[:end], []byte("\r"))
		if len(bytes.TrimSpace(line)) == 0 || !utf8.Valid(line) || strictJSON(line) != nil {
			return nil, task.ErrInvalid
		}
		event, parseErr := s.record(line)
		if parseErr != nil {
			return nil, parseErr
		}
		if event.Kind != "" {
			events = append(events, event)
		}
		s.pending = bytes.Clone(s.pending[end+1:])
	}
}
func (s *Stream) Finish() error {
	if s == nil {
		return task.ErrUnavailable
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed {
		return task.ErrUnknown
	}
	if s.ended {
		return task.ErrState
	}
	if len(s.pending) != 0 || s.snapshot.Observed.Evidence == "" || s.snapshot.ProviderResult == nil {
		s.failed = true
		s.pending = nil
		return task.ErrUnknown
	}
	s.ended = true
	s.snapshot.Ended = true
	return nil
}
func (s *Stream) Snapshot() Snapshot {
	if s == nil {
		return Snapshot{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.snapshot
	out.Unknown = s.failed
	if s.failed {
		out.ProviderResult = nil
	}
	if out.ProviderResult != nil {
		copy := *out.ProviderResult
		out.ProviderResult = &copy
	}
	return out
}
func object(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var m map[string]json.RawMessage
	err := json.Unmarshal(raw, &m)
	return m, err == nil && m != nil
}
func str(m map[string]json.RawMessage, k string) (string, bool) {
	var v string
	r, ok := m[k]
	if !ok || bytes.Equal(bytes.TrimSpace(r), []byte("null")) {
		return "", false
	}
	err := json.Unmarshal(r, &v)
	return v, err == nil
}
func eq(m map[string]json.RawMessage, k, want string) bool {
	v, ok := str(m, k)
	return ok && v == want
}
func (s *Stream) record(line []byte) (Event, error) {
	m, ok := object(line)
	if !ok {
		return Event{}, task.ErrInvalid
	}
	if s.snapshot.ProviderResult != nil {
		return Event{}, task.ErrInvalid
	}
	kind, ok := str(m, "type")
	if !ok {
		return Event{}, task.ErrInvalid
	}
	session, hasSession := m["session_id"]
	if hasSession {
		var v string
		if json.Unmarshal(session, &v) != nil || v != s.expected.SessionID {
			return Event{}, task.ErrIdentity
		}
	}
	subtype, _ := str(m, "subtype")
	initialized := s.snapshot.Observed.Evidence != ""
	if kind == "system" && subtype == "init" {
		if initialized || !eq(m, "session_id", s.expected.SessionID) || !eq(m, "cwd", s.expected.Cwd) || !eq(m, "model", s.expected.Model) || !eq(m, "permissionMode", s.expected.PermissionMode) {
			return Event{}, task.ErrIdentity
		}
		s.snapshot.Observed = ObservedModel{s.expected.SessionID, s.expected.Cwd, s.expected.Model, s.expected.PermissionMode, "provider_reported", "unknown"}
		return Event{Kind: "initialized"}, nil
	}
	if !initialized {
		if kind == "system" && (subtype == "plugin_install" || subtype == "hook_started" || subtype == "hook_progress" || subtype == "hook_response") {
			return Event{}, nil
		}
		return Event{}, task.ErrState
	}
	switch kind {
	case "assistant":
		message, ok := object(m["message"])
		if !ok {
			return Event{}, task.ErrInvalid
		}
		var contents []map[string]json.RawMessage
		if bytes.Equal(bytes.TrimSpace(message["content"]), []byte("null")) || json.Unmarshal(message["content"], &contents) != nil {
			return Event{}, task.ErrInvalid
		}
		var text strings.Builder
		for _, item := range contents {
			t, ok := str(item, "type")
			if !ok {
				return Event{}, task.ErrInvalid
			}
			switch t {
			case "text":
				v, ok := str(item, "text")
				if !ok || strings.ContainsRune(v, 0) || len(v) > ResultLimit-text.Len() {
					return Event{}, task.ErrInvalid
				}
				text.WriteString(v)
			case "tool_use", "thinking", "redacted_thinking": // Data only; never execute, persist or expose reasoning.
			default:
				return Event{}, task.ErrUnsupported
			}
		}
		if text.Len() > 0 {
			return Event{Kind: "output_delta", Text: text.String()}, nil
		}
		return Event{}, nil
	case "user", "stream_event", "system", "rate_limit_event":
		return Event{}, nil
	case "result":
		if !eq(m, "session_id", s.expected.SessionID) {
			return Event{}, task.ErrIdentity
		}
		var failed bool
		flag, present := m["is_error"]
		if !present || bytes.Equal(bytes.TrimSpace(flag), []byte("null")) || json.Unmarshal(flag, &failed) != nil {
			return Event{}, task.ErrInvalid
		}
		var denials []map[string]json.RawMessage
		raw := m["permission_denials"]
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &denials) != nil || len(denials) > 50 {
			return Event{}, task.ErrInvalid
		}
		for _, denial := range denials {
			if denial == nil {
				return Event{}, task.ErrInvalid
			}
		}
		if !failed && subtype != "success" {
			return Event{}, task.ErrInvalid
		}
		if failed && subtype != "error_during_execution" && subtype != "error_max_turns" && subtype != "error_max_budget_usd" && subtype != "error_max_structured_output_retries" {
			return Event{}, task.ErrInvalid
		}
		text, have := str(m, "result")
		_, exists := m["result"]
		if !have && (!failed || exists) {
			return Event{}, task.ErrInvalid
		}
		if len(text) > ResultLimit || strings.ContainsRune(text, 0) {
			return Event{}, task.ErrInvalid
		}
		lifecycle := task.Completed
		if failed {
			lifecycle = task.Failed
		}
		if len(denials) > 0 {
			lifecycle = task.NeedsInput
		}
		s.snapshot.ProviderResult = &Result{lifecycle, text}
		return Event{Kind: "provider_result"}, nil
	default:
		return Event{}, task.ErrUnsupported
	}
}

// Duplicate keys, ambiguous case, depth and object-count limits are checked
// before field extraction. JSON decoders do not silently normalize identities.
func strictJSON(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	remaining := 8192
	var read func(int) error
	read = func(depth int) error {
		remaining--
		if depth > 32 || remaining < 0 {
			return task.ErrInvalid
		}
		token, err := d.Token()
		if err != nil {
			return task.ErrInvalid
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			keys := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return task.ErrInvalid
				}
				name, ok := key.(string)
				if !ok || keys[strings.ToLower(name)] {
					return task.ErrInvalid
				}
				keys[strings.ToLower(name)] = true
				if err := read(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return task.ErrInvalid
			}
		case '[':
			for d.More() {
				if err := read(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return task.ErrInvalid
			}
		default:
			return task.ErrInvalid
		}
		return nil
	}
	if err := read(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return task.ErrInvalid
	}
	return nil
}
