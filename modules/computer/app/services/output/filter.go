// Package output projects complete, bounded execution text for local Activity.
// It is not a guarantee that every unknown secret or personal value is detected.
package output

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const sourceLimit = 64 * 1024
const excerptLimit = 2 * 1024
const entryLimit = 12 * 1024

type ScalarFilter func(string) (string, error)
type Input struct {
	Command                                                                      string
	Stdout, Stderr                                                               []byte
	OutputDrained, OutputLimited                                                 bool
	StdoutOffset, StderrOffset, StdoutNext, StderrNext, StdoutBytes, StderrBytes uint64
}
type Excerpt struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
	Text   string `json:"text,omitempty"`
}
type Details struct {
	Command Excerpt `json:"command"`
	Stdout  Excerpt `json:"stdout"`
	Stderr  Excerpt `json:"stderr"`
}

// Conservative whole-field masking retains ordinary diagnostic output while
// avoiding unqualified substring parsing of shell, URLs, headers, or credentials.
var sensitive = regexp.MustCompile(`(?i)(authorization|set-cookie|cookie\s*[:=]|bearer\s+|basic\s+|password|passwd|passphrase|secret|credential|api[_-]?key|\btoken\b|access[_-]?token|refresh[_-]?token|private[_ -]?key|base64\s+(--decode|-d)|-----begin [a-z ]*private key-----|https?://[^/\s]+@|[?&](token|key|auth|password)=|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})`)
var opaqueHex = regexp.MustCompile(`(?i)\b[0-9a-f]{96,}\b`)
var opaqueBase64 = regexp.MustCompile(`[A-Za-z0-9+/]{96,}={0,2}`)

// Long encoded material can contain secrets even without a recognizable key.
// Preserve ordinary long identifiers unless they have base64-like mixed classes.
func hasOpaqueEncoding(value string) bool {
	for _, part := range opaqueHex.FindAllString(value, -1) {
		var seen [256]bool
		distinct := 0
		for i := 0; i < len(part); i++ {
			if !seen[part[i]] {
				seen[part[i]] = true
				distinct++
			}
		}
		if distinct >= 4 {
			return true
		}
	}
	for _, part := range opaqueBase64.FindAllString(value, -1) {
		var lower, upper, digit, special bool
		for _, ch := range part {
			switch {
			case ch >= 'a' && ch <= 'z':
				lower = true
			case ch >= 'A' && ch <= 'Z':
				upper = true
			case ch >= '0' && ch <= '9':
				digit = true
			default:
				special = true
			}
		}
		if (lower && upper && digit) || special {
			return true
		}
	}
	return false
}

func empty(state, reason string) Excerpt { return Excerpt{State: state, Reason: reason} }

func cleanText(value string, command bool, filter ScalarFilter) (out Excerpt) {
	defer func() {
		if recover() != nil {
			out = empty("unavailable", "filter_failed")
		}
	}()
	if !utf8.ValidString(value) {
		return empty("withheld", "invalid_utf8")
	}
	if len(value) > sourceLimit {
		return empty("withheld", "source_too_large")
	}
	for _, r := range value {
		if (unicode.IsControl(r) && r != '\n' && r != '\t') || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			return empty("withheld", "ambiguous_control")
		}
	}
	if command && strings.Contains(value, "<<") {
		return empty("withheld", "inline_body")
	}
	if filter == nil {
		return empty("unavailable", "filter_unavailable")
	}
	if sensitive.MatchString(value) || hasOpaqueEncoding(value) {
		value = "[REDACTED]"
	}
	filtered, err := filter(value)
	if err != nil || !utf8.ValidString(filtered) || len(filtered) > sourceLimit || sensitive.MatchString(filtered) || hasOpaqueEncoding(filtered) {
		return empty("unavailable", "filter_failed")
	}
	for _, r := range filtered {
		if (unicode.IsControl(r) && r != '\n' && r != '\t') || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			return empty("unavailable", "filter_failed")
		}
	}
	if len(filtered) <= excerptLimit {
		return Excerpt{State: "filtered", Text: filtered}
	}
	end := excerptLimit
	for end > 0 && !utf8.ValidString(filtered[:end]) {
		end--
	}
	return Excerpt{State: "filtered-truncated", Text: filtered[:end]}
}

func cleanBytes(value []byte, filter ScalarFilter) Excerpt {
	if len(value) > sourceLimit {
		return empty("withheld", "source_too_large")
	}
	return cleanText(string(value), false, filter)
}

// Project must receive reassembled original streams, not independent read pages.
// Unknown or incomplete capture never exposes a prefix or fallback error text.
func Project(in Input, filter ScalarFilter) Details {
	command := cleanText(in.Command, true, filter)
	var details Details
	if !in.OutputDrained || in.OutputLimited || in.StdoutOffset != 0 || in.StderrOffset != 0 || in.StdoutNext != uint64(len(in.Stdout)) || in.StderrNext != uint64(len(in.Stderr)) || in.StdoutBytes != in.StdoutNext || in.StderrBytes != in.StderrNext {
		details = Details{Command: command, Stdout: empty("unavailable", "source_incomplete"), Stderr: empty("unavailable", "source_incomplete")}
	} else {
		details = Details{Command: command, Stdout: cleanBytes(in.Stdout, filter), Stderr: cleanBytes(in.Stderr, filter)}
	}
	if encoded, err := json.Marshal(details); err != nil || len(encoded) > entryLimit {
		if details.Stdout.State == "filtered" || details.Stdout.State == "filtered-truncated" {
			details.Stdout = empty("withheld", "entry_limit")
		}
		if details.Stderr.State == "filtered" || details.Stderr.State == "filtered-truncated" {
			details.Stderr = empty("withheld", "entry_limit")
		}
		if encoded, err = json.Marshal(details); err != nil || len(encoded) > entryLimit {
			details.Command = empty("withheld", "entry_limit")
		}
	}
	return details
}
