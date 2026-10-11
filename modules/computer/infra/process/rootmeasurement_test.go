package process

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// In-memory filesystem and retained-handle doubles only. No native IO, process,
// app service, provider, PID, signal, or real executable is used in these tests.
type measurementHandleDouble struct {
	path       string
	closes     int
	closeError error
	onClose    func()
}

func (p *measurementHandleDouble) Close() error {
	p.closes++
	if p.onClose != nil {
		p.onClose()
	}
	return p.closeError
}

type measurementDirectoryDouble struct {
	*measurementHandleDouble
	fs       *measurementFilesystemDouble
	identity authority.RootIdentity
}

func (p *measurementDirectoryDouble) inspect(path string) (directoryFacts, error) {
	if p.fs.inspectHook != nil {
		p.fs.inspectHook(path)
	}
	facts, ok := p.fs.directories[path]
	if path != p.path || !ok || facts.identity != p.identity {
		return directoryFacts{}, errors.New("named directory changed")
	}
	return facts, nil
}
func (p *measurementDirectoryDouble) openDirectory(relative string) (directoryPin, error) {
	if filepath.IsAbs(relative) || relative == ".." || !insidePolicy(p.path, filepath.Join(p.path, relative)) {
		return nil, errors.New("unanchored scope")
	}
	path := filepath.Join(p.path, relative)
	p.fs.anchored = append(p.fs.anchored, [2]string{p.path, relative})
	return p.fs.open(path)
}

type measurementFilesystemDouble struct {
	directories     map[string]directoryFacts
	handles         []*measurementHandleDouble
	images          []*measurementExecutableDouble
	absolute        []string
	anchored        [][2]string
	afterOpen       func(string)
	resolveHook     func(string)
	inspectHook     func(string)
	resolveError    string
	alias           string
	executableError string
	directoryError  string
}

func (f *measurementFilesystemDouble) effectiveUID() int { return 501 }
func (f *measurementFilesystemDouble) resolve(path string) (string, error) {
	if f.resolveHook != nil {
		f.resolveHook(path)
	}
	if path == f.resolveError {
		return "", errors.New("directory resolution failed")
	}
	if path == f.alias {
		return "/different/target", nil
	}
	return path, nil
}
func (f *measurementFilesystemDouble) open(path string) (directoryPin, error) {
	facts, ok := f.directories[path]
	if !ok {
		return nil, errors.New("missing directory")
	}
	handle := &measurementHandleDouble{path: path}
	f.handles = append(f.handles, handle)
	pin := &measurementDirectoryDouble{handle, f, facts.identity}
	if f.afterOpen != nil {
		f.afterOpen(path)
	}
	if path == f.directoryError {
		return pin, errors.New("partial directory measurement")
	}
	return pin, nil
}
func (f *measurementFilesystemDouble) openDirectory(path string) (directoryPin, error) {
	f.absolute = append(f.absolute, path)
	return f.open(path)
}
func (f *measurementFilesystemDouble) pinExecutable(_ context.Context, pin ExecutablePin) (executableMeasurement, error) {
	handle := &measurementHandleDouble{path: pin.Path}
	f.handles = append(f.handles, handle)
	image := &measurementExecutableDouble{measurementHandleDouble: handle}
	f.images = append(f.images, image)
	if pin.Path == f.executableError {
		return image, errors.New("partial executable measurement")
	}
	return image, nil
}
func (f *measurementFilesystemDouble) assertCloses(t *testing.T, want int) {
	t.Helper()
	if len(f.handles) == 0 {
		t.Fatal("no handles measured")
	}
	for _, h := range f.handles {
		if h.closes != want {
			t.Fatalf("%s closed %d times, want %d", h.path, h.closes, want)
		}
	}
}
func rootMeasurementFixture(t *testing.T) (*Seatbelt, Command, *confinedLaunch, *measurementFilesystemDouble) {
	t.Helper()
	s, c := rootScopedFixture(t)
	addRootScope(&s, "git-common", "/approved/git", authority.WriteAccess)
	addRootScope(&s, "toolchain", "/approved/tools", authority.ReadAccess)
	s.Snapshot.Participant.Grant.Workspaces[1].Root += "/common"
	s.Snapshot.Participant.Grant.Workspaces[2].Root += "/bin"
	selected, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	c, err = selected.bind(c)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := selectedLaunch(selected, c)
	if err != nil {
		t.Fatal(err)
	}
	fs := &measurementFilesystemDouble{directories: map[string]directoryFacts{}}
	put := func(path string, identity authority.RootIdentity) {
		fs.directories[path] = directoryFacts{identity, os.ModeDir | 0700, 501}
	}
	put(c.Root, c.RootIdentity)
	put(c.Cwd, authority.RootIdentity{Device: "1", Inode: "3"})
	put(launch.scratch, launch.scratchIdentity)
	for i, root := range launch.roots {
		put(root.ApprovedRoot, root.RootIdentity)
		if root.ScopeRoot != root.ApprovedRoot {
			put(root.ScopeRoot, authority.RootIdentity{Device: "1", Inode: string(rune('4' + i))})
		}
	}
	return selected, c, launch, fs
}

