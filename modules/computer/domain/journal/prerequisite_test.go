package journal

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func stopTestRequest(n int) StopRequest {
	id := func(offset int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n*10+offset) }
	return StopRequest{
		OperationID: id(1), RequestDigest: strings.Repeat("a", 64), CommandKind: "computer.update-access", CommandDigest: strings.Repeat("b", 64), Purpose: "workspace-change",
		ProfileID: "profile", OwnerID: "owner", ComputerID: "computer", WorkspaceID: "workspace", Root: "/approved", ConsentDigest: strings.Repeat("c", 64),
		ExpectedRevision: "7", ComputerGeneration: "3", ConnectorGeneration: "2", SettingsDigest: strings.Repeat("d", 64),
		BootUUID: "11111111-1111-4111-8111-111111111111", HostLifetimeID: "host", BackendGeneration: "backend", RuntimeID: "runtime", BuildID: strings.Repeat("e", 64),
		StopEffectID: id(2), SettingsEffectID: id(3), CleanupEffectID: id(4),
	}
}
func stopNext(t *testing.T, l StopLedger, e StopEntry) StopLedger {
	t.Helper()
	next, err := l.Update(e.Request.OperationID, e)
	if err != nil {
		t.Fatal(e.Phase, err)
	}
	return next
}
func stopCompleteFixture(t *testing.T, r StopRequest) StopLedger {
	t.Helper()
	l, admitted, err := (StopLedger{Entries: []StopEntry{}}).Begin(r)
	if err != nil || !admitted {
		t.Fatal(err)
	}
	e, _ := l.Find(r.OperationID)
	e.Phase = StopEffectIntent
	l = stopNext(t, l, e)
	e.Phase = StopAcknowledged
	e.Closure = &StopClosure{EffectID: r.StopEffectID, BackendGeneration: r.BackendGeneration, RuntimeID: r.RuntimeID, LifecycleID: "22222222-2222-4222-8222-222222222222", StopRevision: "1", PreparationRevision: "0", ClosureOperationID: "33333333-3333-4333-8333-333333333333", ClosureDigest: strings.Repeat("f", 64)}
	l = stopNext(t, l, e)
	e.Phase = StoppedSettingsIntent
	e.SettingsIntent = &StopSettingsPlan{EffectID: r.SettingsEffectID, ExpectedRevision: r.ExpectedRevision, ExpectedDigest: r.SettingsDigest, NextRevision: "8", NextDigest: strings.Repeat("1", 64), ComputerGeneration: r.ComputerGeneration, ConnectorGeneration: r.ConnectorGeneration, ConsentDigest: r.ConsentDigest}
	l = stopNext(t, l, e)
	e.Phase = StoppedSettingsAcknowledged
	e.SettingsAck = &StopSettingsReceipt{EffectID: r.SettingsEffectID, Revision: "8", DocumentDigest: strings.Repeat("1", 64), ComputerGeneration: r.ComputerGeneration, ConnectorGeneration: r.ConnectorGeneration, ConsentDigest: r.ConsentDigest}
	l = stopNext(t, l, e)
	e.Phase = StopCleanupIntent
	l = stopNext(t, l, e)
	e.Phase = StopCleanupAcknowledged
	e.CleanupAck = &StopCleanupReceipt{EffectID: r.CleanupEffectID, BackendGeneration: r.BackendGeneration, RuntimeID: r.RuntimeID, Digest: strings.Repeat("2", 64)}
	l = stopNext(t, l, e)
	e.Phase = StopComplete
	return stopNext(t, l, e)
}

