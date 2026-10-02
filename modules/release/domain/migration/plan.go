package migration

// Code is a classified refusal, not a retry instruction.
type Code string

func (c Code) Error() string { return string(c) }

const (
	InvalidProfile       Code = "MIGRATION_PROFILE_INVALID"
	InvalidObservation   Code = "MIGRATION_OBSERVATION_INVALID"
	UnsafeEntry          Code = "MIGRATION_ENTRY_UNSAFE"
	ObservationUnknown   Code = "MIGRATION_OBSERVATION_UNKNOWN"
	DestinationCollision Code = "MIGRATION_DESTINATION_COLLISION"
	SourceUnproven       Code = "MIGRATION_SOURCE_UNPROVEN"
	BindingConflict      Code = "MIGRATION_BINDING_CONFLICT"
	RecordInvalid        Code = "MIGRATION_RECORD_INVALID"
	RecordRefused        Code = "MIGRATION_RECORD_REFUSED"
	WriterActive         Code = "MIGRATION_WRITER_ACTIVE"
	WriterUnknown        Code = "MIGRATION_WRITER_UNKNOWN"
	LeaseRequired        Code = "MIGRATION_EXCLUSIVE_LEASE_REQUIRED"
	RelocationLost       Code = "MIGRATION_RELOCATION_UNPROVEN"
)

type EntryState string

const (
	Missing      EntryState = "missing"
	CurrentAlpha EntryState = "current-alpha"
	Final        EntryState = "final"
	Foreign      EntryState = "foreign"
	Unsafe       EntryState = "unsafe"
	Unreadable   EntryState = "unreadable"
)

// Object is the observed physical directory identity, not a path or PID.
// The adapter must reject links, aliases, wrong ownership and unsafe ancestors.
type Object struct {
	Device string
	File   string
}

func (o Object) valid() bool { return bounded(o.Device) && bounded(o.File) }

type Entry struct {
	State  EntryState
	Object Object
	// AlphaBuild binds accepted current-alpha provenance, including at the new path.
	// Directory spelling alone is never proof of this provenance.
	AlphaBuild string
}

type Phase string

const (
	NoRecord   Phase = "none"
	Prepared   Phase = "prepared"
	Dispatched Phase = "dispatched"
	Relocated  Phase = "relocated"
	Completed  Phase = "completed"
	Refused    Phase = "refused"
)

// Record is supplied by Release's durable journal adapter. The policy neither
// creates a second operation journal nor rewrites existing operation outcomes.
type Record struct {
	Version    uint32
	Phase      Phase
	Operation  string
	AlphaBuild string
	Source     Object
}

type Writers string

const (
	Closed  Writers = "closed"
	Active  Writers = "active"
	Unknown Writers = "unknown"
)

type Snapshot struct {
	Profile     Profile
	Operation   string
	AlphaBuild  string
	Source      Entry
	Destination Entry
	Record      Record
	// Closed covers both roots and all profile-owning descendants/helpers.
	Writers Writers
	// The native adapter verifies one lock covering both fixed roots and keeps
	// it through observation, durable intent, no-replace rename and readback.
	Exclusive bool
}

type Action string

const (
	SkipDevelopment  Action = "skip-development"
	FreshProfile     Action = "fresh-profile"
	ExistingFinal    Action = "existing-final"
	PrepareIntent    Action = "prepare-intent"
	MoveProfile      Action = "move-profile"
	ObserveOnly      Action = "observe-only"
	RecordRelocation Action = "record-relocation"
	VerifyLayout     Action = "verify-layout"
	AlreadyMigrated  Action = "already-migrated"
)

// Decision plans only the outer profile relocation. VerifyLayout is a stop at
// the separately owned partition/state/operation reconciliation contract. It is
// not approval to launch a runtime or a declaration that cutover is complete.
type Decision struct {
	Action   Action
	From     string
	To       string
	Expected Object
}

func bounded(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, b := range []byte(value) {
		if b < 0x21 || b > 0x7e {
			return false
		}
	}
	return true
}

func validateEntry(entry Entry) error {
	switch entry.State {
	case Missing:
		if entry.Object != (Object{}) || entry.AlphaBuild != "" {
			return InvalidObservation
		}
	case CurrentAlpha:
		if !entry.Object.valid() || !bounded(entry.AlphaBuild) {
			return InvalidObservation
		}
	case Final:
		if !entry.Object.valid() || (entry.AlphaBuild != "" && !bounded(entry.AlphaBuild)) {
			return InvalidObservation
		}
	case Foreign:
		if !entry.Object.valid() || entry.AlphaBuild != "" {
			return InvalidObservation
		}
	case Unsafe:
		return UnsafeEntry
	case Unreadable:
		return ObservationUnknown
	default:
		return InvalidObservation
	}
	return nil
}

