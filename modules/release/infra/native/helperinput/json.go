// Package helperinput decodes the bounded existing installed-helper JSON input.
// It owns structure and encoding only; Release app owns semantic validation.
package helperinput

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

type JSONDecoder struct{}

var _ port.HelperInputDecoder = JSONDecoder{}
var errInput = errors.New("input")

func (JSONDecoder) Decode(input []byte) (port.HelperRequest, error) {
	var r port.HelperRequest
	if len(input) < 1 || len(input) > 8192 || !utf8.Valid(input) || !safeEscapes(input) {
		return r, errInput
	}
	m, ok := object(input,
		[]string{"schema", "action", "home", "operationId", "source", "target", "drain", "pid", "processStart", "waitSeconds", "relaunch"},
		[]string{"installLocation", "predecessor", "leaseIdentity"})
	if !ok || !texts(m, map[string]*string{"schema": &r.Schema, "action": &r.Action, "home": &r.Home, "operationId": &r.OperationID, "processStart": &r.ProcessStart}) ||
		!build(m["source"], &r.Source) || !build(m["target"], &r.Target) || !drain(m["drain"], &r.Drain) {
		return port.HelperRequest{}, errInput
	}
	var err error
	r.PID, err = strconv.ParseInt(string(bytes.TrimSpace(m["pid"])), 10, 64)
	if err != nil {
		return port.HelperRequest{}, errInput
	}
	r.WaitSeconds, err = strconv.Atoi(string(bytes.TrimSpace(m["waitSeconds"])))
	if err != nil {
		return port.HelperRequest{}, errInput
	}
	switch string(bytes.TrimSpace(m["relaunch"])) {
	case "true":
		r.Relaunch = true
	case "false":
	default:
		return port.HelperRequest{}, errInput
	}
	if raw, present := m["installLocation"]; present {
		var v string
		if !text(raw, &v) {
			return port.HelperRequest{}, errInput
		}
		r.InstallLocation = &v
	}
	if raw, present := m["predecessor"]; present {
		v := new(port.HelperPredecessor)
		p, ok := object(raw, []string{"kind", "startedAt", "lastQuitSha256", "stateIdentity"}, nil)
		if !ok || !texts(p, map[string]*string{"kind": &v.Kind, "startedAt": &v.StartedAt, "lastQuitSha256": &v.LastQuitSHA256}) || !identity(p["stateIdentity"], &v.StateIdentity) {
			return port.HelperRequest{}, errInput
		}
		r.Predecessor = v
	}
	if raw, present := m["leaseIdentity"]; present {
		v := new(port.HelperIdentity)
		if !identity(raw, v) {
			return port.HelperRequest{}, errInput
		}
		r.LeaseIdentity = v
	}
	return r, nil
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

func drain(raw []byte, out *port.HelperDrain) bool {
	m, ok := object(raw, []string{"status", "acceptedSource", "acceptedTarget"}, nil)
	return ok && texts(m, map[string]*string{"status": &out.Status, "acceptedSource": &out.AcceptedSource, "acceptedTarget": &out.AcceptedTarget})
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