func TestStopRequestPurposeScopeClosed(t *testing.T) {
	r := stopTestRequest(1)
	if !ValidStopRequest(r) {
		t.Fatal("valid original refused")
	}
	for _, purpose := range []string{"update", "quit", "repair", "owner-stop"} {
		t.Run(purpose, func(t *testing.T) {
			bad := r
			bad.Purpose = purpose
			if ValidStopRequest(bad) {
				t.Fatal("purpose changed without changing the original command")
			}
		})
	}
	for _, change := range []func(*StopRequest){
		func(r *StopRequest) { r.StopEffectID = r.OperationID },
		func(r *StopRequest) { r.SettingsEffectID = r.CleanupEffectID },
		func(r *StopRequest) { r.ExpectedRevision = "18446744073709551616" },
		func(r *StopRequest) { r.ConnectorGeneration = "01" },
		func(r *StopRequest) { r.Root = "/approved/../other" },
		func(r *StopRequest) { r.WorkspaceID = "" },
		func(r *StopRequest) { r.ChildMode = "enrolled-rebind" },
		func(r *StopRequest) {
			r.ChildOperationID = r.CleanupEffectID
			r.ChildMode = "legacy-confirm"
			r.ChildIntentDigest = strings.Repeat("3", 64)
		},
	} {
		bad := r
		change(&bad)
		if ValidStopRequest(bad) {
			t.Fatalf("invalid scope accepted: %+v", bad)
		}
	}
}

func TestStopChildIdentityAndModeAreFixedBeforeStop(t *testing.T) {
	for _, selection := range []struct{ command, mode string }{
		{"computer.confirm-workspace", "legacy-confirm"},
		{"computer.rebind-workspace", "enrolled-rebind"},
	} {
		t.Run(selection.mode, func(t *testing.T) {
			r := stopTestRequest(1)
			r.CommandKind = selection.command
			r.ChildOperationID = "44444444-4444-4444-8444-444444444444"
			r.ChildMode = selection.mode
			r.ChildIntentDigest = strings.Repeat("5", 64)
			if !ValidStopRequest(r) {
				t.Fatal("exact intended child refused")
			}
			l, _, err := (StopLedger{Entries: []StopEntry{}}).Begin(r)
			if err != nil {
				t.Fatal(err)
			}
			for _, change := range []func(*StopRequest){
				func(r *StopRequest) { r.ChildOperationID = "55555555-5555-4555-8555-555555555555" },
				func(r *StopRequest) { r.ChildIntentDigest = strings.Repeat("6", 64) },
				func(r *StopRequest) {
					if r.ChildMode == "legacy-confirm" {
						r.ChildMode = "enrolled-rebind"
					} else {
						r.ChildMode = "legacy-confirm"
					}
				},
				func(r *StopRequest) { r.ChildOperationID = ""; r.ChildMode = ""; r.ChildIntentDigest = "" },
				func(r *StopRequest) { r.CommandKind = "computer.update-access" },
			} {
				changed := r
				change(&changed)
				if _, fresh, err := l.Begin(changed); err == nil || fresh {
					t.Fatal("original child changed")
				}
			}
		})
	}
}

func TestStopDuplicateIsObservationAndPendingBlocksOtherParent(t *testing.T) {
	r := stopTestRequest(1)
	l, fresh, err := (StopLedger{Entries: []StopEntry{}}).Begin(r)
	if err != nil || !fresh {
		t.Fatal(err)
	}
	_, fresh, err = l.Begin(r)
	if err != nil || fresh {
		t.Fatal("duplicate granted dispatch", err)
	}
	changed := r
	changed.CommandDigest = strings.Repeat("f", 64)
	if _, _, err = l.Begin(changed); !errors.Is(err, ErrStopRefused) {
		t.Fatal(err)
	}
	if _, _, err = l.Begin(stopTestRequest(2)); !errors.Is(err, ErrStopPending) {
		t.Fatal(err)
	}
}

