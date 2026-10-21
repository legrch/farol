package migration

import (
	"reflect"
	"testing"
)

func alphaSnapshot() Snapshot {
	return Snapshot{
		Profile: Production, Operation: "identity-operation-1", AlphaBuild: "accepted-alpha-build",
		Source:      Entry{State: CurrentAlpha, Object: Object{"device-1", "inode-alpha"}, AlphaBuild: "accepted-alpha-build"},
		Destination: Entry{State: Missing}, Record: Record{Phase: NoRecord},
		Writers: Closed, Exclusive: true,
	}
}

func recorded(phase Phase) Snapshot {
	s := alphaSnapshot()
	s.Record = Record{Version: 1, Phase: phase, Operation: s.Operation, AlphaBuild: s.AlphaBuild, Source: s.Source.Object}
	return s
}

func relocated(phase Phase) Snapshot {
	s := recorded(phase)
	s.Destination, s.Source = s.Source, Entry{State: Missing}
	return s
}

func wantAction(t *testing.T, s Snapshot, action Action) Decision {
	t.Helper()
	before := s
	decision, err := Plan(s)
	if err != nil || decision.Action != action {
		t.Fatalf("Plan: got %+v, %v; want %s", decision, err, action)
	}
	if s != before {
		t.Fatal("planning changed its observation")
	}
	return decision
}

func wantRefusal(t *testing.T, s Snapshot, code Code) {
	t.Helper()
	decision, err := Plan(s)
	if err != code || decision != (Decision{}) {
		t.Fatalf("Plan: got %+v, %v; want empty decision and %s", decision, err, code)
	}
}

func TestFinalIdentity(t *testing.T) {
	for _, tc := range []struct {
		profile  Profile
		identity Identity
	}{
		{Production, Identity{"Farol", "io.github.legrch.farol", "io.github.legrch.farol", "persist:farol"}},
		{Development, Identity{"Farol Dev", "io.github.legrch.farol.dev", "Farol Dev", "persist:farol-dev"}},
	} {
		identity, err := FinalIdentity(tc.profile)
		if err != nil || identity != tc.identity {
			t.Fatalf("identity: %+v, %v", identity, err)
		}
	}
	if identity, err := FinalIdentity(Profile("preview")); identity != (Identity{}) || err != InvalidProfile {
		t.Fatalf("unsupported profile was admitted: %+v, %v", identity, err)
	}
}

func TestPrepareExactCurrentAlpha(t *testing.T) {
	s := alphaSnapshot()
	decision := wantAction(t, s, PrepareIntent)
	if decision.From != AlphaDirectory || decision.To != "io.github.legrch.farol" || decision.Expected != s.Source.Object {
		t.Fatalf("unbound relocation: %+v", decision)
	}
	// Only a durable, exact Prepared record makes a first dispatch eligible.
	wantAction(t, recorded(Prepared), MoveProfile)
}

func TestInterruptedCutover(t *testing.T) {
	// Interruption before dispatch has no possible effect and retains the intent.
	wantAction(t, recorded(Prepared), MoveProfile)
	// Once dispatch might have happened, repeated observation never dispatches again.
	s := recorded(Dispatched)
	for i := 0; i < 3; i++ {
		wantAction(t, s, ObserveOnly)
	}
	// A root at the destination must be the exact original physical directory.
	wantAction(t, relocated(Dispatched), RecordRelocation)
	wantAction(t, relocated(Relocated), VerifyLayout)
	// Relocation alone cannot report a completed identity or launch authority.
	s = relocated(Completed)
	wantRefusal(t, s, RelocationLost)
	s.Destination.State = Final
	wantAction(t, s, AlreadyMigrated)
}

func TestAlreadyMigratedIsNoOp(t *testing.T) {
	s := relocated(Completed)
	s.Destination.State = Final
	s.Writers, s.Exclusive = Active, false
	decision := wantAction(t, s, AlreadyMigrated)
	if decision.From != "" || decision.To != "" || decision.Expected != (Object{}) {
		t.Fatal("already migrated planned another relocation")
	}
	// A source reappearing beside the final destination is a collision, even if
	// both entries refer to the same object on a case-insensitive filesystem.
	s.Source = s.Destination
	wantRefusal(t, s, DestinationCollision)
}

