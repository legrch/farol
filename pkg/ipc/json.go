package ipc

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

var ErrJSON = errors.New("invalid protocol JSON")

// ValidateJSON rejects duplicates, invalid UTF-8, depth overflow and trailing data.
func ValidateJSON(data []byte) error {
	if !utf8.Valid(data) {
		return ErrJSON
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := value(d, 0); err != nil {
		return ErrJSON
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrJSON
	}
	return nil
}

func value(d *json.Decoder, depth int) error {
	if depth > 32 {
		return ErrJSON
	}
	t, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		keys := make(map[string]bool)
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return err
			}
			s, ok := k.(string)
			if !ok || keys[s] {
				return ErrJSON
			}
			keys[s] = true
			if err := value(d, depth+1); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := value(d, depth+1); err != nil {
				return err
			}
		}
	default:
		return ErrJSON
	}
	end, err := d.Token()
	if err != nil {
		return err
	}
	if (delim == '{' && end != json.Delim('}')) || (delim == '[' && end != json.Delim(']')) {
		return ErrJSON
	}
	return nil
}
