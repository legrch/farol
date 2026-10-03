//go:build darwin

package migration

import (
	"context"
	"crypto/sha256"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	claim "github.com/legrch/farol/modules/release/app/services/migration"
	"github.com/legrch/farol/modules/release/domain/migration"
	releasestate "github.com/legrch/farol/modules/release/infra/native/state"
	"golang.org/x/sys/unix"
)

// These fixtures contain synthetic bytes only, never an owner browser profile.
func fixture(t *testing.T) (string, *filesystem, migration.Object) {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(parent, migration.AlphaDirectory), 0700); err != nil {
		t.Fatal(err)
	}
	f, err := openFilesystem(parent)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := f.close(); err != nil {
			t.Error(err)
		}
	})
	observed, err := f.observe()
	if err != nil {
		t.Fatal(err)
	}
	return parent, f, observed.source.object
}

func writeFixture(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

type node struct {
	mode   fs.FileMode
	object migration.Object
	digest [32]byte
	link   string
}

func contents(t *testing.T, root string) map[string]node {
	t.Helper()
	result := map[string]node{}
	err := filepath.WalkDir(root, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		var stat unix.Stat_t
		if err := unix.Lstat(path, &stat); err != nil {
			return err
		}
		info, err := item.Info()
		if err != nil {
			return err
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		value := node{mode: info.Mode(), object: object(&stat)}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value.digest = sha256.Sum256(data)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			value.link, err = os.Readlink(path)
			if err != nil {
				return err
			}
		}
		result[name] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func admit(physical) error { return nil }

func TestWholeRootPreservationAndDevSeparation(t *testing.T) {
	parent, f, expected := fixture(t)
	source := filepath.Join(parent, migration.AlphaDirectory)
	for name, data := range map[string]string{
		"farol-next-state/config.json":                       `{"retained":"configuration"}`,
		"farol-next-state/grants.json":                       `{"authority":"opaque"}`,
		"farol-next-state/tasks/unknown.json":                `{"phase":"outcome-unknown"}`,
		"farol-next-state/installed-updates/op/journal.json": `{"phase":"launch_requested"}`,
		"Partitions/farol-next-chatgpt/fixture-store":        "synthetic browser storage",
		"Partitions/farol-next-preview/fixture-store":        "separate localhost fixture",
		"future/unrecognized.bin":                            "unknown future bytes\x00\xff",
	} {
		writeFixture(t, source, name, data)
	}
	if err := os.Symlink("unrecognized.bin", filepath.Join(source, "future", "opaque-link")); err != nil {
		t.Fatal(err)
	}
	dev := filepath.Join(parent, "Farol Dev")
	writeFixture(t, dev, "retained", "independent Dev bytes")
	before, beforeDev := contents(t, source), contents(t, dev)
	observed, err := f.move(expected, admit)
	if err != nil {
		t.Fatalf("physical move: %v; possible=%v", err, possibleEffect(err))
	}
	if observed.source.present || observed.destination.object != expected {
		t.Fatalf("wrong readback: %+v", observed)
	}
	if _, err := os.Lstat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source remains: %v", err)
	}
	if after := contents(t, filepath.Join(parent, "Farol")); !reflect.DeepEqual(after, before) {
		t.Fatal("opaque bytes, file identity or modes changed")
	}
	if afterDev := contents(t, dev); !reflect.DeepEqual(afterDev, beforeDev) {
		t.Fatal("Dev state changed")
	}
}

func TestPhysicalCollisionRefusesWithoutRename(t *testing.T) {
	for _, kind := range []string{"directory", "file", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			parent, f, expected := fixture(t)
			path := filepath.Join(parent, "Farol")
			switch kind {
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "file":
				if err := os.WriteFile(path, []byte("foreign bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(migration.AlphaDirectory, path); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			f.rename = func(int, string, string) error { calls++; return nil }
			if _, err := f.move(expected, admit); err == nil || possibleEffect(err) {
				t.Fatalf("collision admitted: %v", err)
			}
			if calls != 0 {
				t.Fatal("rename called on collision")
			}
		})
	}
}

func TestPhysicalAdmissionRequiredAndReverified(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		_, f, expected := fixture(t)
		if _, err := f.move(expected, nil); err == nil || possibleEffect(err) {
			t.Fatalf("unadmitted move: %v", err)
		}
	})
	for _, state := range []migration.Writers{migration.Active, migration.Unknown} {
		t.Run(string(state), func(t *testing.T) {
			_, f, expected := fixture(t)
			code := migration.WriterActive
			if state == migration.Unknown {
				code = migration.WriterUnknown
			}
			if _, err := f.move(expected, func(physical) error { return code }); err != code {
				t.Fatalf("writer admitted: %v", err)
			}
		})
	}
	t.Run("changed-source", func(t *testing.T) {
		parent, f, expected := fixture(t)
		calls := 0
		f.rename = func(int, string, string) error { calls++; return nil }
		_, err := f.move(expected, func(physical) error {
			if err := os.Rename(filepath.Join(parent, migration.AlphaDirectory), filepath.Join(parent, "original")); err != nil {
				return err
			}
			return os.Mkdir(filepath.Join(parent, migration.AlphaDirectory), 0700)
		})
		if err != migration.BindingConflict || calls != 0 {
			t.Fatalf("changed source admitted: %v, calls=%d", err, calls)
		}
	})
}

func TestUnknownNativeOutcomeCannotRedispatch(t *testing.T) {
	for _, failure := range []string{"lost-rename-ack", "sync", "changed-readback"} {
		t.Run(failure, func(t *testing.T) {
			parent, f, expected := fixture(t)
			calls := 0
			f.rename = func(fd int, from, to string) error {
				calls++
				if err := renameExclusive(fd, from, to); err != nil {
					return err
				}
				if failure == "lost-rename-ack" {
					return unix.EIO
				}
				return nil
			}
			if failure == "sync" {
				f.sync = func(int) error { return unix.EIO }
			}
			if failure == "changed-readback" {
				f.sync = func(int) error {
					if err := os.Rename(filepath.Join(parent, "Farol"), filepath.Join(parent, "original")); err != nil {
						return err
					}
					return os.Mkdir(filepath.Join(parent, "Farol"), 0700)
				}
			}
			if _, err := f.move(expected, admit); !possibleEffect(err) {
				t.Fatalf("unknown became settled: %v", err)
			}
			if _, err := f.move(expected, admit); !possibleEffect(err) || calls != 1 {
				t.Fatalf("effect replayed: %v, calls=%d", err, calls)
			}
			if failure != "changed-readback" {
				observed, err := f.observe()
				if err != nil || observed.source.present || observed.destination.object != expected {
					t.Fatalf("lost physical evidence: %+v, %v", observed, err)
				}
			}
		})
	}
}

func TestConcurrentSameHandleDispatchAndClose(t *testing.T) {
	_, f, expected := fixture(t)
	var wg sync.WaitGroup
	errorsOut := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := f.move(expected, admit); errorsOut <- err }()
	}
	wg.Wait()
	close(errorsOut)
	settled, unknown := 0, 0
	for err := range errorsOut {
		if err == nil {
			settled++
		} else if possibleEffect(err) {
			unknown++
		} else {
			t.Fatalf("unexpected refusal: %v", err)
		}
	}
	if settled != 1 || unknown != 1 {
		t.Fatalf("dispatch count: settled=%d unknown=%d", settled, unknown)
	}
	if err := f.close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.observe(); err == nil {
		t.Fatal("closed handle observed")
	}
	if _, err := f.move(expected, admit); err == nil {
		t.Fatal("closed handle moved")
	}
}

