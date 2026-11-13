package fake

import (
	"testing"
	"time"
)

func TestClockNow(t *testing.T) {
	at := time.Date(2026, 11, 13, 12, 30, 0, 7, time.UTC)
	c := Clock{At: at}
	for i := 0; i < 3; i++ {
		if got := c.Now(); !got.Equal(at) {
			t.Fatalf("Now() = %v, want %v", got, at)
		}
	}
	if got := (Clock{}).Now(); !got.IsZero() {
		t.Fatalf("zero Clock Now() = %v, want the zero time", got)
	}
}