type measurementBootstrapDouble struct {
	calls  int
	before func()
}

func (b *measurementBootstrapDouble) StartAnchor(context.Context, AnchorLaunch, func(context.Context) error, io.Writer, io.Writer) (*exec.Cmd, AnchorLink, error) {
	b.calls++
	if b.before != nil {
		b.before()
	}
	// No exec method is invoked. A missing synthetic child stops this test route.
	return nil, nil, errors.New("synthetic bootstrap only")
}
func measureWithParentDouble(t *testing.T, selected *Seatbelt, command Command, fs *measurementFilesystemDouble, check func(context.Context) error, boot *measurementBootstrapDouble) error {
	t.Helper()
	clock := &testClock{time.UnixMilli(1900000000000)}
	parent := &parentBoundary{operationID: "operation", policy: selected, bootstrap: boot, execution: context.Background(), clock: clock,
		measure: func(ctx context.Context, c Command, l *confinedLaunch) (func(), error) {
			return measureLaunchFiles(ctx, c, l, fs)
		},
	}
	_, err := parent.StartLease(context.Background(), command, processsvc.SpawnRequest{Deadline: clock.Now().Add(15 * time.Second), Check: check}, io.Discard, io.Discard)
	return err
}

func TestRootMeasurementsAllBindingsHeldThroughOneDispatch(t *testing.T) {
	selected, c, launch, fs := rootMeasurementFixture(t)
	boot := &measurementBootstrapDouble{before: func() {
		fs.assertCloses(t, 0)
		if len(fs.handles) != len(launch.pins)+3+2*len(launch.roots) {
			t.Fatalf("lost measurement handles: %d", len(fs.handles))
		}
	}}
	err := measureWithParentDouble(t, selected, c, fs, func(context.Context) error { return nil }, boot)
	var failure *processsvc.NativeFailure
	if !errors.As(err, &failure) || !failure.Unknown || boot.calls != 1 {
		t.Fatal("synthetic dispatch not reached once", err)
	}
	fs.assertCloses(t, 1)
	expectedAbsolute := []string{c.Root, launch.scratch, c.Root, "/approved/git", "/approved/tools"}
	expectedAnchored := [][2]string{{c.Root, "project"}, {c.Root, "project"}, {"/approved/git", "common"}, {"/approved/tools", "bin"}}
	if !reflect.DeepEqual(fs.absolute, expectedAbsolute) || !reflect.DeepEqual(fs.anchored, expectedAnchored) {
		t.Fatalf("scope not opened through measured ancestor: %v %v", fs.absolute, fs.anchored)
	}
}

