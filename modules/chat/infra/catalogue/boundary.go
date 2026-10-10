// Package catalogue maps bounded provider catalogues into account-scoped values.
// It performs no OAuth, token discovery, entitlement check or automatic retry.
package catalogue

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid       Code = "MODEL_CATALOGUE_INVALID"
	Unavailable   Code = "MODEL_CATALOGUE_UNAVAILABLE"
	ScopeMismatch Code = "MODEL_CATALOGUE_SCOPE_MISMATCH"
	Superseded    Code = "MODEL_CATALOGUE_SUPERSEDED"
	Missing       Code = "MODEL_CATALOGUE_MISSING"
)

const MaxBytes = 1024 * 1024
const MaxRows = 2000
const PageRows = 100

// Token parsing rejects duplicate keys, trailing values and excessive nesting.
// Unknown fields are tolerated only within the same object/string/byte bounds.
func object(raw []byte) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > MaxBytes || !utf8.Valid(raw) {
		return nil, Invalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := value(d, 0)
	if err != nil {
		return nil, Invalid
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, Invalid
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, Invalid
	}
	return m, nil
}

func value(d *json.Decoder, depth int) (any, error) {
	if depth > 16 {
		return nil, Invalid
	}
	t, err := d.Token()
	if err != nil {
		return nil, Invalid
	}
	if x, ok := t.(json.Delim); ok {
		switch x {
		case '{':
			m := map[string]any{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return nil, Invalid
				}
				s, ok := k.(string)
				if !ok || len(s) > 120 || len(m) >= 64 {
					return nil, Invalid
				}
				if _, exists := m[s]; exists {
					return nil, Invalid
				}
				v, err := value(d, depth+1)
				if err != nil {
					return nil, err
				}
				m[s] = v
			}
			if end, err := d.Token(); err != nil || end != json.Delim('}') {
				return nil, Invalid
			}
			return m, nil
		case '[':
			a := []any{}
			for d.More() {
				if len(a) >= MaxRows {
					return nil, Invalid
				}
				v, err := value(d, depth+1)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			if end, err := d.Token(); err != nil || end != json.Delim(']') {
				return nil, Invalid
			}
			return a, nil
		default:
			return nil, Invalid
		}
	}
	if s, ok := t.(string); ok && len(s) > 4096 {
		return nil, Invalid
	}
	return t, nil
}

func text(m map[string]any, k string, max int, empty bool) (string, bool) {
	s, ok := m[k].(string)
	if !ok || len(s) > max || strings.TrimSpace(s) != s || (!empty && s == "") {
		return "", false
	}
	for _, c := range s {
		if unicode.IsControl(c) {
			return "", false
		}
	}
	return s, true
}

func token(s string, max int) bool {
	if len(s) < 1 || len(s) > max {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.:/", c)) {
			return false
		}
	}
	return true
}
