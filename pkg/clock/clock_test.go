package clock

import (
	"testing"
	"time"
)

func TestSystemNow(t *testing.T) {
	before := time.Now()
	got := System{}.Now()
	after := time.Now()
	if got.Before(before) || got.After(after) {
		t.Fatalf("Now() = %v, want within [%v, %v]", got, before, after)
	}
	if got.Location() != time.Local {
		t.Fatalf("Now() location = %v, want the local zone as time.Now returns", got.Location())
	}
}