func TestRootMeasurementsMismatchClosesAllPinsAndNeverDispatches(t *testing.T) {
	for _, mode := range []string{"secondary-device", "secondary-inode", "last-secondary", "secondary-alias", "scope-alias", "scope-not-directory", "scope-partial-error", "late-root-replacement", "late-scope-replacement", "primary-identity", "cwd-alias", "scratch-identity", "scratch-mode", "scratch-owner", "executable-partial-error"} {
		t.Run(mode, func(t *testing.T) {
			selected, c, launch, fs := rootMeasurementFixture(t)
			change := func(path string, f func(*directoryFacts)) {
				facts := fs.directories[path]
				f(&facts)
				fs.directories[path] = facts
			}
			switch mode {
			case "secondary-device":
				change("/approved/git", func(f *directoryFacts) { f.identity.Device = "2" })
			case "secondary-inode":
				change("/approved/git", func(f *directoryFacts) { f.identity.Inode = "30" })
			case "last-secondary":
				change("/approved/tools", func(f *directoryFacts) { f.identity.Inode = "30" })
			case "secondary-alias":
				fs.alias = "/approved/git"
			case "scope-alias":
				fs.alias = "/approved/git/common"
			case "scope-not-directory":
				change("/approved/git/common", func(f *directoryFacts) { f.mode = 0600 })
			case "scope-partial-error":
				fs.directoryError = "/approved/git/common"
			case "late-root-replacement", "late-scope-replacement":
				fs.afterOpen = func(path string) {
					if path == "/approved/tools/bin" {
						target := "/approved/git"
						if mode == "late-scope-replacement" {
							target += "/common"
						}
						change(target, func(f *directoryFacts) { f.identity.Inode = "replaced" })
					}
				}
			case "primary-identity":
				change(c.Root, func(f *directoryFacts) { f.identity.Inode = "30" })
			case "cwd-alias":
				fs.alias = c.Cwd
			case "scratch-identity":
				change(launch.scratch, func(f *directoryFacts) { f.identity.Inode = "30" })
			case "scratch-mode":
				change(launch.scratch, func(f *directoryFacts) { f.mode = os.ModeDir | 0755 })
			case "scratch-owner":
				change(launch.scratch, func(f *directoryFacts) { f.uid = 502 })
			case "executable-partial-error":
				fs.executableError = launch.pins[1].Path
			}
			boot := &measurementBootstrapDouble{}
			err := measureWithParentDouble(t, selected, c, fs, func(context.Context) error { return nil }, boot)
			var failure *processsvc.NativeFailure
			if !errors.As(err, &failure) || failure.Unknown || boot.calls != 0 {
				t.Fatal("bad measurement reached dispatch or changed refusal", err)
			}
			fs.assertCloses(t, 1)
			if fs.handles[0].path != seatbeltExecutable {
				t.Fatal("mechanism pin not included")
			}
		})
	}
}

func TestRootMeasurementsLateSecondaryPolicyChangeNeverDispatches(t *testing.T) {
	selected, c, _, fs := rootMeasurementFixture(t)
	p, a := selected.selection.Snapshot.Participant.Clone(), selected.selection.Snapshot.Approval.Clone()
	current := selected.selection.Snapshot
	current.Participant, current.Approval = &p, &a
	checks := 0
	boot := &measurementBootstrapDouble{}
	fs.afterOpen = func(path string) {
		if path == "/approved/tools/bin" {
			a.Workspaces[2].RootIdentity.Inode = "late-policy"
		}
	}
	err := measureWithParentDouble(t, selected, c, fs, func(context.Context) error {
		checks++
		if !selected.matchesPolicy(c, current) {
			return errors.New("current secondary approval changed")
		}
		return nil
	}, boot)
	var failure *processsvc.NativeFailure
	if !errors.As(err, &failure) || failure.Unknown || boot.calls != 0 || checks != 2 {
		t.Fatal("late policy change dispatched", err, checks)
	}
	fs.assertCloses(t, 1)
}

// No image IO: the retained executable verifier is separately exercised with
// descriptor/metadata doubles in retainedmeasurement_test.go.
type measurementExecutableDouble struct {
	*measurementHandleDouble
	checks int
	fail   bool
	before func(context.Context)
}

func (p *measurementExecutableDouble) recheck(ctx context.Context) error {
	p.checks++
	if p.before != nil {
		p.before(ctx)
	}
	if ctx.Err() != nil || p.fail {
		return errors.New("changed executable measurement")
	}
	return nil
}
