// Process audit filtering projects complete, bounded execution text for local Activity.
// It is not a guarantee that every unknown secret or personal value is detected.
package process

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

type AuditScalarFilter func(string) (string, error)
type AuditInput struct {
	Command                                                                      string
	Stdout, Stderr                                                               []byte
	OutputDrained, OutputLimited                                                 bool
	StdoutOffset, StderrOffset, StdoutNext, StderrNext, StdoutBytes, StderrBytes uint64
}
type AuditExcerpt struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
	Text   string `json:"text,omitempty"`
}
type AuditDetails struct {
	Command AuditExcerpt `json:"command"`
	Stdout  AuditExcerpt `json:"stdout"`
	Stderr  AuditExcerpt `json:"stderr"`
}

// AuditCommand holds only an already projected excerpt, never the original input.
// Its zero value represents unavailable data rather than an unfiltered command.
type AuditCommand struct{ excerpt AuditExcerpt }

// ProjectAuditCommand runs while the original request is available. Retaining the
// result does not retain command input, stdin or environment values.
func ProjectAuditCommand(value string, filter AuditScalarFilter) AuditCommand {
	return AuditCommand{excerpt: cleanText(value, true, filter)}
}

// Conservative whole-field masking retains ordinary diagnostic output while
// avoiding unqualified substring parsing of shell, URLs, headers, or credentials.
var sensitive = regexp.MustCompile(`(?i)(authorization|set-cookie|cookie\s*[:=]|bearer\s+|basic\s+|password|passwd|passphrase|secret|credential|api[_-]?key|\btoken\b|(?:^|[\s;&|])--?(?:auth|user)\b|(?:^|[\s;&|])-u(?:\s|=|[^\s-])|access[_-]?token|refresh[_-]?token|private[_ -]?key|base64\s+(--decode|-d)|-----begin [a-z ]*private key-----|[a-z][a-z0-9+.-]*://[^/\s]+@|[?&](token|key|auth|password)=|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})`)
var opaqueHex = regexp.MustCompile(`(?i)\b[0-9a-f]{96,}\b`)
var opaqueBase64 = regexp.MustCompile(`[A-Za-z0-9+/]{96,}={0,2}`)
var inlineInterpreter = regexp.MustCompile(`(?:^|[\s;&|()])(?:[^\s;&|()]*/)?(?:python[0-9.]*|node|ruby|perl|bash|sh|zsh)[^\n]*\s+-[A-Za-z]*[ce][^\s]*`)

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

func empty(state, reason string) AuditExcerpt { return AuditExcerpt{State: state, Reason: reason} }

func cleanText(value string, command bool, filter AuditScalarFilter) (out AuditExcerpt) {
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
	if command && (strings.ContainsAny(value, "\n\r") || strings.Contains(value, "<<") || inlineInterpreter.MatchString(value)) {
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
		return AuditExcerpt{State: "filtered", Text: filtered}
	}
	end := excerptLimit
	for end > 0 && !utf8.ValidString(filtered[:end]) {
		end--
	}
	return AuditExcerpt{State: "filtered-truncated", Text: filtered[:end]}
}

func cleanBytes(value []byte, filter AuditScalarFilter) AuditExcerpt {
	if len(value) > sourceLimit {
		return empty("withheld", "source_too_large")
	}
	return cleanText(string(value), false, filter)
}

// ProjectAudit must receive reassembled original streams, not independent read pages.
// Unknown or incomplete capture never exposes a prefix or fallback error text.
func ProjectAudit(in AuditInput, filter AuditScalarFilter) AuditDetails {
	return ProjectAuditWithCommand(in, ProjectAuditCommand(in.Command, filter), filter)
}

// ProjectAuditWithCommand combines a pre-filtered command with complete terminal
// streams. It deliberately ignores AuditInput.Command so raw input need not survive
// until the process exits.
func ProjectAuditWithCommand(in AuditInput, command AuditCommand, filter AuditScalarFilter) AuditDetails {
	commandExcerpt := command.excerpt
	if commandExcerpt.State == "" {
		commandExcerpt = empty("unavailable", "filter_unavailable")
	}
	var details AuditDetails
	if !in.OutputDrained || in.OutputLimited || in.StdoutOffset != 0 || in.StderrOffset != 0 || in.StdoutNext != uint64(len(in.Stdout)) || in.StderrNext != uint64(len(in.Stderr)) || in.StdoutBytes != in.StdoutNext || in.StderrBytes != in.StderrNext {
		details = AuditDetails{Command: commandExcerpt, Stdout: empty("unavailable", "source_incomplete"), Stderr: empty("unavailable", "source_incomplete")}
	} else {
		details = AuditDetails{Command: commandExcerpt, Stdout: cleanBytes(in.Stdout, filter), Stderr: cleanBytes(in.Stderr, filter)}
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
