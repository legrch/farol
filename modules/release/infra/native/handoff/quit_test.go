package handoff

import (
	"strings"
	"testing"
	"time"
)

// Pure receipt parsing; no files, process observation, lease or native launch.
func TestQuitRecordDeterministicWhitespaceOnly(t *testing.T) {
	for name, receipt := range map[string]string{
		"empty":           "",
		"space":           " ",
		"tab":             "\t",
		"newline":         "\n",
		"carriage-return": "\r",
		"mixed":           " \t\r\n ",
		"maximum":         strings.Repeat(" ", maxRecord),
		"unicode":         "\u00a0\u2003\u2028\u2029",
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if p := recover(); p != nil {
					t.Fatalf("whitespace-only receipt panicked: %v", p)
				}
			}()
			at, err := quitTimestamp([]byte(receipt))
			if err != ErrQuitInvalid || !at.IsZero() {
				t.Fatal("expected bounded invalid receipt refusal", at, err)
			}
		})
	}
}

func TestQuitRecordDeterministicWhitespaceWrappedReceipt(t *testing.T) {
	valid := " \t\r\n" + `{"schema":1,"at":"2026-10-18T00:00:00Z","drained":true,"unconfirmed":[]}` + " \r\n\t"
	at, err := quitTimestamp([]byte(valid))
	if err != nil || !at.Equal(time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)) {
		t.Fatal("valid receipt with surrounding JSON whitespace refused", at, err)
	}
	for _, value := range []string{`""`, `" \t\r\n"`} {
		wire := `{"schema":1,"at":` + value + `,"drained":true,"unconfirmed":[]}`
		at, err := quitTimestamp([]byte(wire))
		if err != ErrQuitInvalid || !at.IsZero() {
			t.Fatal("blank timestamp accepted", at, err)
		}
	}
}

// Native owners supply clock values after receipt parsing and before admission.
// These value-only cases prove chronology, not real process or filesystem state.
func TestQuitRecordDeterministicObservedTime(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	started := now.Add(-time.Second)
	for _, tc := range []struct {
		name    string
		at      time.Time
		started *time.Time
		now     time.Time
		want    error
	}{
		{"offline-past", started, nil, now, nil},
		{"offline-now", now, nil, now, nil},
		{"offline-future", now.Add(time.Nanosecond), nil, now, ErrQuitStale},
		{"live-now", now, &started, now, nil},
		{"live-before-start", started.Add(-time.Nanosecond), &started, now, ErrQuitStale},
		{"live-equal-start", started, &started, now, ErrQuitStale},
		{"live-future", now.Add(time.Nanosecond), &started, now, ErrQuitStale},
		{"offline-zero-clock", now, nil, time.Time{}, ErrClock},
		{"live-zero-clock", now, &started, time.Time{}, ErrClock},
		{"clock-year-zero", now, nil, time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC), ErrClock},
		{"clock-year-overflow", now, nil, time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC), ErrClock},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := verifyQuitTime(tc.at, tc.started, tc.now); err != tc.want {
				t.Fatal("Quit chronology classification changed", err, tc.want)
			}
		})
	}
}
