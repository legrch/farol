//go:build darwin

// Package migration implements physical profile relocation. Durable journal,
// accepted byte provenance and complete writer admission belong to Release.
package migration

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/domain/migration"
)

type physical struct {
	source      entry
	destination entry
}

type entry struct {
	present bool
	object  migration.Object
}

// physicalError distinguishes pre-effect refusal from a possibly effective
// native call. It never carries a retry instruction or private profile path.
type physicalError struct {
	code     string
	possible bool
}

func (e *physicalError) Error() string { return e.code }

func refusal(code string) error { return &physicalError{code: code} }
func uncertain() error {
	return &physicalError{code: "MIGRATION_NATIVE_OUTCOME_UNKNOWN", possible: true}
}

// filesystem is a private primitive, not a journal or updater engine. The
// Release adapter must arm only a fresh prepared operation and hold its sole
// admission guard through dispatch, directory sync and readback.
type filesystem struct {
	mu        sync.Mutex
	root      *directory
	closed    bool
	attempted bool
	rename    func(int, string, string) error
	sync      func(int) error
}

func openFilesystem(parent string) (*filesystem, error) {
	root, err := openDirectory(parent)
	if err != nil {
		return nil, err
	}
	return &filesystem{root: root, rename: renameExclusive, sync: syncDirectory}, nil
}

func (f *filesystem) close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil
	}
	f.closed = true
	return f.root.close()
}

func (f *filesystem) observe() (physical, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return physical{}, refusal("MIGRATION_HANDLE_CLOSED")
	}
	return f.read()
}

func (f *filesystem) read() (physical, error) {
	if err := f.root.verify(); err != nil {
		return physical{}, err
	}
	source, err := f.root.inspect(migration.AlphaDirectory)
	if err != nil {
		return physical{}, err
	}
	destination, err := f.root.inspect("io.github.legrch.farol")
	if err != nil {
		return physical{}, err
	}
	return physical{source: source, destination: destination}, nil
}

func (f *filesystem) before(expected migration.Object) (physical, error) {
	observed, err := f.read()
	if err != nil {
		return physical{}, err
	}
	if observed.destination.present {
		return physical{}, migration.DestinationCollision
	}
	if !observed.source.present || observed.source.object != expected {
		return physical{}, migration.BindingConflict
	}
	if observed.source.object.Device != f.root.object.Device {
		return physical{}, refusal("MIGRATION_VOLUME_MISMATCH")
	}
	return observed, nil
}

// move issues at most one native rename for this handle. admission must freshly
// validate Release's durable Dispatched binding, accepted source bytes and all
// stopped writers under the shared guard. No admission implementation exists in
// this primitive. An admission error is pre-effect; any native-call error or
// later uncertainty is outcome-unknown, even when readback finds the old root.
func (f *filesystem) move(expected migration.Object, admission func(physical) error) (physical, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Descriptor cleanup does not erase a previously possible native effect.
	if f.attempted {
		return physical{}, uncertain()
	}
	if f.closed {
		return physical{}, refusal("MIGRATION_HANDLE_CLOSED")
	}
	f.attempted = true
	observed, err := f.before(expected)
	if err != nil {
		return physical{}, err
	}
	if admission == nil {
		return physical{}, refusal("MIGRATION_ADMISSION_REQUIRED")
	}
	if err := admission(observed); err != nil {
		return physical{}, err
	}
	// Recheck after caller-controlled journal/admission I/O, before the syscall.
	if _, err := f.before(expected); err != nil {
		return physical{}, err
	}
	source, err := f.root.openChild(migration.AlphaDirectory, expected)
	if err != nil {
		return physical{}, err
	}
	defer source.close()
	if _, err := f.before(expected); err != nil {
		return physical{}, err
	}
	if err := f.rename(f.root.fd, migration.AlphaDirectory, "io.github.legrch.farol"); err != nil {
		return physical{}, uncertain()
	}
	if err := f.sync(f.root.fd); err != nil {
		return physical{}, uncertain()
	}
	observed, err = f.read()
	if err != nil || observed.source.present || !observed.destination.present || observed.destination.object != expected {
		return physical{}, uncertain()
	}
	if err := source.verifyObject(expected); err != nil {
		return physical{}, uncertain()
	}
	return observed, nil
}

func possibleEffect(err error) bool {
	var failure *physicalError
	return errors.As(err, &failure) && failure.possible
}

// FileSystem implements Release's consuming port without owning durable records
// or writer exclusion. Composition supplies one fixed protected parent.
type FileSystem struct {
	mu       sync.Mutex
	parent   string
	acquired bool
}

var _ port.MigrationFileSystem = (*FileSystem)(nil)
var _ port.MigrationLease = (*lease)(nil)

