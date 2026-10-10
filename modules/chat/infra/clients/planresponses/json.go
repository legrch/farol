package planresponses

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxJSONDepth = 32

// validJSON rejects ambiguities encoding/json otherwise silently accepts:
// duplicate decoded object keys, invalid UTF-8, unpaired UTF-16 escapes, trailing
// values and excessive nesting. The caller separately bounds encoded bytes.
func validJSON(raw []byte) bool {
	if !utf8.Valid(raw) || !validSurrogates(raw) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > maxJSONDepth {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		delimiter, isDelimiter := token.(json.Delim)
		if !isDelimiter {
			return true
		}
		switch delimiter {
		case '{':
			keys := make(map[string]bool)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return false
				}
				key, ok := keyToken.(string)
				if !ok || keys[key] {
					return false
				}
				keys[key] = true
				if !value(depth + 1) {
					return false
				}
			}
		case '[':
			for decoder.More() {
				if !value(depth + 1) {
					return false
				}
			}
		default:
			return false
		}
		closing, err := decoder.Token()
		return err == nil && (delimiter == '{' && closing == json.Delim('}') || delimiter == '[' && closing == json.Delim(']'))
	}
	if !value(0) {
		return false
	}
	_, err := decoder.Token()
	return err == io.EOF
}

func validSurrogates(raw []byte) bool {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		unit, ok := hexUnit(raw, i+1)
		if !ok {
			return false
		}
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
		low, ok := hexUnit(raw, i+3)
		if !ok || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}

func hexUnit(raw []byte, start int) (uint16, bool) {
	if start+4 > len(raw) {
		return 0, false
	}
	var value uint16
	for _, char := range raw[start : start+4] {
		value <<= 4
		switch {
		case char >= '0' && char <= '9':
			value += uint16(char - '0')
		case char >= 'a' && char <= 'f':
			value += uint16(char-'a') + 10
		case char >= 'A' && char <= 'F':
			value += uint16(char-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

// encoding/json matches struct fields using Unicode simple folding. Protocol
// objects admit exact canonical keys; even a singular alias must not enter that
// fuzzy matching path. Ordinary function-argument JSON retains case-sensitive
// keys because it does not pass through this protocol-object validator.
func exactProtocolObject(raw []byte, names ...string) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, false
	}
	canonical := make(map[string]string, len(names))
	for _, name := range names {
		canonical[foldJSONKey(name)] = name
	}
	for name := range object {
		if exact, known := canonical[foldJSONKey(name)]; known && name != exact {
			return nil, false
		}
	}
	return object, true
}

func foldJSONKey(name string) string {
	var folded strings.Builder
	for _, char := range name {
		minimum := char
		for next := unicode.SimpleFold(char); next != char; next = unicode.SimpleFold(next) {
			if next < minimum {
				minimum = next
			}
		}
		folded.WriteRune(minimum)
	}
	return folded.String()
}

func validProtocolEvent(raw []byte) bool {
	object, ok := exactProtocolObject(raw, "type", "sequence_number", "response_id", "response", "item_id", "output_index", "content_index", "item", "part", "delta", "text", "code", "param", "error")
	if !ok {
		return false
	}
	if response, exists := object["response"]; exists && !validProtocolResponse(response) {
		return false
	}
	if item, exists := object["item"]; exists && !validProtocolItem(item) {
		return false
	}
	if part, exists := object["part"]; exists && !validProtocolPart(part) {
		return false
	}
	return validProtocolError(object["error"])
}

func validProtocolResponse(raw []byte) bool {
	object, ok := exactProtocolObject(raw, "id", "status", "error", "output")
	if !ok || !validProtocolError(object["error"]) {
		return false
	}
	if output, exists := object["output"]; exists {
		var items []json.RawMessage
		if bytes.Equal(bytes.TrimSpace(output), []byte("null")) || json.Unmarshal(output, &items) != nil {
			return false
		}
		for _, item := range items {
			if !validProtocolItem(item) {
				return false
			}
		}
	}
	return true
}

func validProtocolItem(raw []byte) bool {
	object, ok := exactProtocolObject(raw, "id", "type", "role", "status", "content")
	if !ok {
		return false
	}
	if status, exists := object["status"]; exists && bytes.Equal(bytes.TrimSpace(status), []byte("null")) {
		return false
	}
	if content, exists := object["content"]; exists {
		var parts []json.RawMessage
		if bytes.Equal(bytes.TrimSpace(content), []byte("null")) || json.Unmarshal(content, &parts) != nil {
			return false
		}
		for _, part := range parts {
			if !validProtocolPart(part) {
				return false
			}
		}
	}
	return true
}

func validProtocolPart(raw []byte) bool {
	_, ok := exactProtocolObject(raw, "type", "text")
	return ok
}

func validProtocolError(raw []byte) bool {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true
	}
	_, ok := exactProtocolObject(raw, "code", "param")
	return ok
}
