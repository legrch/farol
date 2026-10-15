package currentsource

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
)

func TestExactBoundedNormalizedNumbers(t *testing.T) {
	for _, tc := range []struct {
		token string
		want  int64
		ok    bool
	}{
		{"11e0", 11, true}, {"1e3", 1000, true}, {"1791111e6", 1791111000000, true},
		{"9007199254740991e0", 9007199254740991, true}, {"-9007199254740991e0", -9007199254740991, true},
		{"9007199254740992e0", 0, false}, {"9e15", 9000000000000000, true}, {"1e16", 0, false},
		{"11e-1", 0, false}, {"1e-100", 0, false}, {"1e100", 0, false}, {"0e0", 0, true}, {"-0e0", 0, true},
		{"1e" + strings.Repeat("9", 10000), 0, false}, {strings.Repeat("9", 10000) + "e0", 0, false},
		{"1", 0, false}, {"1e0e0", 0, false}, {"e0", 0, false}, {"1.1e1", 0, false}, {"+1e0", 0, false}, {"1e--1", 0, false},
	} {
		t.Run(tc.token[:min(len(tc.token), 32)], func(t *testing.T) {
			got, ok := safeNumber(port.TaskSettingsNumber(tc.token))
			if ok != tc.ok || ok && got != tc.want {
				t.Fatalf("got %d,%v want %d,%v", got, ok, tc.want, tc.ok)
			}
		})
	}
	for _, v := range []any{nil, "11e0", int64(11), float64(11), map[string]any{}} {
		if _, ok := safeNumber(v); ok {
			t.Fatalf("accepted wrong typed number: %T", v)
		}
	}
}

func TestClosedKeysAndSettingsUTF16Lengths(t *testing.T) {
	if closed(map[string]any{"device": "1", "inode": "2", "device inode": true}, "device inode", "") {
		t.Fatal("accepted joined unknown key")
	}
	for _, tc := range []struct {
		s  string
		ok bool
	}{{strings.Repeat("é", 160), true}, {strings.Repeat("😀", 80), true}, {strings.Repeat("😀", 81), false}, {"", false}, {string([]byte{0xff}), false}} {
		if nonempty(tc.s, 160) != tc.ok {
			t.Fatal("Settings string length mismatch")
		}
	}
}
