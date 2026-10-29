package boot

import (
	"context"
	"errors"
	"testing"
)

func TestSelfTestScratchReservationBlocksConcurrentShellBeforeNativeAdmission(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	s.mutations.operations["scratch"] = &settingsMutationOperation{stageScratch: true, pending: true}
	out, err := s.startProcess(context.Background(), s.current, "concurrent-process", "concurrent-call", native.selectLaunch)
	if err == nil || out != nil || native.selects != 0 || journal.reserves != 0 {
		t.Fatal("shell entered while scratch admission was pending", out, err)
	}
}

func TestSelfTestShellControlsOriginalOwnerOnce(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "self-process", "self-call", "self-cancel", selfTestShellCancel)
	if err != nil {
		t.Fatal(err)
	}
	start, err := check.start(context.Background())
	if err != nil || start.OperationID != "self-process" || start.Handle != native.Handle() || native.spawns != 1 || journal.reserves != 1 || native.requests[0].Command != "/bin/sleep 30" {
		t.Fatal("wrong start", start, err)
	}
	if _, err := check.start(context.Background()); err == nil || native.spawns != 1 {
		t.Fatal("start repeated")
	}
	read, err := check.read(context.Background(), 0, 0)
	if err != nil || read.Handle != start.Handle || read.State != "running" {
		t.Fatal("wrong read", read, err)
	}
	ack, err := check.cancel(context.Background())
	if err != nil || ack.Status != "requested" || native.cancels != 1 {
		t.Fatal("wrong cancellation", ack, err)
	}
	if _, err := check.cancel(context.Background()); err == nil || native.cancels != 1 {
		t.Fatal("cancel repeated")
	}
	read, err = check.read(context.Background(), 0, 0)
	if err != nil || read.Handle != start.Handle {
		t.Fatal("original handle lost", read, err)
	}
}

func TestSelfTestShellUnknownCancelNeverRetries(t *testing.T) {
	s, _, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "self-process", "self-call", "self-cancel", selfTestShellCancel)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := check.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	native.cancelErr = errors.New("synthetic lost acknowledgement")
	if _, err := check.cancel(context.Background()); err == nil || native.cancels != 1 {
		t.Fatal("unknown not preserved")
	}
	native.cancelErr = nil
	if _, err := check.cancel(context.Background()); err == nil || native.cancels != 1 {
		t.Fatal("unknown cancel retried")
	}
}

func TestSelfTestShellRefusesInvalidOrReplacedAuthority(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	if _, err := newSelfTestShell(s, s.current, "work", "same", "call", "same", selfTestShellCancel); err == nil {
		t.Fatal("same operation IDs accepted")
	}
	check, err := newSelfTestShell(s, s.current, "work", "self-process", "self-call", "self-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := check.start(context.Background()); err == nil {
		t.Fatal("retired owner admitted")
	}
	if _, err := check.start(context.Background()); err == nil || journal.reserves != 0 || native.spawns != 0 {
		t.Fatal("retired owner retried")
	}
}

func TestSelfTestQuickCommandDoesNotCancel(t *testing.T) {
	s, _, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "quick-process", "quick-call", "quick-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := check.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(native.requests) != 1 || native.requests[0].Command != "printf 'farol self-test\\n'" || native.requests[0].Write {
		t.Fatal("quick test did not use the fixed read-only command")
	}
	if _, err := check.cancel(context.Background()); err == nil || native.cancels != 0 {
		t.Fatal("quick test acquired cancel authority")
	}
}
