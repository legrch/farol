// Package currentsettings supplies strict, bounded saved-fact decoding.
package currentsettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/app/port"
)

const maxBytes = 1 << 20
const maxNodes = 65536
const maxDepth = 128

var errInvalid = errors.New("invalid Task current settings JSON")

type JSONDecoder struct{}

func (JSONDecoder) Decode(raw []byte) (port.TaskCurrentSettingsFacts, error) {
	var empty port.TaskCurrentSettingsFacts
	if len(raw) > maxBytes || !utf8.Valid(raw) || !json.Valid(raw) || !pairedUnicode(raw) {
		return empty, errInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	nodes := 0
	v, err := readValue(d, 0, &nodes)
	if err != nil {
		return empty, errInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return empty, errInvalid
	}
	return facts(v)
}

func readValue(d *json.Decoder, depth int, nodes *int) (any, error) {
	*nodes++
	if depth > maxDepth || *nodes > maxNodes {
		return nil, errInvalid
	}
	token, err := d.Token()
	if err != nil {
		return nil, errInvalid
	}
	switch v := token.(type) {
	case nil, bool, string:
		return v, nil
	case json.Number:
		return v, nil
	case json.Delim:
		switch v {
		case '{':
			o := map[string]any{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, errInvalid
				}
				name, ok := key.(string)
				if !ok {
					return nil, errInvalid
				}
				if _, exists := o[name]; exists {
					return nil, errInvalid
				}
				value, err := readValue(d, depth+1, nodes)
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
		case '[':
			a := []any{}
			for d.More() {
				value, err := readValue(d, depth+1, nodes)
				if err != nil {
					return nil, err
				}
				a = append(a, value)
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return nil, errInvalid
			}
			return a, nil
		}
	}
	return nil, errInvalid
}

// Normalize decimal coefficients/exponents without expanding large exponents or
// rounding through a float. This also keeps 1, 1.0 and 1e0 equal as JSON values.
func number(n json.Number) port.TaskSettingsNumber {
	s := string(n)
	sign := ""
	if strings.HasPrefix(s, "-") {
		sign = "-"
		s = s[1:]
	}
	exponent := new(big.Int)
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		exponent.SetString(s[i+1:], 10)
		s = s[:i]
	}
	if i := strings.IndexByte(s, '.'); i >= 0 {
		exponent.Sub(exponent, big.NewInt(int64(len(s)-i-1)))
		s = s[:i] + s[i+1:]
	}
	s = strings.TrimLeft(s, "0")
	if s == "" {
		return "0e0"
	}
	trimmed := strings.TrimRight(s, "0")
	exponent.Add(exponent, big.NewInt(int64(len(s)-len(trimmed))))
	return port.TaskSettingsNumber(sign + trimmed + "e" + exponent.String())
}

func value(v any) any {
	switch x := v.(type) {
	case json.Number:
		return number(x)
	case map[string]any:
		o := make(map[string]any, len(x))
		for k, v := range x {
			o[k] = value(v)
		}
		return o
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = value(v)
		}
		return a
	default:
		return x
	}
}

// Called after json.Valid, which establishes escape bounds. encoding/json
// replaces unpaired surrogates; refuse them before they can change a value.
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
