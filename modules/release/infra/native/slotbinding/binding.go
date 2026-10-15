// Package slotbinding publishes the frozen installed-operation-slot/1 bytes.
// No path, admission, helper lifetime or updater policy is owned here.
package slotbinding

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"unicode/utf8"
)

const maxRecord = 8192
const filename = "slot-binding.json"

func object(raw []byte, keys ...string) (map[string]json.RawMessage, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return nil, false
	}
	m := make(map[string]json.RawMessage, len(keys))
	for d.More() {
		t, err = d.Token()
		if err != nil {
			return nil, false
		}
		k, ok := t.(string)
		if !ok {
			return nil, false
		}
		if _, found := m[k]; found {
			return nil, false
		}
		var v json.RawMessage
		if d.Decode(&v) != nil {
			return nil, false
		}
		m[k] = v
	}
	t, err = d.Token()
	if err != nil || t != json.Delim('}') {
		return nil, false
	}
	var extra any
	if d.Decode(&extra) != io.EOF || len(m) != len(keys) {
		return nil, false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return nil, false
		}
	}
	return m, true
}

// Python json accepts unpaired escaped UTF-16 surrogates. Keep those codepoints
// explicitly: encoding/json's string replacement would alter retained identity.
func stringPoints(raw []byte) ([]rune, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return nil, false
	}
	data := raw[1 : len(raw)-1]
	var points []rune
	for len(data) > 0 {
		if data[0] == '\\' {
			if len(data) < 2 {
				return nil, false
			}
			var r rune
			switch data[1] {
			case '"', '\\', '/':
				r = rune(data[1])
				data = data[2:]
			case 'b':
				r = '\b'
				data = data[2:]
			case 'f':
				r = '\f'
				data = data[2:]
			case 'n':
				r = '\n'
				data = data[2:]
			case 'r':
				r = '\r'
				data = data[2:]
			case 't':
				r = '\t'
				data = data[2:]
			case 'u':
				if len(data) < 6 {
					return nil, false
				}
				n, err := strconv.ParseUint(string(data[2:6]), 16, 16)
				if err != nil {
					return nil, false
				}
				r = rune(n)
				data = data[6:]
				if r >= 0xd800 && r <= 0xdbff && len(data) >= 6 && data[0] == '\\' && data[1] == 'u' {
					low, err := strconv.ParseUint(string(data[2:6]), 16, 16)
					if err == nil && low >= 0xdc00 && low <= 0xdfff {
						r = 0x10000 + (r-0xd800)*0x400 + rune(low) - 0xdc00
						data = data[6:]
					}
				}
			default:
				return nil, false
			}
			points = append(points, r)
		} else {
			r, n := utf8.DecodeRune(data)
			if (r == utf8.RuneError && n == 1) || r < 0x20 || r == '"' {
				return nil, false
			}
			points = append(points, r)
			data = data[n:]
		}
	}
	return points, true
}
func quoted(points []rune) []byte {
	out := []byte{'"'}
	const hex = "0123456789abcdef"
	unit := func(r rune) { out = append(out, '\\', 'u', hex[(r>>12)&15], hex[(r>>8)&15], hex[(r>>4)&15], hex[r&15]) }
	for _, r := range points {
		switch r {
		case '"', '\\':
			out = append(out, '\\', byte(r))
		case '\b':
			out = append(out, '\\', 'b')
		case '\f':
			out = append(out, '\\', 'f')
		case '\n':
			out = append(out, '\\', 'n')
		case '\r':
			out = append(out, '\\', 'r')
		case '\t':
			out = append(out, '\\', 't')
		default:
			if r >= 0x20 && r <= 0x7e {
				out = append(out, byte(r))
			} else if r <= 0xffff {
				unit(r)
			} else {
				r -= 0x10000
				unit(0xd800 + (r >> 10))
				unit(0xdc00 + (r & 0x3ff))
			}
		}
	}
	return append(out, '"')
}
func exactString(raw []byte, size int) (string, bool) {
	p, ok := stringPoints(raw)
	if !ok || len(p) != size {
		return "", false
	}
	for _, r := range p {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return "", false
		}
	}
	return string(p), true
}
func build(raw []byte) ([]byte, bool) {
	m, ok := object(raw, "buildId", "digest", "version")
	if !ok {
		return nil, false
	}
	id, a := exactString(m["buildId"], 64)
	digest, b := exactString(m["digest"], 64)
	version, c := stringPoints(m["version"])
	if !a || !b || !c || len(version) < 1 || len(version) > 128 {
		return nil, false
	}
	out := []byte(`{"buildId":"` + id + `","digest":"` + digest + `","version":`)
	out = append(out, quoted(version)...)
	return append(out, '}'), true
}
func canonical(data []byte) bool {
	if len(data) < 1 || len(data) > maxRecord {
		return false
	}
	m, ok := object(data, "installLocation", "operationId", "schema", "source", "target")
	if !ok {
		return false
	}
	loc, l := stringPoints(m["installLocation"])
	schema, s := stringPoints(m["schema"])
	id, i := exactString(m["operationId"], 32)
	source, a := build(m["source"])
	target, b := build(m["target"])
	if !l || !s || !i || !a || !b || (string(loc) != "shared" && string(loc) != "legacy") || string(schema) != "farol.installed-operation-slot/1" {
		return false
	}
	out := []byte(`{"installLocation":"` + string(loc) + `","operationId":"` + id + `","schema":"farol.installed-operation-slot/1","source":`)
	out = append(out, source...)
	out = append(out, []byte(`,"target":`)...)
	out = append(out, target...)
	out = append(out, '}', '\n')
	return bytes.Equal(data, out)
}