// projectionFixture is a read-only port double. It does not implement a durable
// journal codec or claim real power-loss/retention acceptance.
type projectionFixture struct {
	mu     sync.Mutex
	record *port.MigrationRecord
	err    error
	reads  int
	change func(int)
}

func (j *projectionFixture) ReadMigration(context.Context, port.MigrationBinding) (*port.MigrationRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.reads++
	if j.change != nil {
		j.change(j.reads)
	}
	if j.record == nil {
		return nil, j.err
	}
	record := *j.record
	return &record, j.err
}

type guardFixture struct {
	mu      sync.Mutex
	binding port.MigrationBinding
	err     error
	calls   int
	check   func(port.MigrationRoots) error
}

func (a *guardFixture) ReverifyMigration(ctx context.Context, b port.MigrationBinding, r port.MigrationRoots) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	if err := ctx.Err(); err != nil {
		return err
	}
	if b != a.binding {
		return migration.BindingConflict
	}
	if a.err != nil {
		return a.err
	}
	if a.check != nil {
		return a.check(r)
	}
	return nil
}

// admissionFixture instruments acknowledgments around the actual retained
// Release Service. It has no claim ledger and constructs no additional owner.
// The injected guard is synthetic; it is not production writer/byte admission.
type admissionFixture struct {
	*guardFixture
	owner      *claim.Service
	claims     atomic.Int32
	afterClaim func(context.Context) error
}

