package process

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func identity(value string) (string, error) { return value, nil }
func complete(command, stdout, stderr string) AuditInput {
	return AuditInput{Command: command, Stdout: []byte(stdout), Stderr: []byte(stderr), OutputDrained: true, StdoutNext: uint64(len(stdout)), StdoutBytes: uint64(len(stdout)), StderrNext: uint64(len(stderr)), StderrBytes: uint64(len(stderr))}
}

func TestProjectionSyntheticCorpus(t *testing.T) {
	for _, test := range []struct{ name, value, state, want string }{
		{"pwd", "/tmp/example\n", "filtered", "/tmp/example\n"},
		{"git", " M file.txt\n", "filtered", " M file.txt\n"},
		{"git-error", "fatal: not a git repository\n", "filtered", "fatal: not a git repository\n"},
		{"utf8", "Café 日本語\n", "filtered", "Café 日本語\n"},
		{"tab", "a\tb\n", "filtered", "a\tb\n"},
		{"hash", "b62967ed2d7f44a12c127f952e3fc26f7f23c1ab", "filtered", "b62967ed2d7f44a12c127f952e3fc26f7f23c1ab"},
		{"long-identifier", strings.Repeat("identifier", 12), "filtered", strings.Repeat("identifier", 12)},
		{"invalid-utf8", string([]byte{0xff}), "withheld", ""},
		{"nul", "abc\x00def", "withheld", ""},
		{"carriage-return", "abc\rdef", "withheld", ""},
		{"backspace", "abc\bdef", "withheld", ""},
		{"bidi-control", "abc\u202edef", "withheld", ""},
		{"ansi", "\x1b[31mred", "withheld", ""},
		{"osc", "\x1b]8;;https://example.test\x07", "withheld", ""},
		{"bearer", "Authorization: Bearer FAKE_SECRET", "filtered", "[REDACTED]"},
		{"basic", "Authorization: Basic FAKE_SECRET", "filtered", "[REDACTED]"},
		{"cookie", "Cookie: session=FAKE_SECRET", "filtered", "[REDACTED]"},
		{"set-cookie", "Set-Cookie: session=FAKE_SECRET", "filtered", "[REDACTED]"},
		{"token-flag", "--token FAKE_SECRET", "filtered", "[REDACTED]"},
		{"password", "password=FAKE_SECRET", "filtered", "[REDACTED]"},
		{"userinfo", "https://fake:FAKE_SECRET@example.test", "filtered", "[REDACTED]"},
		{"non-http-userinfo", "ftp://fake:FAKE_SECRET@example.test", "filtered", "[REDACTED]"},
		{"auth-flag", "--auth FAKE_SECRET", "filtered", "[REDACTED]"},
		{"user-flag", "--user fake:FAKE_SECRET", "filtered", "[REDACTED]"},
		{"short-user-flag", "curl -u fake:FAKE_SECRET example.test", "filtered", "[REDACTED]"},
		{"query", "https://example.test/?token=FAKE_SECRET", "filtered", "[REDACTED]"},
		{"pem", "-----BEGIN PRIVATE KEY-----\nFAKE_SECRET", "filtered", "[REDACTED]"},
		{"jwt", "eyJabcdefghij.abcdefghij.abcdefghij", "filtered", "[REDACTED]"},
		{"encoded-context", "base64 --decode FAKE_SECRET", "filtered", "[REDACTED]"},
		{"opaque-hex", strings.Repeat("0a1b", 25), "filtered", "[REDACTED]"},
		{"opaque-base64", strings.Repeat("aB3d", 25), "filtered", "[REDACTED]"},
		{"too-large", strings.Repeat("x", sourceLimit+1), "withheld", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := ProjectAudit(complete("git status", test.value, ""), identity).Stdout
			if got.State != test.state || got.Text != test.want || strings.Contains(got.Text, "FAKE_SECRET") {
				t.Fatalf("unexpected filtered projection: %#v", got)
			}
		})
	}
}

