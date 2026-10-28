package process

import (
	"strings"
	"testing"
)

func TestScalarFilterMasksSyntheticCredentialsAndRetainsDiagnostics(t *testing.T) {
	filter := NewScalarFilter()
	for _, test := range []struct {
		name, input, want string
	}{
		{"github", "prefix ghp_" + strings.Repeat("A", 30) + " suffix", "[REDACTED]"},
		{"service", "prefix sk-" + strings.Repeat("A", 30) + " suffix", "[REDACTED]"},
		{"cloud", "prefix AKIA" + strings.Repeat("A", 16) + " suffix", "[REDACTED]"},
		{"ordinary", "fatal: not a git repository\n", "fatal: not a git repository\n"},
		{"short", "sk-short", "sk-short"},
		{"unicode", "Café 日本語\n", "Café 日本語\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := filter(test.input)
			if err != nil || got != test.want {
				t.Fatalf("unexpected projection: %q, %v", got, err)
			}
		})
	}
}
