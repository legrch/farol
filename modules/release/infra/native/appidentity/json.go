package appidentity

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"unicode/utf8"
)

// encoding/json replaces malformed Unicode; reject it before decoding tokens.
func jsonUnicode(raw []byte) bool {
	if !utf8.Valid(raw) {
		return false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] != '"' {
			continue
		}
		i++
		for ; i < len(raw) && raw[i] != '"'; i++ {
			if raw[i] != '\\' {
				continue
			}
			i++
			if i >= len(raw) {
				return false
			}
			if raw[i] != 'u' {
				continue
			}
			if i+4 >= len(raw) {
				return false
			}
			n, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
			if e != nil {
				return false
			}
			i += 4
			if n >= 0xdc00 && n <= 0xdfff {
				return false
			}
			if n >= 0xd800 && n <= 0xdbff {
				if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
					return false
				}
				m, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
				if e != nil || m < 0xdc00 || m > 0xdfff {
					return false
				}
				i += 6
			}
		}
	}
	return true
}
func parseJSON(raw []byte, b *budget) (any, error) {
	if !jsonUnicode(raw) {
		return nil, refusal(InvalidJSON)
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, e := jsonValue(d, b, 0)
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, refusal(InvalidJSON)
	}
	return v, nil
}
func jsonValue(d *json.Decoder, b *budget, depth int) (any, error) {
	if e := b.node(depth); e != nil {
		return nil, e
	}
	t, e := d.Token()
	if e != nil {
		return nil, refusal(InvalidJSON)
	}
	switch v := t.(type) {
	case json.Delim:
		switch v {
		case '{':
			m := map[string]any{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, refusal(InvalidJSON)
				}
				s, ok := k.(string)
				if !ok {
					return nil, refusal(InvalidJSON)
				}
				if _, ok = m[s]; ok {
					return nil, refusal(InvalidJSON)
				}
				if e = b.add(3, len(s)); e != nil {
					return nil, e
				}
				n, e := jsonValue(d, b, depth+1)
				if e != nil {
					return nil, e
				}
				m[s] = n
			}
			if t, e = d.Token(); e != nil || t != json.Delim('}') {
				return nil, refusal(InvalidJSON)
			}
			return m, nil
		case '[':
			var a []any
			for d.More() {
				if e = b.add(1, 0); e != nil {
					return nil, e
				}
				n, e := jsonValue(d, b, depth+1)
				if e != nil {
					return nil, e
				}
				a = append(a, n)
			}
			if t, e = d.Token(); e != nil || t != json.Delim(']') {
				return nil, refusal(InvalidJSON)
			}
			return a, nil
		}
		return nil, refusal(InvalidJSON)
	case string:
		if e = b.add(0, len(v)); e != nil {
			return nil, e
		}
	case json.Number:
		if e = b.add(0, len(v)); e != nil {
			return nil, e
		}
	}
	return t, nil
}
