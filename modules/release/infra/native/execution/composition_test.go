package execution

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"github.com/legrch/farol/modules/release/infra/repos/journal"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"golang.org/x/sys/unix"
)

// Composition coverage uses the actual journal repository and disposable native
// filesystem objects. Route, admission and lease authority remain symbolic; no
// live installed helper, accepted request/profile/package, startup permission,
// OS sleep, process exit or installation is established.
type compositionOwner struct {
	gate                      sync.Mutex
	request                   port.HelperRequest
	directory                 port.JournalDirectory
	unknown                   error
	verified, journalRetained int
	runtimeRetained           int
	verify                    func(context.Context) error
}

func (o *compositionOwner) JournalGate() port.StateGate { return &o.gate }

// Journal callbacks already run under this owner's borrowed gate.
func (o *compositionOwner) ReverifyJournal(ctx context.Context, op release.Operation, dir port.JournalDirectory) error {
	o.verified++
	if op != operation(o.request) || dir != o.directory || o.unknown != nil {
		return errors.New("symbolic journal ownership mismatch")
	}
	if o.verify != nil {
		return o.verify(ctx)
	}
	return ctx.Err()
}
func (o *compositionOwner) JournalUnknown(op release.Operation) bool {
	return op != operation(o.request) || o.unknown != nil
}
func (o *compositionOwner) RetainJournalUnknown(op release.Operation) {
	if op != operation(o.request) {
		panic("crossed symbolic operation owner")
	}
	o.journalRetained++
	o.unknown = errors.Join(o.unknown, port.JournalUnknown)
}
func (o *compositionOwner) reverify(ctx context.Context, request port.HelperRequest) error {
	o.gate.Lock()
	defer o.gate.Unlock()
	if !reflect.DeepEqual(request, o.request) || o.unknown != nil {
		return errors.New("symbolic runtime ownership mismatch")
	}
	return ctx.Err()
}
func (o *compositionOwner) retained() error {
	o.gate.Lock()
	defer o.gate.Unlock()
	return o.unknown
}
func (o *compositionOwner) retain(err error) {
	o.gate.Lock()
	defer o.gate.Unlock()
	o.runtimeRetained++
	o.unknown = errors.Join(o.unknown, err)
}

type compositionFixture struct {
	root, path string
	owner      *compositionOwner
	repo       *journal.Repo
	config     Config
}

func compositionIdentity(t *testing.T, file *os.File) helperroutes.Identity {
	t.Helper()
	var state unix.Stat_t
	raw, err := file.SyscallConn()
	must(t, err)
	must(t, raw.Control(func(fd uintptr) { err = unix.Fstat(int(fd), &state) }))
	must(t, err)
	id := snapshot(entryState{present: true, stat: state}).Identity
	return helperroutes.Identity{Device: id.Device, Inode: id.Inode}
}

func newCompositionFixture(t *testing.T) *compositionFixture {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	must(t, os.Chmod(root, 0700))
	request := port.HelperRequest{OperationID: strings.Repeat("e", 32),
		Source: port.HelperBuild{Digest: strings.Repeat("a", 64), Version: "1.2.3-preview.4", BuildID: strings.Repeat("b", 64)},
		Target: port.HelperBuild{Digest: strings.Repeat("c", 64), Version: "1.2.4-preview.4", BuildID: strings.Repeat("d", 64)}}
	parent := filepath.Join(root, "operations")
	path := filepath.Join(parent, request.OperationID)
	apps := filepath.Join(root, "Applications")
	for _, dir := range []string{parent, path, apps} {
		must(t, os.Mkdir(dir, 0700))
	}
	open := func(path string) *os.File {
		file, err := os.Open(path)
		must(t, err)
		t.Cleanup(func() { must(t, file.Close()) })
		return file
	}
	app, op, anchor := open(apps), open(path), open(parent)
	ai, oi, pi := compositionIdentity(t, app), compositionIdentity(t, op), compositionIdentity(t, anchor)
	owner := &compositionOwner{request: request, directory: port.JournalDirectory{
		Device: oi.Device, Inode: oi.Inode, ParentDevice: pi.Device, ParentInode: pi.Inode}}
	f := &compositionFixture{root: root, path: path, owner: owner}
	f.repo = f.open(t)
	f.config = Config{Request: request, Files: helperroutes.Files{
		Applications: app, ApplicationsIdentity: ai, Operation: op, OperationIdentity: oi},
		Journal: f.repo, Until: time.Now().Add(time.Minute), Reverify: owner.reverify,
		Unknown: owner.retained, RetainUnknown: owner.retain}
	return f
}

