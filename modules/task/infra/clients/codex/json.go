package codex

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

// Reject duplicate keys, invalid UTF-8, excessive nesting and trailing values
// before extracting exact case-sensitive vendor fields. Extensions remain legal.
func parse(raw []byte) (map[string]json.RawMessage, error) {
	if len(raw) == 0 || len(raw) > maxMessageBytes || !utf8.Valid(raw) {
		return nil, protocolError()
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	remaining := 100000
	if err := value(d, 0, &remaining); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, protocolError()
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return nil, protocolError()
	}
	return m, nil
}
func value(d *json.Decoder, depth int, remaining *int) error {
	*remaining--
	if depth > 64 || *remaining < 0 {
		return protocolError()
	}
	t, err := d.Token()
	if err != nil {
		return protocolError()
	}
	x, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch x {
	case '{':
		keys := map[string]bool{}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return protocolError()
			}
			s, ok := k.(string)
			if !ok || keys[s] {
				return protocolError()
			}
			keys[s] = true
			if err := value(d, depth+1, remaining); err != nil {
				return err
			}
		}
		t, err := d.Token()
		if err != nil || t != json.Delim('}') {
			return protocolError()
		}
	case '[':
		for d.More() {
			if err := value(d, depth+1, remaining); err != nil {
				return err
			}
		}
		t, err := d.Token()
		if err != nil || t != json.Delim(']') {
			return protocolError()
		}
	default:
		return protocolError()
	}
	return nil
}
func object(m map[string]json.RawMessage, key string) (map[string]json.RawMessage, bool) {
	raw, ok := m[key]
	if !ok {
		return nil, false
	}
	out, err := parse(raw)
	return out, err == nil
}
func str(m map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := m[key]
	if !ok || bytes.Equal(raw, []byte("null")) {
		return "", false
	}
	var s string
	err := json.Unmarshal(raw, &s)
	return s, err == nil
}
func boolean(m map[string]json.RawMessage, key string) (bool, bool) {
	raw, ok := m[key]
	if !ok || bytes.Equal(raw, []byte("null")) {
		return false, false
	}
	var b bool
	err := json.Unmarshal(raw, &b)
	return b, err == nil
}
func array(m map[string]json.RawMessage, key string, max int) ([]json.RawMessage, bool) {
	raw, ok := m[key]
	if !ok || bytes.Equal(raw, []byte("null")) {
		return nil, false
	}
	var a []json.RawMessage
	err := json.Unmarshal(raw, &a)
	return a, err == nil && len(a) <= max
}
func equals(m map[string]json.RawMessage, key, expected string) bool {
	s, ok := str(m, key)
	return ok && s == expected
}
func next(m map[string]json.RawMessage) (string, bool, bool) {
	raw, ok := m["nextCursor"]
	if !ok {
		return "", false, false
	}
	if bytes.Equal(raw, []byte("null")) {
		return "", true, true
	}
	s, ok := str(m, "nextCursor")
	return s, false, ok && token(s, 4096)
}
