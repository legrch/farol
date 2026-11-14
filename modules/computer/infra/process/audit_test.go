package process

import (
	"strings"
	"sync"
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

// The production host shares a single filter across concurrent terminal
// observations. A secret in one stream must not affect another stream.
func TestScalarFilterConcurrentObservations(t *testing.T) {
	filter := NewScalarFilter()
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func(worker int) {
			defer workers.Done()
			for j := 0; j < 100; j++ {
				input, want := "git status: clean", "git status: clean"
				if (worker+j)%2 == 0 {
					input, want = "ghp_"+strings.Repeat("A", 30), "[REDACTED]"
				}
				got, err := filter(input)
				if err != nil || got != want {
					t.Errorf("concurrent filter result = %q, %v; want %q", got, err, want)
					return
				}
			}
		}(i)
	}
	workers.Wait()
}