func (f *compositionFixture) open(t *testing.T) *journal.Repo {
	t.Helper()
	r, err := journal.New(context.Background(), f.path, operation(f.owner.request), f.owner)
	must(t, err)
	t.Cleanup(func() { must(t, r.Close()) })
	return r
}
func (f *compositionFixture) with(ctx context.Context, fn func(port.HelperRecoveryRuntime) error) error {
	// This private route seam grants only symbolic authority to disposable files.
	return with(ctx, f.config, func(ctx context.Context) error { return ctx.Err() }, fn)
}
func (f *compositionFixture) record(phase string) records.Journal {
	r := f.owner.request
	build := func(b port.HelperBuild) records.Build {
		return records.Build{Digest: b.Digest, Version: b.Version, BuildID: b.BuildID}
	}
	return records.Journal{Schema: "farol.installed-update-journal/1", Operation: records.Operation{
		ID: r.OperationID, Source: build(r.Source), Target: build(r.Target)}, Phase: phase}
}
func (f *compositionFixture) encoded(t *testing.T, phase string) []byte {
	t.Helper()
	data, err := records.EncodeJournal(f.record(phase))
	must(t, err)
	return data
}
func (f *compositionFixture) put(t *testing.T, data []byte) {
	t.Helper()
	must(t, os.WriteFile(filepath.Join(f.path, "journal.json"), data, 0600))
}
func (f *compositionFixture) physical(t *testing.T, repo *journal.Repo, phase string) *port.JournalView {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.path, "journal.json"))
	must(t, err)
	decoded, err := records.DecodeJournal(data, f.record(phase).Operation)
	must(t, err)
	if decoded.Domain() != f.record(phase).Domain() {
		t.Fatal("physical decoded phase or operation differs")
	}
	view, err := repo.Read(context.Background())
	must(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	helper, err := repo.ReadHelper(ctx)
	must(t, err)
	value := decoded.Domain()
	if view == nil || view.Value == nil || *view.Value != value || len(view.Revision) != 64 || !reflect.DeepEqual(view, helper) {
		t.Fatal("generic/helper physical value or revision differs")
	}
	// A phase/revision readback supplies no missing recovery observation.
	if release.Assess(release.Observation{Operation: value.Operation, Journal: &value}).Kind != release.Unresolved {
		t.Fatal("journal readback invented recovery acceptance")
	}
	return view
}
func (f *compositionFixture) borrowed(t *testing.T) {
	t.Helper()
	for _, file := range []*os.File{f.config.Files.Applications, f.config.Files.Operation} {
		_, err := file.Stat()
		must(t, err)
	}
}

type compositionObject struct {
	stat unix.Stat_t
	data []byte
}

func compositionSnapshot(t *testing.T, root string) map[string]compositionObject {
	t.Helper()
	objects := make(map[string]compositionObject)
	must(t, filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		var object compositionObject
		if err := unix.Lstat(path, &object.stat); err != nil {
			return err
		}
		if !entry.IsDir() {
			object.data, err = os.ReadFile(path)
			if err != nil {
				return err
			}
		}
		objects[path] = object
		return nil
	}))
	return objects
}
func (f *compositionFixture) unchanged(t *testing.T, before map[string]compositionObject) {
	t.Helper()
	after := compositionSnapshot(t, f.root)
	if len(before) != len(after) {
		t.Fatal("namespace changed, including temporary journal entries")
	}
	for path, old := range before {
		now, ok := after[path]
		if !ok || !sameMetadata(old.stat, now.stat) || !bytes.Equal(old.data, now.data) {
			t.Fatalf("bytes or mutation-sensitive metadata changed: %s", path)
		}
	}
	f.borrowed(t)
}

