//go:build darwin

package process

import (
	"fmt"
	"syscall"
	"testing"
)

// Error classification only; systemProbe is never called.
func TestConformanceDenialClassificationDoesNotTreatMissingOrRefusedListenerAsPolicy(t *testing.T) {
	for _, value := range []error{syscall.EPERM, syscall.EACCES, fmt.Errorf("wrapped: %w", syscall.EPERM)} {
		if !permissionDenied(value) {
			t.Fatal("missing denied classification", value)
		}
	}
	for _, value := range []error{nil, syscall.ENOENT, syscall.ELOOP, syscall.ECONNREFUSED, syscall.ETIMEDOUT} {
		if permissionDenied(value) {
			t.Fatal("false confinement proof", value)
		}
	}
}
