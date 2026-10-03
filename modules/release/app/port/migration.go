package port

import "context"

// These are consuming application DTOs, not Desktop wire types or a persisted
// journal schema. Release maps its sole-owned durable records explicitly.
type MigrationPhase string

const (
	MigrationPrepared   MigrationPhase = "prepared"
	MigrationDispatched MigrationPhase = "dispatched"
	MigrationRelocated  MigrationPhase = "relocated"
	MigrationCompleted  MigrationPhase = "completed"
	MigrationRefused    MigrationPhase = "refused"
)

// MigrationObject uses lossless native identities, never JS numeric coercion.
type MigrationObject struct {
	Device string
	File   string
}

// MigrationBinding comes from Release's accepted alpha/profile verification.
// An object or directory spelling alone does not establish alpha provenance.
type MigrationBinding struct {
	Operation  string
	AlphaBuild string
	Source     MigrationObject
}

type MigrationRecord struct {
	Version uint32
	Phase   MigrationPhase
	Binding MigrationBinding
}

// MigrationRoots is a complete, fresh no-follow physical observation. Nil means
// confirmed absence only after Observe succeeds; denied or changing paths fail.
type MigrationRoots struct {
	Source      *MigrationObject
	Destination *MigrationObject
}

type MigrationJournal interface {
	// ReadMigration is read-only and returns the exact operation projection.
	// Errors/nil never mean no record. This adapter must not write or clear it.
	ReadMigration(context.Context, MigrationBinding) (*MigrationRecord, error)
}

type MigrationAdmission interface {
	// ReverifyMigration proves the already-held exclusion domain is current,
	// all root/profile-owning writers and helpers are confirmed stopped, and
	// accepted alpha byte/profile provenance matches the bound physical source
	// (or the same source object at destination during observation). A lock,
	// window closure or caller-supplied digest is insufficient. This capability
	// remains owned by Release beyond filesystem-handle Close or an unknown move.
	ReverifyMigration(context.Context, MigrationBinding, MigrationRoots) error
}

type MigrationMovement string

const (
	MigrationMoved    MigrationMovement = "moved"
	MigrationNoEffect MigrationMovement = "no-effect"
	MigrationUnknown  MigrationMovement = "unknown"
)

type MigrationMove struct {
	Movement MigrationMovement
	Code     string
	Roots    *MigrationRoots
}

type MigrationFileSystem interface {
	// Acquire pins both fixed, accepted roots with no-follow descriptors. Paths
	// come from the leased identity adapter's composition, not this request.
	// It consumes one already-held authoritative guard; it creates no lock or
	// journal engine. Only an exact Prepared projection can arm this handle.
	// A Dispatched/Relocated projection at acquisition permits observation only.
	Acquire(context.Context, MigrationBinding, MigrationJournal, MigrationAdmission) (MigrationLease, error)
}

type MigrationLease interface {
	Observe(context.Context) (*MigrationRoots, error)
	// MoveOnce revalidates the same binding, fixed paths, physical source and
	// admission, then requires Release's confirmed durable Dispatched record.
	// Release persists that intent BEFORE invoking this method. The handle must
	// have been armed at Prepared, and cannot make a second rename attempt.
	// Moved requires one same-volume no-replace rename, both parent fsyncs and
	// exact source-absent/destination-object readback. Any uncertainty remains
	// Unknown. No fallback copy, overwrite, recovery, launch or journal write.
	// Nil/errors after possible dispatch are Unknown; NoEffect requires explicit
	// proven refusal before a possible rename effect, never mere missing evidence.
	MoveOnce(context.Context) (*MigrationMove, error)
	// Close releases only this adapter's descriptors. It does not release the
	// admission capability, settle a durable intent or authorize profile startup.
	Close() error
}