func TestCompositionJournalReadAndCAS(t *testing.T) {
	f := newCompositionFixture(t)
	f.put(t, f.encoded(t, "prepared"))
	before := f.physical(t, f.repo, "prepared")
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		phase, err := r.ReadPhase(context.Background())
		must(t, err)
		if phase != "prepared" {
			t.Fatal("encoded phase not read")
		}
		must(t, r.WritePhase(context.Background(), "predecessor_saved"))
		phase, err = r.ReadPhase(context.Background())
		must(t, err)
		if phase != "predecessor_saved" {
			t.Fatal("persisted phase not read back by same runtime")
		}
		return nil
	}))
	after := f.physical(t, f.repo, "predecessor_saved")
	if after.Revision == before.Revision || f.owner.verified != 3 || f.owner.retained() != nil {
		t.Fatal("CAS did not advance the same bound journal under its owner")
	}
	view, err := f.repo.CompareAndSwap(context.Background(), before.Revision, f.record("prepared").Domain())
	if view != nil || !errors.Is(err, port.JournalConflict) {
		t.Fatal("old physical revision remained a usable CAS witness")
	}
	data, err := os.ReadFile(filepath.Join(f.path, "journal.json"))
	must(t, err)
	if !bytes.Equal(data, f.encoded(t, "predecessor_saved")) {
		t.Fatal("runtime CAS persisted unexpected physical bytes")
	}
	f.borrowed(t)
}

func TestCompositionMoveAndJournalShareOwner(t *testing.T) {
	f := newCompositionFixture(t)
	f.put(t, f.encoded(t, "prepared"))
	stage := filepath.Join(f.path, "staged.app")
	must(t, os.Mkdir(stage, 0700))
	must(t, os.WriteFile(filepath.Join(stage, "marker"), []byte("disposable tree"), 0600))
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		phase, err := r.ReadPhase(context.Background())
		must(t, err)
		if phase != "prepared" {
			t.Fatal("unexpected initial phase")
		}
		before, err := r.Entries(context.Background())
		must(t, err)
		if before.App.Present || !before.Staged.Directory || !before.Staged.OwnedByEffectiveUser {
			t.Fatal("unexpected native fixed entries")
		}
		must(t, r.Rename(context.Background(), port.Staged, port.App, before.Staged.Identity))
		after, err := r.Entries(context.Background())
		must(t, err)
		if after.Staged.Present || !after.App.Directory || after.App.Identity != before.Staged.Identity {
			t.Fatal("native move readback lost the staged identity")
		}
		// This composes two ports; application phase-transition policy is not exercised.
		return r.WritePhase(context.Background(), "new_installed")
	}))
	f.physical(t, f.repo, "new_installed")
	data, err := os.ReadFile(filepath.Join(f.config.Files.Applications.Name(), "Farol.app", "marker"))
	must(t, err)
	if string(data) != "disposable tree" || f.owner.retained() != nil {
		t.Fatal("move/journal composition changed contents or retained uncertainty")
	}
	f.borrowed(t)
}

func TestCompositionJournalBoundsAndRefusals(t *testing.T) {
	for _, kind := range []string{"8192", "8193", "invalid", "crossed", "opaque-closed", "absent"} {
		t.Run(kind, func(t *testing.T) {
			f := newCompositionFixture(t)
			data := f.encoded(t, "prepared")
			code, internal := "journal_invalid", false
			var cause error
			switch kind {
			case "8192", "8193":
				size := 8192
				if kind == "8193" {
					size++
					cause = records.Oversized
				}
				data = append(data, bytes.Repeat([]byte(" "), size-len(data))...)
			case "invalid":
				data, cause = []byte("{invalid journal"), records.Invalid
			case "crossed":
				crossed := f.record("prepared")
				crossed.ID = strings.Repeat("f", 32)
				var err error
				data, err = records.EncodeJournal(crossed)
				must(t, err)
				code, cause = "journal_mismatch", records.BindingMismatch
			case "opaque-closed":
				must(t, f.repo.Close())
				code, internal, cause = "internal", true, port.JournalClosed
			}
			if kind != "absent" {
				f.put(t, data)
			}
			before := compositionSnapshot(t, f.root)
			err := f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
				phase, err := r.ReadPhase(context.Background())
				if kind == "8192" {
					if err != nil || phase != "prepared" {
						t.Fatalf("exact physical helper limit: phase=%q err=%v", phase, err)
					}
				} else if phase != "" {
					t.Fatal("refused read returned a partial phase")
				}
				return err
			})
			if kind == "8192" {
				must(t, err)
			} else {
				classified(t, err, code, false)
				var failure *port.HelperRecoveryFailure
				if !errors.As(err, &failure) || failure.Internal != internal || cause != nil && !errors.Is(err, cause) {
					t.Fatal("real repository refusal lost classification or provenance", err)
				}
			}
			if kind == "8192" || kind == "8193" {
				view, err := f.repo.Read(context.Background())
				must(t, err)
				if view == nil || view.Value == nil || *view.Value != f.record("prepared").Domain() {
					t.Fatal("helper limit changed ordinary read semantics")
				}
			}
			if f.owner.retained() != nil || f.owner.verified != 1 {
				t.Fatal("read changed symbolic admission or retained uncertainty")
			}
			f.unchanged(t, before)
		})
	}
}