func (a *admissionFixture) ReverifyMigration(ctx context.Context, b port.MigrationBinding, r port.MigrationRoots) error {
	return a.owner.ReverifyMigration(ctx, b, r)
}

func (a *admissionFixture) ClaimMigration(ctx context.Context, b port.MigrationBinding) error {
	a.claims.Add(1)
	if err := a.owner.ClaimMigration(ctx, b); err != nil {
		return err
	}
	if a.afterClaim != nil {
		return a.afterClaim(ctx)
	}
	return nil
}

func consumerFixture(t *testing.T) (string, *FileSystem, port.MigrationBinding, *projectionFixture, *admissionFixture) {
	t.Helper()
	parent, _, object := fixture(t)
	binding := port.MigrationBinding{Operation: "0123456789abcdef0123456789abcdef", AlphaBuild: "1111111111111111111111111111111111111111111111111111111111111111", Source: port.MigrationObject{Device: object.Device, File: object.File}}
	journal := &projectionFixture{record: &port.MigrationRecord{Version: 1, Phase: port.MigrationPrepared, Binding: binding}}
	guard := &guardFixture{binding: binding}
	owner, err := claim.New(binding, guard, releasestate.New())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	admission := &admissionFixture{guardFixture: guard, owner: owner}
	adapter, err := New(parent, migration.Production)
	if err != nil {
		t.Fatal(err)
	}
	return parent, adapter, binding, journal, admission
}

func acquired(t *testing.T, s *FileSystem, b port.MigrationBinding, j *projectionFixture, a *admissionFixture) *lease {
	t.Helper()
	owned, err := s.Acquire(context.Background(), b, j, a)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := owned.Close(); err != nil {
			t.Error(err)
		}
	})
	return owned.(*lease)
}

func TestConsumerRequiresDurableDispatchAndRetainsObservation(t *testing.T) {
	parent, s, b, j, a := consumerFixture(t)
	owned := acquired(t, s, b, j, a)
	// Simulate Release's confirmed projection, before the first native call.
	j.record.Phase = port.MigrationDispatched
	calls := 0
	owned.fs.rename = func(fd int, from, to string) error {
		calls++
		if j.record.Phase != port.MigrationDispatched {
			t.Fatal("rename preceded dispatch projection")
		}
		return renameExclusive(fd, from, to)
	}
	move, err := owned.MoveOnce(context.Background())
	if err != nil || move.Movement != port.MigrationMoved || move.Roots == nil || move.Roots.Destination == nil || *move.Roots.Destination != b.Source || calls != 1 {
		t.Fatalf("move: %+v, %v calls=%d", move, err, calls)
	}
	if j.record.Phase != port.MigrationDispatched {
		t.Fatal("filesystem rewrote Release journal")
	}
	if a.calls < 3 {
		t.Fatal("admission was not checked across acquisition/dispatch/readback")
	}
	again, err := owned.MoveOnce(context.Background())
	if err != nil || again.Movement != port.MigrationUnknown || calls != 1 {
		t.Fatalf("replayed: %+v, %v", again, err)
	}
	observed, err := owned.Observe(context.Background())
	if err != nil || observed.Source != nil || observed.Destination == nil || *observed.Destination != b.Source {
		t.Fatalf("readback: %+v %v", observed, err)
	}
	if err := owned.Close(); err != nil {
		t.Fatal(err)
	}
	if a.err != nil {
		t.Fatal("Close changed external admission")
	}
	if _, err := os.Stat(filepath.Join(parent, "Farol")); err != nil {
		t.Fatal(err)
	}
}

