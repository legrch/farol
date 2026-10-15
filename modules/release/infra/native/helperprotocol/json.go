// Package helperprotocol implements structural JSON framing for the existing
// installed helper. Application policy owns all semantic authorization.
package helperprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

// JSONCodec returns only closed error codes: helper_protocol_size for byte-limit
// refusal, helper_protocol_encoding for invalid Handoff Unicode/encoding, and
// helper_protocol_input for invalid Continue structure/Unicode. No wire data is
// included in errors. These classifications grant no application authority.
type JSONCodec struct{}

var _ port.HelperProtocolCodec = JSONCodec{}

var (
	errEncoding = errors.New("helper_protocol_encoding")
	errInput    = errors.New("helper_protocol_input")
	errSize     = errors.New("helper_protocol_size")
)

const maxFrame = 4096

// These independent wire records fix producer order: schema, phase, correlation
// (operationId through leaseIdentity), error; Build digest/version/buildId;
// predecessor kind/startedAt/lastQuitSha256/stateIdentity; identity device/inode.
type wireBuild struct {
	Digest  string `json:"digest"`
	Version string `json:"version"`
	BuildID string `json:"buildId"`
}

type wireIdentity struct {
	Device string `json:"device"`
	Inode  string `json:"inode"`
}

type wirePredecessor struct {
	Kind           string       `json:"kind"`
	StartedAt      string       `json:"startedAt"`
	LastQuitSHA256 string       `json:"lastQuitSha256"`
	StateIdentity  wireIdentity `json:"stateIdentity"`
}

type wireHandoff struct {
	Schema        string           `json:"schema"`
	Phase         string           `json:"phase"`
	OperationID   string           `json:"operationId"`
	Action        string           `json:"action"`
	Source        wireBuild        `json:"source"`
	Target        wireBuild        `json:"target"`
	PID           int64            `json:"pid"`
	ProcessStart  string           `json:"processStart"`
	Predecessor   *wirePredecessor `json:"predecessor,omitempty"`
	LeaseIdentity *wireIdentity    `json:"leaseIdentity,omitempty"`
	Error         *string          `json:"error,omitempty"`
}

