package process

import (
	"strings"
	"sync"
	"testing"
)

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