func TestStopUnknownCannotAdvanceOrBeRefusedBeforeStop(t *testing.T) {
	r := stopTestRequest(1)
	l, _, _ := (StopLedger{Entries: []StopEntry{}}).Begin(r)
	e, _ := l.Find(r.OperationID)
	e.Phase = StopEffectIntent
	l = stopNext(t, l, e)
	refused := e
	refused.Phase = StopRefusedBeforeDispatch
	refused.Refusal = "cancelled_before_dispatch"
	if _, err := l.Update(r.OperationID, refused); !errors.Is(err, ErrStopRefused) {
		t.Fatal("an admitted Stop cannot be declared undispatched", err)
	}
	e.Phase = StopUnresolved
	e.UnresolvedAt = StopEffectIntent
	e.Uncertainty = "stop_unconfirmed"
	l = stopNext(t, l, e)
	if !l.Pending() {
		t.Fatal("lost original Stop ACK released admission")
	}
	if _, err := e.Certificate(); !errors.Is(err, ErrStopRefused) {
		t.Fatal(err)
	}
	if _, _, err := l.Begin(stopTestRequest(2)); !errors.Is(err, ErrStopPending) {
		t.Fatal(err)
	}
	if _, err := l.Update(r.OperationID, e); !errors.Is(err, ErrStopRefused) {
		t.Fatal("uncertain record redispatched", err)
	}
}

func TestStopCertificateRequiresOriginalACKsAndCleanup(t *testing.T) {
	r := stopTestRequest(1)
	l := stopCompleteFixture(t, r)
	e, _ := l.Find(r.OperationID)
	c, err := e.Certificate()
	if err != nil || c.Request != r || c.Settings.Revision != "8" {
		t.Fatal(c, err)
	}
	for _, mutate := range []func(*StopEntry){
		func(e *StopEntry) { e.Closure.RuntimeID = "wrong-runtime" },
		func(e *StopEntry) { e.Closure.BackendGeneration = "wrong-backend" },
		func(e *StopEntry) { e.Closure.EffectID = e.Request.SettingsEffectID },
		func(e *StopEntry) { e.SettingsAck.DocumentDigest = e.Request.SettingsDigest },
		func(e *StopEntry) { e.SettingsAck.Revision = "7" },
		func(e *StopEntry) { e.SettingsAck.ConsentDigest = strings.Repeat("9", 64) },
		func(e *StopEntry) { e.SettingsIntent.NextRevision = "9" },
		func(e *StopEntry) { e.CleanupAck = nil },
		func(e *StopEntry) { e.CleanupAck.EffectID = e.Request.StopEffectID },
		func(e *StopEntry) { e.Phase = StopAcknowledged },
	} {
		bad := e.Clone()
		mutate(&bad)
		if bad.Valid() {
			t.Fatalf("fabricated certificate accepted: %+v", bad)
		}
	}
	copy := l.Clone()
	copy.Entries[0].Closure.RuntimeID = "mutated"
	if !l.Valid() {
		t.Fatal("caller mutated retained original")
	}
}

func TestStopKnownTerminalSuccessionIsBoundedWithoutEviction(t *testing.T) {
	l := StopLedger{Entries: []StopEntry{}}
	for i := 1; i <= MaxStopEntries; i++ {
		r := stopTestRequest(i)
		next, fresh, err := l.Begin(r)
		if err != nil || !fresh {
			t.Fatal(i, err)
		}
		l = next
		e, _ := l.Find(r.OperationID)
		e.Phase = StopRefusedBeforeDispatch
		e.Refusal = "cancelled_before_dispatch"
		l = stopNext(t, l, e)
		if l.Pending() {
			t.Fatal("known no-dispatch refusal remained pending")
		}
	}
	if _, _, err := l.Begin(stopTestRequest(MaxStopEntries + 1)); !errors.Is(err, ErrStopCapacity) {
		t.Fatal(err)
	}
	if len(l.Entries) != MaxStopEntries {
		t.Fatal("custody evicted")
	}
	if _, err := l.Entries[0].Certificate(); !errors.Is(err, ErrStopRefused) {
		t.Fatal("refusal created migration certificate")
	}
}

