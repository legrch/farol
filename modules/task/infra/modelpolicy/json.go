// Package modelpolicy supplies native, deterministic Task policy adapters.
package modelpolicy

import (
	"bytes"
	"encoding/json"
	"errors"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/app/port"
)

type JSONDecoder struct{}

var errInvalid = errors.New("invalid Task model policy JSON")

func (JSONDecoder) DecodePolicy(raw []byte) (*port.TaskModelPolicy, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	v, err := decode(raw, 1<<20)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	o, ok := object(v, "defaultHarness", "harnesses")
	if !ok {
		return nil, errInvalid
	}
	name, ok := o["defaultHarness"].(string)
	if !ok {
		return nil, errInvalid
	}
	harnesses, ok := o["harnesses"].(map[string]any)
	if !ok {
		return nil, errInvalid
	}
	p := &port.TaskModelPolicy{DefaultHarness: name, Harnesses: make(map[string]port.TaskModelHarness, len(harnesses))}
	for name, value := range harnesses {
		h, ok := object(value, "defaultModel", "models")
		if !ok {
			return nil, errInvalid
		}
		def, ok := h["defaultModel"].(string)
		if !ok {
			return nil, errInvalid
		}
		models, ok := h["models"].(map[string]any)
		if !ok {
			return nil, errInvalid
		}
		harness := port.TaskModelHarness{DefaultModel: def, Models: make(map[string]port.TaskModel, len(models))}
		for alias, value := range models {
			m, ok := object(value, "model", "defaultEffort")
			if !ok {
				return nil, errInvalid
			}
			model, ok := m["model"].(string)
			if !ok {
				return nil, errInvalid
			}
			effort, ok := optionalString(m, "defaultEffort")
			if !ok {
				return nil, errInvalid
			}
			harness.Models[alias] = port.TaskModel{Model: model, DefaultEffort: effort}
		}
		p.Harnesses[name] = harness
	}
	return p, nil
}

func (JSONDecoder) DecodeSelection(raw []byte) (port.TaskModelPolicyRequest, error) {
	v, err := decode(raw, 4096)
	if err != nil {
		return port.TaskModelPolicyRequest{}, err
	}
	o, ok := object(v, "harness", "model", "effort")
	if !ok {
		return port.TaskModelPolicyRequest{}, errInvalid
	}
	harness, hOK := optionalString(o, "harness")
	model, mOK := optionalString(o, "model")
	effort, eOK := optionalString(o, "effort")
	if !hOK || !mOK || !eOK {
		return port.TaskModelPolicyRequest{}, errInvalid
	}
	return port.TaskModelPolicyRequest{Harness: harness, Model: model, Effort: effort}, nil
}

func optionalString(o map[string]any, key string) (*string, bool) {
	v, exists := o[key]
	if !exists {
		return nil, true
	}
	s, ok := v.(string)
	if !ok {
		return nil, false
	}
	return &s, true
}

func object(v any, keys ...string) (map[string]any, bool) {
	o, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	for key := range o {
		found := false
		for _, allowed := range keys {
			found = found || key == allowed
		}
		if !found {
			return nil, false
		}
	}
	return o, true
}

func decode(raw []byte, limit int) (any, error) {
	if len(raw) > limit || !utf8.Valid(raw) || !json.Valid(raw) || !pairedUnicode(raw) {
		return nil, errInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	return readValue(d, 0)
}

// The schema contains only objects and strings (plus a nullable policy root).
// Bounded depth/width also reject pathological JSON before allocating DTO maps.
func readValue(d *json.Decoder, depth int) (any, error) {
	if depth > 5 {
		return nil, errInvalid
	}
	token, err := d.Token()
	if err != nil {
		return nil, errInvalid
	}
	switch v := token.(type) {
	case nil, string:
		return v, nil
	case json.Delim:
		if v != '{' {
			return nil, errInvalid
		}
		o := make(map[string]any)
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, errInvalid
			}
			name, ok := key.(string)
			if !ok {
				return nil, errInvalid
			}
			if _, exists := o[name]; exists || len(o) >= 64 {
				return nil, errInvalid
			}
			value, err := readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			o[name] = value
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errInvalid
		}
		return o, nil
	default:
		return nil, errInvalid
	}
}

// encoding/json accepts lone surrogate escapes by replacing them. Reject them
// before decoding so malformed data can never become a different string.
func pairedUnicode(raw []byte) bool {
	quoted := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		unit := hexUnit(raw[i+1 : i+5])
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return false
		}
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return false
		}
		low := hexUnit(raw[i+3 : i+7])
		if low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}

// Called only after json.Valid has checked escape syntax and bounds.
func hexUnit(raw []byte) uint16 {
	var value uint16
	for _, c := range raw {
		value <<= 4
		switch {
		case c >= '0' && c <= '9':
			value += uint16(c - '0')
		case c >= 'a' && c <= 'f':
			value += uint16(c - 'a' + 10)
		default:
			value += uint16(c - 'A' + 10)
		}
	}
	return value
}