// New refuses development before touching a production path. The caller uses
// the pure Dev policy separately; this adapter handles one production migration.
func New(parent string, profile migration.Profile) (*FileSystem, error) {
	if profile == migration.Development {
		return nil, refusal("MIGRATION_DEV_NOT_APPLICABLE")
	}
	if profile != migration.Production {
		return nil, migration.InvalidProfile
	}
	return &FileSystem{parent: parent}, nil
}

type lease struct {
	mu        sync.Mutex
	fs        *filesystem
	binding   port.MigrationBinding
	journal   port.MigrationJournal
	admission port.MigrationAdmission
	armed     bool
	attempted bool
	closed    bool
}

func token(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool { return r < 0x21 || r > 0x7e }) < 0
}

func validBinding(b port.MigrationBinding) bool {
	return token(b.Operation) && token(b.AlphaBuild) && token(b.Source.Device) && token(b.Source.File)
}

func toDomain(o port.MigrationObject) migration.Object {
	return migration.Object{Device: o.Device, File: o.File}
}

func toPort(p physical) port.MigrationRoots {
	result := port.MigrationRoots{}
	if p.source.present {
		result.Source = &port.MigrationObject{Device: p.source.object.Device, File: p.source.object.File}
	}
	if p.destination.present {
		result.Destination = &port.MigrationObject{Device: p.destination.object.Device, File: p.destination.object.File}
	}
	return result
}

func boundRoots(p physical, b port.MigrationBinding) error {
	if p.source.present && p.destination.present {
		return migration.DestinationCollision
	}
	expected := toDomain(b.Source)
	if (p.source.present && p.source.object == expected) || (p.destination.present && p.destination.object == expected) {
		return nil
	}
	return migration.BindingConflict
}

func readProjection(ctx context.Context, j port.MigrationJournal, b port.MigrationBinding) (*port.MigrationRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, refusal("MIGRATION_CANCELLED")
	}
	record, err := j.ReadMigration(ctx, b)
	if ctx.Err() != nil {
		return nil, refusal("MIGRATION_CANCELLED")
	}
	if err != nil || record == nil {
		return nil, refusal("MIGRATION_JOURNAL_UNCONFIRMED")
	}
	// Copy external values; a caller cannot mutate the projected record behind
	// this handle after it has been validated.
	observed := *record
	if observed.Version != 1 {
		return nil, migration.RecordInvalid
	}
	if observed.Binding != b {
		return nil, migration.BindingConflict
	}
	switch observed.Phase {
	case port.MigrationPrepared, port.MigrationDispatched, port.MigrationRelocated, port.MigrationCompleted:
		return &observed, nil
	case port.MigrationRefused:
		return nil, migration.RecordRefused
	default:
		return nil, migration.RecordInvalid
	}
}

func (s *FileSystem) Acquire(ctx context.Context, b port.MigrationBinding, j port.MigrationJournal, a port.MigrationAdmission) (port.MigrationLease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acquired {
		return nil, refusal("MIGRATION_ADAPTER_ALREADY_ACQUIRED")
	}
	if !validBinding(b) || j == nil || a == nil {
		return nil, migration.RecordInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, refusal("MIGRATION_CANCELLED")
	}
	f, err := openFilesystem(s.parent)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (port.MigrationLease, error) { _ = f.close(); return nil, err }
	observed, err := f.observe()
	if err != nil {
		return fail(err)
	}
	if err := boundRoots(observed, b); err != nil {
		return fail(err)
	}
	record, err := readProjection(ctx, j, b)
	if err != nil {
		return fail(err)
	}
	if err := a.ReverifyMigration(ctx, b, toPort(observed)); err != nil {
		return fail(err)
	}
	verified, err := f.observe()
	if err != nil {
		return fail(err)
	}
	if verified != observed {
		return fail(migration.BindingConflict)
	}
	current, err := readProjection(ctx, j, b)
	if err != nil {
		return fail(err)
	}
	if *current != *record {
		return fail(migration.BindingConflict)
	}
	armed := record.Phase == port.MigrationPrepared
	if armed && (!observed.source.present || observed.destination.present) {
		return fail(migration.BindingConflict)
	}
	if (record.Phase == port.MigrationRelocated || record.Phase == port.MigrationCompleted) && (observed.source.present || !observed.destination.present) {
		return fail(migration.RelocationLost)
	}
	// Consume this factory before invoking the external claim. A lost or failed
	// acknowledgment must not let this factory invoke ClaimMigration again.
	// The sole Release owner, shared across factories, owns the operation-wide
	// claim; this adapter owns no replay ledger and never releases that claim.
	s.acquired = true
	if armed {
		if err := a.ClaimMigration(ctx, b); err != nil {
			return fail(refusal("MIGRATION_CLAIM_UNCONFIRMED"))
		}
		if ctx.Err() != nil {
			return fail(refusal("MIGRATION_CANCELLED"))
		}
		if err := a.ReverifyMigration(ctx, b, toPort(observed)); err != nil {
			return fail(err)
		}
		// Claim is external I/O, not evidence that the physical/journal binding
		// remained unchanged. Re-read both before issuing an armed handle.
		after, err := f.observe()
		if err != nil {
			return fail(err)
		}
		if after != observed {
			return fail(migration.BindingConflict)
		}
		confirmed, err := readProjection(ctx, j, b)
		if err != nil {
			return fail(err)
		}
		if *confirmed != *record {
			return fail(migration.BindingConflict)
		}
	}
	return &lease{fs: f, binding: b, journal: j, admission: a, armed: armed}, nil
}