func TestProjectionNeverExposesIncompleteOrInlineInputs(t *testing.T) {
	in := complete("cat <<EOF\nFAKE_SECRET\nEOF", "partial", "error")
	in.OutputLimited = true
	got := ProjectAudit(in, identity)
	if got.Command.State != "withheld" || got.Command.Text != "" || got.Stdout.State != "unavailable" || got.Stdout.Text != "" || got.Stderr.Text != "" {
		t.Fatal("incomplete input escaped")
	}
	in = complete("pwd", "text", "")
	in.StdoutNext--
	if out := ProjectAudit(in, identity).Stdout; out.State != "unavailable" || out.Text != "" {
		t.Fatal("invalid offsets escaped")
	}
}

func TestProjectionFiltersBeforeValidUTF8Truncation(t *testing.T) {
	in := complete("git status", strings.Repeat("a", excerptLimit-1)+"é"+"\npassword=FAKE_SECRET", "")
	got := ProjectAudit(in, identity).Stdout
	if got.Text != "[REDACTED]" || strings.Contains(got.Text, "FAKE_SECRET") {
		t.Fatal("secret beyond excerpt boundary escaped filtering")
	}
	in = complete("git status", strings.Repeat("a", excerptLimit-1)+"é", "")
	got = ProjectAudit(in, identity).Stdout
	if got.State != "filtered-truncated" || !utf8.ValidString(got.Text) || len(got.Text) > excerptLimit {
		t.Fatal("invalid truncated text")
	}
}

func TestProjectionFilterFailureNeverReturnsInput(t *testing.T) {
	in := complete("git status", "example", "")
	for _, filter := range []AuditScalarFilter{nil, func(string) (string, error) { return "private error", errors.New("private error") }, func(string) (string, error) { panic("private panic") }} {
		got := ProjectAudit(in, filter)
		encoded, err := json.Marshal(got)
		if err != nil || got.Stdout.State != "unavailable" || strings.Contains(string(encoded), "example") || strings.Contains(string(encoded), "private") {
			t.Fatal("failure exposed data")
		}
	}
}

func TestProjectionBoundsEncodedEntry(t *testing.T) {
	in := complete(strings.Repeat("\"", excerptLimit), strings.Repeat("\"", excerptLimit), strings.Repeat("\"", excerptLimit))
	got := ProjectAudit(in, identity)
	encoded, err := json.Marshal(got)
	if err != nil || len(encoded) > entryLimit {
		t.Fatal("encoded entry exceeded limit")
	}
}

func TestProjectionBoundsEncodedEntryWhenOutputIsIncomplete(t *testing.T) {
	in := complete(strings.Repeat("&", excerptLimit), "partial", "")
	in.OutputLimited = true
	got := ProjectAudit(in, identity)
	encoded, err := json.Marshal(got)
	if err != nil || len(encoded) > entryLimit || got.Command.State != "withheld" || got.Command.Reason != "entry_limit" || got.Stdout.Reason != "source_incomplete" || got.Stderr.Reason != "source_incomplete" {
		t.Fatal("incomplete capture exceeded encoded entry limit")
	}
}

func TestCommandIsFilteredBeforeRetainedAndRawInputIsIgnored(t *testing.T) {
	command := ProjectAuditCommand("git --password=FAKE_SECRET", identity)
	in := complete("raw FAKE_SECRET", "ordinary output", "")
	got := ProjectAuditWithCommand(in, command, identity)
	encoded, err := json.Marshal(got)
	if err != nil || strings.Contains(string(encoded), "FAKE_SECRET") || got.Command.Text != "[REDACTED]" || got.Stdout.Text != "ordinary output" {
		t.Fatal("command was not filtered before retention")
	}
	got = ProjectAuditWithCommand(in, AuditCommand{}, identity)
	if got.Command.State != "unavailable" || got.Command.Text != "" {
		t.Fatal("zero command exposed unfiltered input")
	}
}

func TestCommandMasksAdditionalCredentialForms(t *testing.T) {
	for _, command := range []string{"curl -u fake:FAKE_SECRET example.test", "tool --auth FAKE_SECRET", "git fetch ssh://fake:FAKE_SECRET@example.test/repo"} {
		got := ProjectAuditCommand(command, identity).excerpt
		if got.State != "filtered" || got.Text != "[REDACTED]" {
			t.Fatalf("credential-bearing command escaped masking: %#v", got)
		}
	}
}
