package boot

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSelfTestShellCheckPreservesUnknownCancellation(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellCancel)
	if err != nil {
		t.Fatal(err)
	}
	native.cancelErr = errors.New("synthetic lost acknowledgement")
	result := check.check(context.Background())
	if result.Status != "unknown" || result.Operation != "check-process" || result.Handle != native.Handle() || result.CancelOperation != "check-cancel" || native.spawns != 1 || native.cancels != 1 || journal.reserves != 1 {
		t.Fatal("lost original unknown", result)
	}
	native.cancelErr = nil
	_ = check.check(context.Background())
	if native.spawns != 1 || native.cancels != 1 || journal.reserves != 1 {
		t.Fatal("unknown operation repeated")
	}
}

func TestSelfTestShellCheckDeadlineIsUnknown(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := check.check(ctx)
	if result.Status != "unknown" || result.Code != "PROCESS_OUTCOME_UNKNOWN" || result.Handle != native.Handle() || native.spawns != 1 || journal.reserves != 1 {
		t.Fatal("deadline promoted", result)
	}
}

func TestSelfTestShellCheckReadFailureDoesNotSettleStartedProcess(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	native.readErr = errors.New("synthetic read refusal")
	result := check.check(context.Background())
	if result.Status != "unknown" || result.Handle != native.Handle() || native.spawns != 1 || journal.reserves != 1 {
		t.Fatal("read failure misclassified", result)
	}
}