func (l *lease) Observe(ctx context.Context) (*port.MigrationRoots, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil, refusal("MIGRATION_HANDLE_CLOSED")
	}
	if err := ctx.Err(); err != nil {
		return nil, refusal("MIGRATION_CANCELLED")
	}
	observed, err := l.fs.observe()
	if err != nil {
		return nil, err
	}
	if err := boundRoots(observed, l.binding); err != nil {
		return nil, err
	}
	if err := l.admission.ReverifyMigration(ctx, l.binding, toPort(observed)); err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, refusal("MIGRATION_CANCELLED")
	}
	verified, err := l.fs.observe()
	if err != nil || verified != observed {
		return nil, refusal("MIGRATION_OBSERVATION_CHANGED")
	}
	if ctx.Err() != nil {
		return nil, refusal("MIGRATION_CANCELLED")
	}
	roots := toPort(verified)
	return &roots, nil
}

func (l *lease) MoveOnce(ctx context.Context) (*port.MigrationMove, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	// Keep the retained dispatch uncertainty after Close. Only a never-used
	// closed handle can prove refusal before any possible native dispatch.
	if l.attempted {
		return &port.MigrationMove{Movement: port.MigrationUnknown, Code: "MIGRATION_DISPATCH_ALREADY_ATTEMPTED"}, nil
	}
	if l.closed {
		return &port.MigrationMove{Movement: port.MigrationNoEffect, Code: "MIGRATION_HANDLE_CLOSED"}, nil
	}
	l.attempted = true
	if !l.armed {
		return &port.MigrationMove{Movement: port.MigrationNoEffect, Code: "MIGRATION_OBSERVATION_ONLY"}, nil
	}
	observed, err := l.fs.move(toDomain(l.binding.Source), func(p physical) error {
		record, err := readProjection(ctx, l.journal, l.binding)
		if err != nil {
			return err
		}
		if record.Phase != port.MigrationDispatched {
			return refusal("MIGRATION_DISPATCH_NOT_DURABLE")
		}
		if err := l.admission.ReverifyMigration(ctx, l.binding, toPort(p)); err != nil {
			return err
		}
		confirmed, err := readProjection(ctx, l.journal, l.binding)
		if err != nil {
			return err
		}
		if *confirmed != *record {
			return migration.BindingConflict
		}
		if err := ctx.Err(); err != nil {
			return refusal("MIGRATION_CANCELLED")
		}
		return nil
	})
	if err != nil {
		movement := port.MigrationNoEffect
		code := "MIGRATION_PREFLIGHT_REFUSED"
		if possibleEffect(err) {
			movement = port.MigrationUnknown
			code = "MIGRATION_NATIVE_OUTCOME_UNKNOWN"
		}
		var physicalFailure *physicalError
		var domainFailure migration.Code
		if errors.As(err, &physicalFailure) {
			code = physicalFailure.code
		}
		if errors.As(err, &domainFailure) {
			code = string(domainFailure)
		}
		return &port.MigrationMove{Movement: movement, Code: code}, nil
	}
	roots := toPort(observed)
	// Loss of admission/cancellation after the rename is still unknown. The
	// native readback alone does not prove exclusion remained valid.
	if err := l.admission.ReverifyMigration(ctx, l.binding, roots); err != nil || ctx.Err() != nil {
		return &port.MigrationMove{Movement: port.MigrationUnknown, Code: "MIGRATION_POST_MOVE_ADMISSION_UNKNOWN"}, nil
	}
	record, err := readProjection(ctx, l.journal, l.binding)
	if err != nil || record.Phase != port.MigrationDispatched {
		return &port.MigrationMove{Movement: port.MigrationUnknown, Code: "MIGRATION_POST_MOVE_JOURNAL_UNKNOWN"}, nil
	}
	verified, err := l.fs.observe()
	if err != nil || verified != observed {
		return &port.MigrationMove{Movement: port.MigrationUnknown, Code: "MIGRATION_POST_MOVE_READBACK_UNKNOWN"}, nil
	}
	if ctx.Err() != nil {
		return &port.MigrationMove{Movement: port.MigrationUnknown, Code: "MIGRATION_POST_MOVE_CANCELLED"}, nil
	}
	return &port.MigrationMove{Movement: port.MigrationMoved, Roots: &roots}, nil
}

func (l *lease) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	// The authoritative admission capability is Release-owned and remains held.
	return l.fs.close()
}
