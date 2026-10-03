// Package records decodes the retained current-alpha update formats. Successful
// parsing supplies no physical verification, process proof or dispatch authority.
package records

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

const MaxRecordBytes = 65536
const MaxHelperRecordBytes = 8192

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid         Code = "UPDATE_RECORD_INVALID"
	Oversized       Code = "UPDATE_RECORD_OVERSIZED"
	EncodingInvalid Code = "UPDATE_RECORD_ENCODING_INVALID"
	BindingMismatch Code = "UPDATE_OPERATION_IDENTITY_MISMATCH"
)

func decode(data []byte) (map[string]any, error) {
	if len(data) > MaxRecordBytes {
		return nil, Oversized
	}
	if !utf8.Valid(data) || !safeEscapes(data) {
		return nil, EncodingInvalid
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value any
	if d.Decode(&value) != nil {
		return nil, Invalid
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, Invalid
	}
	m, ok := value.(map[string]any)
	if !ok {
		return nil, Invalid
	}
	return m, nil
}

// Go's JSON decoder replaces unpaired escaped UTF-16 surrogates. Such a
// replacement must never silently change an operation's retained identity.
func safeEscapes(data []byte) bool {
	inside := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			inside = !inside
		}
		if !inside || data[i] != '\\' || i+1 >= len(data) {
			continue
		}
		if data[i+1] != 'u' {
			i++
			continue
		}
		if i+6 > len(data) {
			return false
		}
		v, err := strconv.ParseUint(string(data[i+2:i+6]), 16, 16)
		if err != nil {
			return false
		}
		if v >= 0xd800 && v <= 0xdbff {
			if i+12 > len(data) || data[i+6] != '\\' || data[i+7] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+8:i+12]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 11
		} else {
			if v >= 0xdc00 && v <= 0xdfff {
				return false
			}
			i += 5
		}
	}
	return true
}

func object(v any, required, optional []string) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		if _, exists := m[key]; !exists {
			return nil, false
		}
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range m {
		if !allowed[key] {
			return nil, false
		}
	}
	return m, true
}

func text(v any, min, max int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return s, n >= min && n <= max
}

func hex(v any, size int) (string, bool) {
	s, ok := text(v, size, size)
	if !ok {
		return "", false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return "", false
		}
	}
	return s, true
}

func decimal(v any) (string, bool) {
	s, ok := text(v, 1, 30)
	if !ok {
		return "", false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	return s, true
}

func pid(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	// Match the current TS persisted record's safe integer semantics, including
	// JSON spellings such as 42.0. Native process acceptance is a separate proof.
	f, err := strconv.ParseFloat(n.String(), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 2 || f > 9007199254740991 || math.Trunc(f) != f {
		return 0, false
	}
	return int64(f), true
}

func optionalBuild(m map[string]any, key string) (*Build, bool) {
	v, present := m[key]
	if !present {
		return nil, true
	}
	b, ok := build(v)
	return &b, ok
}