func validateRecord(s Snapshot) error {
	r := s.Record
	if r.Phase == NoRecord {
		if r != (Record{Phase: NoRecord}) {
			return RecordInvalid
		}
		return nil
	}
	switch r.Phase {
	case Prepared, Dispatched, Relocated, Completed, Refused:
	default:
		return RecordInvalid
	}
	if r.Version != 1 || !bounded(r.Operation) || !bounded(r.AlphaBuild) || !r.Source.valid() {
		return RecordInvalid
	}
	if r.Operation != s.Operation || r.AlphaBuild != s.AlphaBuild {
		return BindingConflict
	}
	if r.Phase == Refused {
		return RecordRefused
	}
	return nil
}

func exclusive(s Snapshot) error {
	switch s.Writers {
	case Closed:
	case Active:
		return WriterActive
	case Unknown:
		return WriterUnknown
	default:
		return InvalidObservation
	}
	if !s.Exclusive {
		return LeaseRequired
	}
	return nil
}

func Plan(s Snapshot) (Decision, error) {
	if s.Profile == Development {
		// Do not inspect or migrate production observations during a Dev launch.
		return Decision{Action: SkipDevelopment}, nil
	}
	if s.Profile != Production {
		return Decision{}, InvalidProfile
	}
	if err := validateEntry(s.Source); err != nil {
		return Decision{}, err
	}
	if err := validateEntry(s.Destination); err != nil {
		return Decision{}, err
	}
	if err := validateRecord(s); err != nil {
		return Decision{}, err
	}
	if s.Source.State != Missing && s.Destination.State != Missing {
		// Even a same-object alias is not an unambiguous atomic rename boundary.
		return Decision{}, DestinationCollision
	}
	if s.Destination.State == Foreign {
		return Decision{}, DestinationCollision
	}
	if s.Source.State != Missing && s.Source.State != CurrentAlpha {
		return Decision{}, SourceUnproven
	}
	decision := Decision{From: AlphaDirectory, To: "Farol"}
	if s.Record.Phase == NoRecord {
		if s.Source.State == Missing {
			switch s.Destination.State {
			case Missing:
				return Decision{Action: FreshProfile}, nil
			case Final:
				return Decision{Action: ExistingFinal}, nil
			default:
				return Decision{}, RelocationLost
			}
		}
		if !bounded(s.Operation) || !bounded(s.AlphaBuild) {
			return Decision{}, RecordInvalid
		}
		if s.Source.AlphaBuild != s.AlphaBuild {
			return Decision{}, BindingConflict
		}
		if err := exclusive(s); err != nil {
			return Decision{}, err
		}
		decision.Action, decision.Expected = PrepareIntent, s.Source.Object
		return decision, nil
	}
	decision.Expected = s.Record.Source
	atSource := s.Source.State == CurrentAlpha && s.Source.Object == s.Record.Source && s.Source.AlphaBuild == s.Record.AlphaBuild
	atDestination := (s.Destination.State == CurrentAlpha || s.Destination.State == Final) && s.Destination.Object == s.Record.Source && s.Destination.AlphaBuild == s.Record.AlphaBuild
	if s.Record.Phase == Prepared {
		if !atSource || s.Destination.State != Missing {
			return Decision{}, BindingConflict
		}
		if err := exclusive(s); err != nil {
			return Decision{}, err
		}
		// Persist Dispatched BEFORE one same-volume no-replace root rename.
		decision.Action = MoveProfile
		return decision, nil
	}
	if s.Record.Phase == Dispatched {
		if err := exclusive(s); err != nil {
			return Decision{}, err
		}
		if atSource && s.Destination.State == Missing {
			// An unknown dispatch is never another move, even if source still exists.
			decision.Action = ObserveOnly
			return decision, nil
		}
		if s.Source.State == Missing && atDestination {
			decision.Action = RecordRelocation
			return decision, nil
		}
		return Decision{}, RelocationLost
	}
	if s.Source.State != Missing || !atDestination {
		return Decision{}, RelocationLost
	}
	if s.Record.Phase == Completed {
		if s.Destination.State != Final {
			return Decision{}, RelocationLost
		}
		return Decision{Action: AlreadyMigrated}, nil
	}
	if err := exclusive(s); err != nil {
		return Decision{}, err
	}
	decision.Action = VerifyLayout
	return decision, nil
}