func TestDestinationCollisionNeverMerges(t *testing.T) {
	for _, state := range []EntryState{CurrentAlpha, Final, Foreign} {
		t.Run(string(state), func(t *testing.T) {
			s := alphaSnapshot()
			s.Destination = Entry{State: state, Object: Object{"device-1", "inode-other"}}
			if state != Foreign {
				s.Destination.AlphaBuild = s.AlphaBuild
			}
			wantRefusal(t, s, DestinationCollision)
		})
	}
	// A retired V0 at Farol is an existing destination, never a migration source.
	s := alphaSnapshot()
	s.Source = Entry{State: Missing}
	s.Destination = Entry{State: Foreign, Object: Object{"device-1", "inode-v0"}}
	wantRefusal(t, s, DestinationCollision)
}

func TestCurrentAlphaPreservation(t *testing.T) {
	// In-memory whole-directory rename model only. It does not exercise a native
	// filesystem, Chromium or a provider. Opaque state is never parsed/recreated.
	payload := map[string]string{
		"farol-next-state/config.json":          `{"configured":true,"generation":9}`,
		"farol-next-state/grants.json":          `{"workspace":"fixture-root","write":false}`,
		"farol-next-state/operations.json":      `{"operation":"fixture-op","status":"outcome-unknown"}`,
		"farol-next-state/update.json":          `{"status":"helper-outcome-unknown","attempt":1}`,
		"farol-next-state/task.json":            `{"status":"cancel-unknown","delivered":false}`,
		"Partitions/farol-next-chatgpt/fixture": "opaque-browser-fixture",
		"farol-next-private/fixture":            "opaque-private-fixture",
		"unrecognized-future-state/fixture":     "retain-without-interpretation",
	}
	before := make(map[string]string, len(payload))
	for key, value := range payload {
		before[key] = value
	}
	tree := map[string]map[string]string{AlphaDirectory: payload, "Farol Dev": {"fixture": "dev-stays"}}
	decision := wantAction(t, recorded(Prepared), MoveProfile)
	if _, exists := tree[decision.To]; exists {
		t.Fatal("model destination must be absent")
	}
	tree[decision.To] = tree[decision.From]
	delete(tree, decision.From)
	if !reflect.DeepEqual(before, tree["io.github.legrch.farol"]) {
		t.Fatal("alpha data was changed, filtered or recreated")
	}
	if tree["Farol Dev"]["fixture"] != "dev-stays" {
		t.Fatal("production relocation changed Dev")
	}
}

func TestClosedProfileAndSingleWriterRequired(t *testing.T) {
	for _, phase := range []Phase{NoRecord, Prepared, Dispatched, Relocated} {
		for _, tc := range []struct {
			writers   Writers
			exclusive bool
			code      Code
		}{
			{Active, true, WriterActive}, {Unknown, true, WriterUnknown},
			{Closed, false, LeaseRequired}, {Writers("unrecognized"), true, InvalidObservation},
		} {
			t.Run(string(phase)+"/"+string(tc.writers), func(t *testing.T) {
				s := alphaSnapshot()
				if phase != NoRecord {
					s = recorded(phase)
				}
				if phase == Relocated {
					s = relocated(phase)
				}
				s.Writers, s.Exclusive = tc.writers, tc.exclusive
				wantRefusal(t, s, tc.code)
			})
		}
	}
}

func TestDevSeparation(t *testing.T) {
	production, _ := FinalIdentity(Production)
	dev, _ := FinalIdentity(Development)
	if production == dev || production.Bundle == dev.Bundle || production.Directory == dev.Directory || production.Partition == dev.Partition {
		t.Fatal("Dev and production share a persistent identity")
	}
	// Development does not even validate/read the supplied production snapshot.
	for _, phase := range []Phase{NoRecord, Prepared, Dispatched, Relocated, Completed, Refused} {
		s := Snapshot{Profile: Development, Record: Record{Phase: phase}, Source: Entry{State: Unreadable}, Destination: Entry{State: Unsafe}}
		wantAction(t, s, SkipDevelopment)
	}
}

