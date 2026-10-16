package boot

import (
	"context"
	"testing"
	"time"
)

type preservedProfileLagContext struct {
	context.Context
	until time.Time
	reads int
}

func (c *preservedProfileLagContext) Deadline() (time.Time, bool) { c.reads++; return c.until, true }

func TestPreservedProfileKeepsOneOriginalAbsoluteBudget(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	original := &preservedProfileLagContext{Context: parent, until: time.Now().Add(80 * time.Millisecond)}
	bounded, err := bindPreservedProfileContext(original)
	if err != nil {
		t.Fatal(err)
	}
	deadline, _ := bounded.Deadline()
	original.until = deadline.Add(time.Hour)
	again, err := bindPreservedProfileContext(bounded)
	if err != nil || original.reads != 1 {
		t.Fatal("nested phase renewed the original budget", err, original.reads)
	}
	time.Sleep(time.Until(deadline) + time.Millisecond)
	if original.Err() != nil || again.Err() != context.DeadlineExceeded {
		t.Fatal("lagging timer or replacement deadline revived a phase")
	}
	if _, err := bindPreservedProfileContext(again); err == nil {
		t.Fatal("expired phase admitted more IO")
	}
}
func TestPreservedProfileRefusesMissingOrCancelledOriginalBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	cancel()
	for _, current := range []context.Context{nil, context.Background(), ctx, &preservedProfileLagContext{Context: context.Background(), until: time.Now().Add(-time.Second)}} {
		if _, err := bindPreservedProfileContext(current); err == nil {
			t.Fatal("unbounded or cancelled context accepted")
		}
		if err := inspectPreservedProfile(current, preservedProfileInspectionInput{}, func(preservedProfileInspection) error { t.Fatal("invalid input reached visitor"); return nil }); err == nil {
			t.Fatal("invalid observation admitted")
		}
	}
}
