package boot

import (
	"strings"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processinfra "github.com/legrch/farol/modules/computer/infra/process"
)

func TestProductionAuditFilterSyntheticCorpus(t *testing.T) {
	filter := processinfra.NewScalarFilter()
	for _, test := range []struct{ name, value, state, want string }{
		{"pwd", "/tmp/example\n", "filtered", "/tmp/example\n"},
		{"git", " M file.txt\n", "filtered", " M file.txt\n"},
		{"error", "fatal: not a git repository\n", "filtered", "fatal: not a git repository\n"},
		{"utf8", "Café 日本語\n", "filtered", "Café 日本語\n"},
		{"tab", "a\tb\n", "filtered", "a\tb\n"},
		{"binary", string([]byte{0xff}), "withheld", ""},
		{"nul", "a\x00b", "withheld", ""},
		{"overwrite", "a\rb", "withheld", ""},
		{"backspace", "a\bb", "withheld", ""},
		{"bidi", "a\u202eb", "withheld", ""},
		{"ansi", "\x1b[31mred", "withheld", ""},
		{"osc", "\x1b]8;;https://example.test\x07", "withheld", ""},
		{"bearer", "Authorization: Bearer SYNTHETIC", "filtered", "[REDACTED]"},
		{"cookie", "Cookie: session=SYNTHETIC", "filtered", "[REDACTED]"},
		{"password", "password=SYNTHETIC", "filtered", "[REDACTED]"},
		{"flag", "--token SYNTHETIC", "filtered", "[REDACTED]"},
		{"userinfo", "https://fake:SYNTHETIC@example.test", "filtered", "[REDACTED]"},
		{"query", "https://example.test/?token=SYNTHETIC", "filtered", "[REDACTED]"},
		{"pem", "-----BEGIN PRIVATE KEY-----\nSYNTHETIC", "filtered", "[REDACTED]"},
		{"jwt", "eyJabcdefghij.abcdefghij.abcdefghij", "filtered", "[REDACTED]"},
		{"github", "ghp_" + strings.Repeat("A", 30), "filtered", "[REDACTED]"},
		{"service", "sk-" + strings.Repeat("A", 30), "filtered", "[REDACTED]"},
		{"cloud", "AKIA" + strings.Repeat("A", 16), "filtered", "[REDACTED]"},
		{"hex", strings.Repeat("0a1b", 25), "filtered", "[REDACTED]"},
		{"base64", strings.Repeat("aB3d", 25), "filtered", "[REDACTED]"},
		{"oversize", strings.Repeat("x", 65537), "withheld", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := []byte(test.value)
			result := processsvc.ProjectAudit(processsvc.AuditInput{Stdout: data, OutputDrained: true, StdoutNext: uint64(len(data)), StdoutBytes: uint64(len(data))}, filter).Stdout
			if result.State != test.state || result.Text != test.want {
				t.Fatalf("unexpected projection: %#v", result)
			}
		})
	}
}