func TestFreshAndExistingFinal(t *testing.T) {
	s := alphaSnapshot()
	s.Source = Entry{State: Missing}
	wantAction(t, s, FreshProfile)
	s.Destination = Entry{State: Final, Object: Object{"device-1", "inode-final"}}
	wantAction(t, s, ExistingFinal)
	s.Destination.AlphaBuild = "accepted-alpha-build"
	wantAction(t, s, ExistingFinal)
	// No receipt plus an alpha at the new path cannot fabricate completed migration.
	s.Destination.State = CurrentAlpha
	wantRefusal(t, s, RelocationLost)
}

func TestUnprovenObservationsFailClosed(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Snapshot)
		code   Code
	}{
		{"unknown-profile", func(s *Snapshot) { s.Profile = "preview" }, InvalidProfile},
		{"source-unreadable", func(s *Snapshot) { s.Source.State = Unreadable }, ObservationUnknown},
		{"destination-unreadable", func(s *Snapshot) { s.Destination.State = Unreadable }, ObservationUnknown},
		{"source-symlink", func(s *Snapshot) { s.Source.State = Unsafe }, UnsafeEntry},
		{"destination-unsafe", func(s *Snapshot) { s.Destination.State = Unsafe }, UnsafeEntry},
		{"unknown-entry", func(s *Snapshot) { s.Source.State = "new-state" }, InvalidObservation},
		{"missing-with-object", func(s *Snapshot) { s.Destination.Object = s.Source.Object }, InvalidObservation},
		{"unproven-object", func(s *Snapshot) { s.Source.Object.File = "" }, InvalidObservation},
		{"unproven-build", func(s *Snapshot) { s.Source.AlphaBuild = "" }, InvalidObservation},
		{"wrong-alpha-build", func(s *Snapshot) { s.Source.AlphaBuild = "unaccepted-build" }, BindingConflict},
		{"foreign-source", func(s *Snapshot) { s.Source.State = Foreign; s.Source.AlphaBuild = "" }, SourceUnproven},
		{"final-source", func(s *Snapshot) { s.Source.State = Final }, SourceUnproven},
		{"empty-operation", func(s *Snapshot) { s.Operation = "" }, RecordInvalid},
		{"unknown-record", func(s *Snapshot) { s.Record.Phase = "unexpected" }, RecordInvalid},
		{"missing-record-payload", func(s *Snapshot) { s.Record.Operation = s.Operation }, RecordInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { s := alphaSnapshot(); tc.change(&s); wantRefusal(t, s, tc.code) })
	}
}

func TestRecordBindingAndPhysicalReadback(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Snapshot)
		code   Code
	}{
		{"version", func(s *Snapshot) { s.Record.Version = 2 }, RecordInvalid},
		{"operation-conflict", func(s *Snapshot) { s.Operation = "other-operation" }, BindingConflict},
		{"build-conflict", func(s *Snapshot) { s.AlphaBuild = "other-build" }, BindingConflict},
		{"record-object-absent", func(s *Snapshot) { s.Record.Source = Object{} }, RecordInvalid},
		{"source-replaced", func(s *Snapshot) { s.Source.Object.File = "replacement" }, BindingConflict},
		{"refused", func(s *Snapshot) { s.Record.Phase = Refused }, RecordRefused},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { s := recorded(Prepared); tc.change(&s); wantRefusal(t, s, tc.code) })
	}
	for _, phase := range []Phase{Dispatched, Relocated, Completed} {
		s := relocated(phase)
		if phase == Completed {
			s.Destination.State = Final
		}
		s.Destination.Object.File = "replacement"
		wantRefusal(t, s, RelocationLost)
		s = recorded(phase)
		s.Source = Entry{State: Missing}
		wantRefusal(t, s, RelocationLost)
	}
}