func TestStopUnconfirmedSettingsAndCleanupRemainPending(t *testing.T) {
	for _, selection := range []struct {
		phase  StopPhase
		reason string
	}{
		{StoppedSettingsIntent, "settings_unconfirmed"},
		{StopCleanupIntent, "cleanup_unconfirmed"},
	} {
		t.Run(string(selection.phase), func(t *testing.T) {
			r := stopTestRequest(1)
			full := stopCompleteFixture(t, r)
			e, _ := full.Find(r.OperationID)
			e.Phase = selection.phase
			e.CleanupAck = nil
			if selection.phase == StoppedSettingsIntent {
				e.SettingsAck = nil
			}
			l := StopLedger{Entries: []StopEntry{e}}
			if !l.Valid() {
				t.Fatal("invalid pending fixture")
			}
			e.Phase = StopUnresolved
			e.UnresolvedAt = selection.phase
			e.Uncertainty = selection.reason
			l = stopNext(t, l, e)
			if !l.Pending() {
				t.Fatal("uncertainty cleared admission")
			}
			if _, err := e.Certificate(); err == nil {
				t.Fatal("missing original ACK supplied a certificate")
			}
			if _, fresh, err := l.Begin(stopTestRequest(2)); !errors.Is(err, ErrStopPending) || fresh {
				t.Fatal("second request dispatched", err)
			}
			_, fresh, err := l.Begin(r)
			if err != nil || fresh {
				t.Fatal("same original request was not observational", err)
			}
		})
	}
}

func TestStopSettingsPlanAndACKCannotBeReplaced(t *testing.T) {
	r := stopTestRequest(1)
	full := stopCompleteFixture(t, r)
	e, _ := full.Find(r.OperationID)
	e.Phase = StoppedSettingsIntent
	e.SettingsAck = nil
	e.CleanupAck = nil
	l := StopLedger{Entries: []StopEntry{e}}
	if !l.Valid() {
		t.Fatal("fixture invalid")
	}
	next := e.Clone()
	next.Phase = StoppedSettingsAcknowledged
	ack := full.Entries[0].SettingsAck
	copy := *ack
	next.SettingsAck = &copy
	next.SettingsIntent.NextDigest = strings.Repeat("3", 64)
	next.SettingsAck.DocumentDigest = next.SettingsIntent.NextDigest
	if _, err := l.Update(r.OperationID, next); !errors.Is(err, ErrStopRefused) {
		t.Fatal("new equal bytes substituted original Settings intent", err)
	}
}

func TestStopCommandScopeBindsGlobalAndSpecificOriginalRoots(t *testing.T) {
	for _, kind := range []string{"computer.add-workspace", "computer.update-commands", "computer.update-file-policy"} {
		t.Run(kind, func(t *testing.T) {
			r := stopTestRequest(5)
			r.CommandKind = kind
			r.WorkspaceID, r.Root = "", ""
			if !ValidStopRequest(r) {
				t.Fatal("global command incorrectly requires an existing workspace")
			}
			foreign := r
			foreign.WorkspaceID, foreign.Root = "borrowed", "/Users/other"
			if ValidStopRequest(foreign) {
				t.Fatal("global command borrowed unrelated native scope")
			}
			incomplete := r
			incomplete.WorkspaceID = "borrowed"
			if ValidStopRequest(incomplete) {
				t.Fatal("partial workspace scope accepted")
			}
		})
	}
	for _, kind := range []string{"computer.update-access", "computer.remove-workspace", "computer.confirm-workspace", "computer.rebind-workspace"} {
		t.Run(kind, func(t *testing.T) {
			r := stopTestRequest(6)
			r.CommandKind = kind
			switch kind {
			case "computer.confirm-workspace":
				r.ChildMode = "legacy-confirm"
				r.ChildOperationID = "77777777-7777-4777-8777-777777777777"
				r.ChildIntentDigest = strings.Repeat("f", 64)
			case "computer.rebind-workspace":
				r.ChildMode = "enrolled-rebind"
				r.ChildOperationID = "77777777-7777-4777-8777-777777777777"
				r.ChildIntentDigest = strings.Repeat("f", 64)
			}
			if !ValidStopRequest(r) {
				t.Fatal("original workspace-specific root refused")
			}
			r.WorkspaceID, r.Root = "", ""
			if ValidStopRequest(r) {
				t.Fatal("workspace-specific command omitted original root")
			}
		})
	}
}