func (JSONCodec) Handoff(frame port.HelperHandoffFrame) ([]byte, error) {
	c := frame.Correlation
	w := wireHandoff{
		Schema: frame.Schema, Phase: frame.Phase, OperationID: c.OperationID,
		Action: c.Action, Source: wireBuild{c.Source.Digest, c.Source.Version, c.Source.BuildID},
		Target: wireBuild{c.Target.Digest, c.Target.Version, c.Target.BuildID},
		PID:    c.PID, ProcessStart: c.ProcessStart,
	}
	values := []string{w.Schema, w.Phase, w.OperationID, w.Action, w.Source.Digest,
		w.Source.Version, w.Source.BuildID, w.Target.Digest, w.Target.Version,
		w.Target.BuildID, w.ProcessStart}
	if c.Predecessor != nil {
		p := c.Predecessor
		w.Predecessor = &wirePredecessor{p.Kind, p.StartedAt, p.LastQuitSHA256,
			wireIdentity{p.StateIdentity.Device, p.StateIdentity.Inode}}
		values = append(values, p.Kind, p.StartedAt, p.LastQuitSHA256, p.StateIdentity.Device, p.StateIdentity.Inode)
	}
	if c.LeaseIdentity != nil {
		w.LeaseIdentity = &wireIdentity{c.LeaseIdentity.Device, c.LeaseIdentity.Inode}
		values = append(values, c.LeaseIdentity.Device, c.LeaseIdentity.Inode)
	}
	if frame.Error != nil {
		v := *frame.Error
		w.Error = &v
		values = append(values, v)
	}
	for _, value := range values {
		if !utf8.ValidString(value) {
			return nil, errEncoding
		}
		if len(value) > maxFrame {
			return nil, errSize
		}
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if e.Encode(w) != nil {
		return nil, errEncoding
	}
	// Python ensure_ascii=True also escapes DEL and uses UTF-16 surrogate
	// pairs for non-BMP characters. Count the expanded bytes, including LF.
	return pythonASCII(b.String(), maxFrame)
}

func pythonASCII(text string, limit int) ([]byte, error) {
	out := make([]byte, 0, limit)
	for _, r := range text {
		if r < 0x7f {
			out = append(out, byte(r))
		} else if r <= 0xffff {
			out = appendEscape(out, uint16(r))
		} else {
			r -= 0x10000
			out = appendEscape(out, uint16(0xd800+(r>>10)))
			out = appendEscape(out, uint16(0xdc00+(r&0x3ff)))
		}
		if len(out) > limit {
			return nil, errSize
		}
	}
	return out, nil
}

func appendEscape(out []byte, n uint16) []byte {
	const hex = "0123456789abcdef"
	return append(out, '\\', 'u', hex[n>>12], hex[(n>>8)&15], hex[(n>>4)&15], hex[n&15])
}

func (JSONCodec) Continue(input []byte) (port.HelperContinueFrame, error) {
	if len(input) > maxFrame {
		return port.HelperContinueFrame{}, errSize
	}
	if len(input) < 1 || !utf8.Valid(input) || !safeEscapes(input) {
		return port.HelperContinueFrame{}, errInput
	}
	var out port.HelperContinueFrame
	c := &out.Correlation
	m, ok := object(input, []string{"schema", "operationId", "action", "source", "target", "pid", "processStart"}, []string{"predecessor", "leaseIdentity"})
	if !ok || !texts(m, map[string]*string{"schema": &out.Schema, "operationId": &c.OperationID, "action": &c.Action, "processStart": &c.ProcessStart}) ||
		!build(m["source"], &c.Source) || !build(m["target"], &c.Target) {
		return port.HelperContinueFrame{}, errInput
	}
	var err error
	c.PID, err = strconv.ParseInt(string(bytes.TrimSpace(m["pid"])), 10, 64)
	if err != nil {
		return port.HelperContinueFrame{}, errInput
	}
	if raw, present := m["predecessor"]; present {
		p := new(port.HelperPredecessor)
		fields, ok := object(raw, []string{"kind", "startedAt", "lastQuitSha256", "stateIdentity"}, nil)
		if !ok || !texts(fields, map[string]*string{"kind": &p.Kind, "startedAt": &p.StartedAt, "lastQuitSha256": &p.LastQuitSHA256}) || !identity(fields["stateIdentity"], &p.StateIdentity) {
			return port.HelperContinueFrame{}, errInput
		}
		c.Predecessor = p
	}
	if raw, present := m["leaseIdentity"]; present {
		p := new(port.HelperIdentity)
		if !identity(raw, p) {
			return port.HelperContinueFrame{}, errInput
		}
		c.LeaseIdentity = p
	}
	return out, nil
}

// Every object has a closed key set. Token keys are decoded before duplicate
// checks, so a key and its escaped spelling cannot overwrite one another.
func object(raw []byte, required, optional []string) (map[string]json.RawMessage, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return nil, false
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	m := make(map[string]json.RawMessage, len(allowed))
	for d.More() {
		t, err = d.Token()
		if err != nil {
			return nil, false
		}
		key, ok := t.(string)
		if !ok || !allowed[key] {
			return nil, false
		}
		if _, duplicate := m[key]; duplicate {
			return nil, false
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, false
		}
		m[key] = value
	}
	if t, err = d.Token(); err != nil || t != json.Delim('}') {
		return nil, false
	}
	var extra json.RawMessage
	if d.Decode(&extra) != io.EOF {
		return nil, false
	}
	for _, key := range required {
		if _, present := m[key]; !present {
			return nil, false
		}
	}
	return m, true
}

func text(raw []byte, out *string) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) >= 2 && raw[0] == '"' && json.Unmarshal(raw, out) == nil
}

func texts(m map[string]json.RawMessage, fields map[string]*string) bool {
	for key, out := range fields {
		if !text(m[key], out) {
			return false
		}
	}
	return true
}

func build(raw []byte, out *port.HelperBuild) bool {
	m, ok := object(raw, []string{"digest", "version", "buildId"}, nil)
	return ok && texts(m, map[string]*string{"digest": &out.Digest, "version": &out.Version, "buildId": &out.BuildID})
}

func identity(raw []byte, out *port.HelperIdentity) bool {
	m, ok := object(raw, []string{"device", "inode"}, nil)
	return ok && texts(m, map[string]*string{"device": &out.Device, "inode": &out.Inode})
}

// encoding/json replaces unpaired UTF-16 escapes. Reject them before decoding
// either values or keys; paired escapes and literal Unicode remain valid.
func safeEscapes(raw []byte) bool {
	inside := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inside = !inside
		}
		if !inside || raw[i] != '\\' || i+1 >= len(raw) {
			continue
		}
		if raw[i+1] != 'u' {
			i++
			continue
		}
		if i+6 > len(raw) {
			return false
		}
		n, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
		if err != nil {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+12 > len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 11
		} else {
			if n >= 0xdc00 && n <= 0xdfff {
				return false
			}
			i += 5
		}
	}
	return true
}