func TestCompositionAdmissionRefusalRetainsOneOwner(t *testing.T) {
	f := newCompositionFixture(t)
	f.put(t, f.encoded(t, "prepared"))
	alias := f.open(t)
	before := compositionSnapshot(t, f.root)
	err := f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		_, err := r.ReadPhase(context.Background())
		must(t, err)
		f.owner.verify = func(context.Context) error { return errors.New("symbolic admission refused") }
		return r.WritePhase(context.Background(), "predecessor_saved")
	})
	classified(t, err, "internal", true)
	if !errors.Is(err, port.JournalUnproven) || f.owner.journalRetained != 1 || f.owner.runtimeRetained != 1 || f.owner.retained() == nil {
		t.Fatal("repository/runtime did not retain the same owner's refusal")
	}
	checks := f.owner.verified
	f.physical(t, alias, "prepared")
	must(t, f.repo.Close())
	f.config.Journal = alias
	called := false
	err = f.with(context.Background(), func(port.HelperRecoveryRuntime) error { called = true; return nil })
	classified(t, err, "recovery_attempt_unknown", true)
	if called {
		t.Fatal("another runtime entered after shared owner refusal")
	}
	f.physical(t, alias, "prepared")
	must(t, alias.Close())
	again, err := journal.New(context.Background(), f.path, operation(f.owner.request), f.owner)
	if again != nil {
		must(t, again.Close())
		t.Fatal("new repository cleared retained owner refusal")
	}
	if !errors.Is(err, port.JournalUnknown) || f.owner.verified != checks || f.owner.journalRetained != 1 || f.owner.retained() == nil {
		t.Fatal("readback, Close or another adapter rearmed admission")
	}
	f.unchanged(t, before)
}

func TestCompositionOriginalDeadlineBeforeJournalCreate(t *testing.T) {
	f := newCompositionFixture(t)
	f.put(t, f.encoded(t, "prepared"))
	before := compositionSnapshot(t, f.root)
	until := time.Now().Add(200 * time.Millisecond)
	ctx := laggingContext{Context: context.Background(), until: until}
	admitted := false
	err := f.with(ctx, func(r port.HelperRecoveryRuntime) error {
		_, err := r.ReadPhase(context.Background())
		must(t, err)
		f.owner.verify = func(c context.Context) error {
			bound, ok := c.Deadline()
			if !ok || !bound.Equal(until) {
				t.Fatal("fresh method context replaced the captured original deadline")
			}
			admitted = true
			time.Sleep(time.Until(until) + time.Millisecond)
			// Return normally so the real CAS path must check expiry before create.
			return nil
		}
		return r.WritePhase(context.Background(), "predecessor_saved")
	})
	classified(t, err, "internal", true)
	if !admitted || !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, port.JournalCancelled) || ctx.Err() != nil {
		t.Fatal("late native CAS returned success or lost its original bound", err)
	}
	if f.owner.journalRetained != 0 || f.owner.runtimeRetained != 1 || f.owner.retained() == nil {
		t.Fatal("runtime failed to retain its expired write attempt")
	}
	f.unchanged(t, before)
	f.physical(t, f.repo, "prepared")
}
