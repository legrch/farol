package handoff

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

var timestampPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$`)

func timestamp(s string) (time.Time, bool) {
	if !timestampPattern.MatchString(s) {
		return time.Time{}, false
	}
	// time.Parse accepts offset hours 24 and minutes 60; this subset does not.
	if s[len(s)-1] != 'Z' {
		off := s[len(s)-6:]
		if off[1:3] > "23" || off[4:6] > "59" {
			return time.Time{}, false
		}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil && t.Year() >= 1 && t.Year() <= 9999
}

func (v *Verifier) verifyClosed(ctx context.Context, state int) error {
	if err := canceled(ctx); err != nil {
		return err
	}
	observation, err := v.process.Observe(ctx, v.expected.PID, v.expected.ProcessStart)
	if e := canceled(ctx); e != nil {
		if err != nil {
			return fail(ErrCanceled, true, false, err, e)
		}
		return e
	}
	if err != nil {
		return fail(ErrProcessUnknown, true, false, err)
	}
	if observation == ProcessPresent {
		return ErrProcessRunning
	}
	if observation != ProcessAbsent {
		return ErrProcessUnknown
	}
	if _, exists, err := named(ctx, state, "running.json", ErrProcessUnknown); err != nil {
		return err
	} else if exists {
		return ErrRunningMarker
	}
	data, err := readQuit(ctx, state)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != v.expected.LastQuitSHA256 {
		return ErrQuitDigest
	}
	at, err := quitTimestamp(data)
	if err != nil {
		return err
	}
	started, _ := timestamp(v.expected.StartedAt)
	if err = canceled(ctx); err != nil {
		return err
	}
	now := v.now()
	if err = canceled(ctx); err != nil {
		return err
	}
	if now.IsZero() || now.Year() < 1 || now.Year() > 9999 {
		return ErrClock
	}
	if !at.After(started) || at.After(now) {
		return ErrQuitStale
	}
	// Observe marker again after the receipt read. This narrows races without
	// claiming atomic exclusion of a restarted process or external namespace.
	if _, exists, err := named(ctx, state, "running.json", ErrProcessUnknown); err != nil {
		return err
	} else if exists {
		return ErrRunningMarker
	}
	return canceled(ctx)
}

func quitTimestamp(data []byte) (time.Time, error) {
	if len(data) < 1 || len(data) > maxRecord || !strictUnicode(data) {
		return time.Time{}, ErrQuitInvalid
	}
	d := json.NewDecoder(bytes.NewReader(data))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return time.Time{}, ErrQuitNotConfirmed
	}
	fields := make(map[string]json.RawMessage, 4)
	for d.More() {
		t, err = d.Token()
		if err != nil {
			return time.Time{}, ErrQuitInvalid
		}
		k, ok := t.(string)
		if !ok {
			return time.Time{}, ErrQuitInvalid
		}
		if _, exists := fields[k]; exists {
			return time.Time{}, ErrQuitInvalid
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil {
			return time.Time{}, ErrQuitInvalid
		}
		fields[k] = raw
	}
	t, err = d.Token()
	if err != nil || t != json.Delim('}') {
		return time.Time{}, ErrQuitInvalid
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return time.Time{}, ErrQuitInvalid
	}
	if len(fields) != 4 || !bytes.Equal(bytes.TrimSpace(fields["schema"]), []byte("1")) || !bytes.Equal(bytes.TrimSpace(fields["drained"]), []byte("true")) {
		return time.Time{}, ErrQuitNotConfirmed
	}
	var unconfirmed []json.RawMessage
	if json.Unmarshal(fields["unconfirmed"], &unconfirmed) != nil || unconfirmed == nil || len(unconfirmed) != 0 {
		return time.Time{}, ErrQuitNotConfirmed
	}
	var at string
	if len(fields["at"]) == 0 || bytes.TrimSpace(fields["at"])[0] != '"' || json.Unmarshal(fields["at"], &at) != nil {
		return time.Time{}, ErrQuitNotConfirmed
	}
	parsed, ok := timestamp(at)
	if !ok {
		return time.Time{}, ErrQuitInvalid
	}
	return parsed, nil
}

// encoding/json replaces invalid UTF-8 and unpaired UTF-16 escapes. Reject
// those inputs before decoding so retained bytes never silently change meaning.
func strictUnicode(data []byte) bool {
	if !utf8.Valid(data) || !json.Valid(data) {
		return false
	}
	inside := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			inside = !inside
			continue
		}
		if !inside || data[i] != '\\' {
			continue
		}
		i++
		if data[i] != 'u' {
			continue
		}
		unit, _ := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return false
		}
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}