func TestConsumerNoPreparedProjectionCannotArm(t *testing.T) {
	for _, phase := range []port.MigrationPhase{port.MigrationDispatched, port.MigrationRelocated, port.MigrationCompleted} {
		t.Run(string(phase), func(t *testing.T) {
			parent, s, b, j, a := consumerFixture(t)
			j.record.Phase = phase
			if phase != port.MigrationDispatched {
				if err := os.Rename(filepath.Join(parent, migration.AlphaDirectory), filepath.Join(parent, "Farol")); err != nil {
					t.Fatal(err)
				}
			}
			owned := acquired(t, s, b, j, a)
			if a.claims.Load() != 0 {
				t.Fatal("observation-only acquisition consumed a claim")
			}
			calls := 0
			owned.fs.rename = func(int, string, string) error { calls++; return nil }
			response, err := owned.MoveOnce(context.Background())
			if err != nil || response.Movement != port.MigrationNoEffect || response.Code != "MIGRATION_OBSERVATION_ONLY" || calls != 0 {
				t.Fatalf("recovery dispatched: %+v %v", response, err)
			}
			if _, err := owned.Observe(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConsumerInterruptionsRetainSamePhysicalBinding(t *testing.T) {
	for _, moved := range []bool{false, true} {
		t.Run(map[bool]string{false: "source-remains", true: "root-moved"}[moved], func(t *testing.T) {
			_, s, b, j, a := consumerFixture(t)
			first := acquired(t, s, b, j, a)
			j.record.Phase = port.MigrationDispatched
			calls := 0
			first.fs.rename = func(fd int, from, to string) error {
				calls++
				if moved {
					if err := renameExclusive(fd, from, to); err != nil {
						return err
					}
				}
				return unix.EIO
			}
			result, err := first.MoveOnce(context.Background())
			if err != nil || result.Movement != port.MigrationUnknown {
				t.Fatalf("unknown lost: %+v %v", result, err)
			}
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}
			restarted, err := New(s.parent, migration.Production)
			if err != nil {
				t.Fatal(err)
			}
			recovered := acquired(t, restarted, b, j, a)
			// A fresh descriptor lifetime cannot re-arm retained Dispatched.
			recovered.fs.rename = func(int, string, string) error { calls++; return nil }
			observed, err := recovered.Observe(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			response, err := recovered.MoveOnce(context.Background())
			if err != nil || response.Movement != port.MigrationNoEffect || calls != 1 {
				t.Fatalf("interruption replayed: %+v %v calls=%d", response, err, calls)
			}
			expected := toDomain(b.Source)
			snapshot := migration.Snapshot{Profile: migration.Production, Operation: b.Operation, AlphaBuild: b.AlphaBuild, Record: migration.Record{Version: 1, Phase: migration.Dispatched, Operation: b.Operation, AlphaBuild: b.AlphaBuild, Source: expected}, Writers: migration.Closed, Exclusive: true}
			snapshot.Source = migration.Entry{State: migration.Missing}
			snapshot.Destination = migration.Entry{State: migration.Missing}
			action := migration.ObserveOnly
			if moved {
				snapshot.Destination = migration.Entry{State: migration.CurrentAlpha, Object: expected, AlphaBuild: b.AlphaBuild}
				action = migration.RecordRelocation
				if observed.Source != nil || observed.Destination == nil {
					t.Fatal("moved readback mismatch")
				}
			} else {
				snapshot.Source = migration.Entry{State: migration.CurrentAlpha, Object: expected, AlphaBuild: b.AlphaBuild}
				if observed.Source == nil || observed.Destination != nil {
					t.Fatal("source readback mismatch")
				}
			}
			decision, err := migration.Plan(snapshot)
			if err != nil || decision.Action != action {
				t.Fatalf("policy/readback conflict: %+v %v", decision, err)
			}
		})
	}
}

func TestConsumerRefusesUnconfirmedJournalAndProvenance(t *testing.T) {
	cases := []string{"nil-record", "unreadable", "version", "other-operation", "other-build", "other-object", "refused", "unknown-phase", "changed-projection", "unproven-bytes", "writer-active", "writer-unknown"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			_, s, b, j, a := consumerFixture(t)
			switch name {
			case "nil-record":
				j.record = nil
			case "unreadable":
				j.err = unix.EACCES
			case "version":
				j.record.Version = 2
			case "other-operation":
				j.record.Binding.Operation = "other-operation"
			case "other-build":
				j.record.Binding.AlphaBuild = "unaccepted-byte-binding"
			case "other-object":
				j.record.Binding.Source.File = "replacement"
			case "refused":
				j.record.Phase = port.MigrationRefused
			case "unknown-phase":
				j.record.Phase = "new-phase"
			case "changed-projection":
				j.change = func(n int) {
					if n == 2 {
						j.record.Phase = port.MigrationDispatched
					}
				}
			case "unproven-bytes":
				a.err = migration.SourceUnproven
			case "writer-active":
				a.err = migration.WriterActive
			case "writer-unknown":
				a.err = migration.WriterUnknown
			}
			owned, err := s.Acquire(context.Background(), b, j, a)
			if err == nil || owned != nil {
				if owned != nil {
					_ = owned.Close()
				}
				t.Fatalf("unproven source armed: %v", err)
			}
		})
	}
}

func TestConsumerPreEffectAndPostEffectAdmissionFailuresDiffer(t *testing.T) {
	for _, when := range []string{"before-dispatch", "after-move", "no-durable-dispatch", "cancelled"} {
		t.Run(when, func(t *testing.T) {
			_, s, b, j, a := consumerFixture(t)
			owned := acquired(t, s, b, j, a)
			j.record.Phase = port.MigrationDispatched
			ctx := context.Background()
			if when == "before-dispatch" {
				a.err = migration.WriterUnknown
			}
			if when == "after-move" {
				a.check = func(r port.MigrationRoots) error {
					if r.Destination != nil {
						return migration.WriterUnknown
					}
					return nil
				}
			}
			if when == "no-durable-dispatch" {
				j.record.Phase = port.MigrationPrepared
			}
			if when == "cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			calls := 0
			owned.fs.rename = func(fd int, from, to string) error { calls++; return renameExclusive(fd, from, to) }
			result, err := owned.MoveOnce(ctx)
			movement, wantCalls := port.MigrationNoEffect, 0
			if when == "after-move" {
				movement, wantCalls = port.MigrationUnknown, 1
			}
			if err != nil || result.Movement != movement || calls != wantCalls {
				t.Fatalf("wrong certainty: %+v %v calls=%d", result, err, calls)
			}
		})
	}
}

func TestConsumerOneLeasePerAdapterAndDevRefusal(t *testing.T) {
	_, s, b, j, a := consumerFixture(t)
	first := acquired(t, s, b, j, a)
	if second, err := s.Acquire(context.Background(), b, j, a); err == nil || second != nil {
		t.Fatal("two prepared handles armed")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if second, err := s.Acquire(context.Background(), b, j, a); err == nil || second != nil {
		t.Fatal("Close created a new dispatch lifetime")
	}
	if dev, err := New("/does/not/exist", migration.Development); dev != nil || err == nil {
		t.Fatal("Dev touched a production root")
	}
	if invalid, err := New("/does/not/exist", migration.Profile("preview")); invalid != nil || err != migration.InvalidProfile {
		t.Fatal("unsupported profile selected")
	}
}

func TestConsumerPostMoveJournalLossAndRootChangeStayUnknown(t *testing.T) {
	for _, fault := range []string{"journal-unreadable", "journal-crossed", "root-changed", "cancelled"} {
		t.Run(fault, func(t *testing.T) {
			parent, s, b, j, a := consumerFixture(t)
			owned := acquired(t, s, b, j, a)
			j.record.Phase = port.MigrationDispatched
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.check = func(roots port.MigrationRoots) error {
				if roots.Destination == nil {
					return nil
				}
				switch fault {
				case "journal-unreadable":
					j.err = unix.EACCES
				case "journal-crossed":
					j.record.Binding.Operation = "other-operation"
				case "root-changed":
					if err := os.Rename(filepath.Join(parent, "Farol"), filepath.Join(parent, "original")); err != nil {
						return err
					}
					return os.Mkdir(filepath.Join(parent, "Farol"), 0700)
				case "cancelled":
					cancel()
				}
				return nil
			}
			result, err := owned.MoveOnce(ctx)
			if err != nil || result.Movement != port.MigrationUnknown {
				t.Fatalf("post-effect fault became settled: %+v %v", result, err)
			}
			again, err := owned.MoveOnce(context.Background())
			if err != nil || again.Movement != port.MigrationUnknown {
				t.Fatalf("post-effect replay permitted: %+v %v", again, err)
			}
		})
	}
}

func TestCancellationInsideFinalJournalReadCannotReturnMoved(t *testing.T) {
	_, s, b, j, a := consumerFixture(t)
	owned := acquired(t, s, b, j, a)
	j.record.Phase = port.MigrationDispatched
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finalRead := j.reads + 3
	j.change = func(read int) {
		if read == finalRead {
			cancel()
		}
	}
	result, err := owned.MoveOnce(ctx)
	if err != nil || result.Movement != port.MigrationUnknown {
		t.Fatalf("cancellation during final read accepted: %+v %v", result, err)
	}
	if j.reads != finalRead {
		t.Fatalf("missing intended fault boundary: reads=%d", j.reads)
	}
}

func TestTwoFactoriesCannotArmAndRedispatchSameOperation(t *testing.T) {
	_, firstAdapter, b, j, a := consumerFixture(t)
	first := acquired(t, firstAdapter, b, j, a)
	secondAdapter, err := New(firstAdapter.parent, migration.Production)
	if err != nil {
		t.Fatal(err)
	}
	second, secondErr := secondAdapter.Acquire(context.Background(), b, j, a)
	if secondErr != nil && second != nil {
		_ = second.Close()
		t.Fatal("failed acquisition returned dispatch capability")
	}
	if second != nil {
		defer second.Close()
	}
	j.record.Phase = port.MigrationDispatched
	calls := 0
	first.fs.rename = func(int, string, string) error { calls++; return unix.EIO }
	unknown, err := first.MoveOnce(context.Background())
	if err != nil || unknown.Movement != port.MigrationUnknown {
		t.Fatalf("first native ambiguity: %+v %v", unknown, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if second != nil {
		second.(*lease).fs.rename = func(int, string, string) error { calls++; return unix.EIO }
		_, _ = second.MoveOnce(context.Background())
	}
	if calls != 1 || secondErr == nil {
		t.Fatalf("same admitted operation armed twice: attempts=%d second-error=%v", calls, secondErr)
	}
	// Once the authoritative journal retains Dispatched, a fresh factory may
	// observe the original root but must not create another dispatch capability.
	thirdAdapter, err := New(firstAdapter.parent, migration.Production)
	if err != nil {
		t.Fatal(err)
	}
	third := acquired(t, thirdAdapter, b, j, a)
	third.fs.rename = func(int, string, string) error { calls++; return unix.EIO }
	observed, err := third.Observe(context.Background())
	if err != nil || observed.Source == nil || *observed.Source != b.Source {
		t.Fatalf("unknown source observation: %+v %v", observed, err)
	}
	result, err := third.MoveOnce(context.Background())
	if err != nil || result.Movement != port.MigrationNoEffect || calls != 1 {
		t.Fatalf("retained dispatch rearmed: %+v %v attempts=%d", result, err, calls)
	}
}

func TestCloseBeforeDispatchCannotArmAnotherFactory(t *testing.T) {
	_, s, b, j, a := consumerFixture(t)
	first := acquired(t, s, b, j, a)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := New(s.parent, migration.Production)
	if err != nil {
		t.Fatal(err)
	}
	owned, err := second.Acquire(context.Background(), b, j, a)
	if owned != nil {
		_ = owned.Close()
	}
	if err == nil || owned != nil {
		t.Fatal("descriptor closure released the operation-wide arm")
	}
	if j.record.Phase != port.MigrationPrepared {
		t.Fatal("filesystem changed Release's durable projection")
	}
}

func TestConcurrentFactoriesCannotBothArm(t *testing.T) {
	_, first, b, j, a := consumerFixture(t)
	second, err := New(first.parent, migration.Production)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		owned port.MigrationLease
		err   error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for _, adapter := range []*FileSystem{first, second} {
		go func(s *FileSystem) {
			<-start
			owned, err := s.Acquire(context.Background(), b, j, a)
			results <- result{owned: owned, err: err}
		}(adapter)
	}
	close(start)
	armed := []*lease{}
	for range 2 {
		r := <-results
		if r.err == nil && r.owned != nil {
			owned := r.owned
			t.Cleanup(func() { _ = owned.Close() })
			armed = append(armed, owned.(*lease))
		} else if r.owned != nil {
			_ = r.owned.Close()
			t.Error("failed acquisition retained a lease")
		}
	}
	j.record.Phase = port.MigrationDispatched
	attempts := 0
	for _, owned := range armed {
		owned.fs.rename = func(int, string, string) error { attempts++; return unix.EIO }
		result, err := owned.MoveOnce(context.Background())
		if err != nil || result.Movement != port.MigrationUnknown {
			t.Errorf("first admitted dispatch: %+v %v", result, err)
		}
	}
	if len(armed) != 1 || attempts != 1 {
		t.Fatalf("concurrent factories: armed=%d native-attempts=%d", len(armed), attempts)
	}
}

func TestLostClaimAcknowledgmentCannotRearm(t *testing.T) {
	for _, fault := range []string{"lost-ack", "cancelled-ack"} {
		t.Run(fault, func(t *testing.T) {
			parent, s, b, j, a := consumerFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.afterClaim = func(context.Context) error {
				if fault == "cancelled-ack" {
					cancel()
					return nil
				}
				return unix.EIO
			}
			owned, err := s.Acquire(ctx, b, j, a)
			if owned != nil {
				_ = owned.Close()
			}
			if err == nil || owned != nil || a.claims.Load() != 1 {
				t.Fatalf("unconfirmed claim armed: lease=%v err=%v calls=%d", owned, err, a.claims.Load())
			}
			// The factory is spent before the invoked claim's response, even if
			// cancellation/error arrives after Release retained the real claim.
			if retry, err := s.Acquire(context.Background(), b, j, a); err == nil || retry != nil || a.claims.Load() != 1 {
				if retry != nil {
					_ = retry.Close()
				}
				t.Fatal("same factory re-invoked an unconfirmed claim")
			}
			if err := a.owner.ClaimMigration(context.Background(), b); !errors.Is(err, claim.ClaimConsumed) {
				t.Fatalf("actual Release owner lost claim: %v", err)
			}
			other, err := New(parent, migration.Production)
			if err != nil {
				t.Fatal(err)
			}
			if retry, err := other.Acquire(context.Background(), b, j, a); err == nil || retry != nil {
				if retry != nil {
					_ = retry.Close()
				}
				t.Fatal("another factory rearmed a spent actual Release owner")
			}
			if j.record.Phase != port.MigrationPrepared {
				t.Fatal("claim wrote durable dispatch")
			}
			if _, err := os.Stat(filepath.Join(parent, migration.AlphaDirectory)); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(parent, "Farol")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("claim relocated a root: %v", err)
			}
		})
	}
}

func TestChangedProofAfterClaimCannotArm(t *testing.T) {
	for _, fault := range []string{"source-replaced", "journal-changed", "guard-lost"} {
		t.Run(fault, func(t *testing.T) {
			parent, s, b, j, a := consumerFixture(t)
			a.afterClaim = func(context.Context) error {
				switch fault {
				case "source-replaced":
					if err := os.Rename(filepath.Join(parent, migration.AlphaDirectory), filepath.Join(parent, "preserved-original")); err != nil {
						return err
					}
					return os.Mkdir(filepath.Join(parent, migration.AlphaDirectory), 0700)
				case "journal-changed":
					j.record.Phase = port.MigrationDispatched
				case "guard-lost":
					a.err = migration.WriterUnknown
				}
				return nil
			}
			owned, err := s.Acquire(context.Background(), b, j, a)
			if owned != nil {
				_ = owned.Close()
			}
			if err == nil || owned != nil {
				t.Fatalf("proof changed across claim: lease=%v err=%v", owned, err)
			}
			if err := a.owner.ClaimMigration(context.Background(), b); !errors.Is(err, claim.ClaimConsumed) {
				t.Fatalf("failed acquisition released claim: %v", err)
			}
			if a.claims.Load() != 1 {
				t.Fatal("claim dispatched more than once")
			}
			if _, err := os.Stat(filepath.Join(parent, "Farol")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("unarmed acquisition moved a root: %v", err)
			}
		})
	}
}

func TestCancellationInsideObservationGuardDoesNotConfirmRoots(t *testing.T) {
	_, s, b, j, a := consumerFixture(t)
	j.record.Phase = port.MigrationDispatched
	owned := acquired(t, s, b, j, a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.check = func(port.MigrationRoots) error { cancel(); return nil }
	roots, err := owned.Observe(ctx)
	if err == nil || roots != nil {
		t.Fatalf("cancelled observation confirmed: %+v %v", roots, err)
	}
	if a.claims.Load() != 0 {
		t.Fatal("observation consumed an arm")
	}
}

func TestUnknownOutcomeSurvivesDescriptorClose(t *testing.T) {
	for _, moved := range []bool{false, true} {
		name := map[bool]string{false: "source-remains", true: "rename-ack-lost"}[moved]
		t.Run("primitive/"+name, func(t *testing.T) {
			_, f, expected := fixture(t)
			calls := 0
			f.rename = func(fd int, from, to string) error {
				calls++
				if moved {
					if err := renameExclusive(fd, from, to); err != nil {
						return err
					}
				}
				return unix.EIO
			}
			if _, err := f.move(expected, admit); !possibleEffect(err) {
				t.Fatalf("missing initial uncertainty: %v", err)
			}
			if err := f.close(); err != nil {
				t.Fatal(err)
			}
			if _, err := f.move(expected, admit); !possibleEffect(err) || calls != 1 {
				t.Fatalf("Close erased native uncertainty: %v attempts=%d", err, calls)
			}
		})
		t.Run("consumer/"+name, func(t *testing.T) {
			_, s, b, j, a := consumerFixture(t)
			owned := acquired(t, s, b, j, a)
			j.record.Phase = port.MigrationDispatched
			calls := 0
			owned.fs.rename = func(fd int, from, to string) error {
				calls++
				if moved {
					if err := renameExclusive(fd, from, to); err != nil {
						return err
					}
				}
				return unix.EIO
			}
			unknown, err := owned.MoveOnce(context.Background())
			if err != nil || unknown.Movement != port.MigrationUnknown {
				t.Fatalf("missing initial uncertainty: %+v %v", unknown, err)
			}
			if err := owned.Close(); err != nil {
				t.Fatal(err)
			}
			result, err := owned.MoveOnce(context.Background())
			if err != nil || result.Movement != port.MigrationUnknown || calls != 1 {
				t.Fatalf("Close erased retained dispatch: %+v %v attempts=%d", result, err, calls)
			}
			if j.record.Phase != port.MigrationDispatched {
				t.Fatal("Close settled unknown durable intent")
			}
		})
	}
}
