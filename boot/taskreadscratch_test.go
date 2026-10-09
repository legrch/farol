package boot

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// These are deterministic in-memory ports: no files, native descriptors,
// application, provider, clock, or scratch allocation by the host OS.
type taskScratchEntry struct {
	parent int
	name   string
}
type taskScratchDouble struct {
	meta           map[int]profileMetadata
	entries        map[taskScratchEntry]int
	parents        map[int]int
	paths          map[int]string
	opened, closed []int
	calls          []string
	fail           string
	onCall         func(string)
	closeErrors    map[int]bool
	nonempty       bool
	childName      string
}

func newTaskScratchDouble() *taskScratchDouble {
	m := func(inode uint64, uid, mode uint32) profileMetadata {
		return profileMetadata{device: 7, inode: inode, uid: uid, mode: profileDirectoryType | mode}
	}
	return &taskScratchDouble{
		meta:    map[int]profileMetadata{0: m(1, 0, 0755), 1: m(2, 0, 0755), 2: m(3, 501, 0700)},
		entries: map[taskScratchEntry]int{{0, "app"}: 1, {1, "tmp"}: 2},
		parents: map[int]int{1: 0, 2: 1}, paths: map[int]string{0: "/", 1: "/app", 2: "/app/tmp"},
		closeErrors: map[int]bool{}, childName: "farol-codex-read-" + strings.Repeat("a", 32),
	}
}
func (d *taskScratchDouble) call(op string) error {
	d.calls = append(d.calls, op)
	if d.onCall != nil {
		d.onCall(op)
	}
	if d.fail == op {
		return errors.New("CPU injected failure")
	}
	return nil
}
func (*taskScratchDouble) uid() uint32 { return 501 }
func (d *taskScratchDouble) openRoot() (int, error) {
	if err := d.call("openRoot"); err != nil {
		return -1, err
	}
	d.opened = append(d.opened, 0)
	return 0, nil
}
func (d *taskScratchDouble) openDirectory(p int, n string) (int, error) {
	op := "openParent"
	if p == 2 {
		op = "openChild"
	}
	if err := d.call(op); err != nil {
		return -1, err
	}
	fd, ok := d.entries[taskScratchEntry{p, n}]
	if !ok {
		return -1, errors.New("CPU absent")
	}
	d.opened = append(d.opened, fd)
	return fd, nil
}
func (d *taskScratchDouble) stat(fd int) (profileMetadata, error) {
	err := d.call("stat")
	return d.meta[fd], err
}
func (d *taskScratchDouble) statRoot() (profileMetadata, error) {
	err := d.call("statRoot")
	return d.meta[0], err
}
func (d *taskScratchDouble) statEntry(p int, n string) (profileMetadata, error) {
	if err := d.call("statEntry"); err != nil {
		return profileMetadata{}, err
	}
	var fd int
	var ok bool
	if n == ".." {
		fd, ok = d.parents[p]
	} else {
		fd, ok = d.entries[taskScratchEntry{p, n}]
	}
	if !ok {
		return profileMetadata{}, errors.New("CPU absent")
	}
	return d.meta[fd], nil
}
func (d *taskScratchDouble) physicalPath(fd int) (string, error) {
	err := d.call("physical")
	return d.paths[fd], err
}
func (d *taskScratchDouble) close(fd int) error {
	d.closed = append(d.closed, fd)
	if err := d.call("close"); err != nil {
		return err
	}
	if d.closeErrors[fd] {
		return errors.New("CPU unknown close")
	}
	return nil
}
func (d *taskScratchDouble) name() (string, error) { err := d.call("name"); return d.childName, err }
func (d *taskScratchDouble) mkdir(p int, n string) error {
	if err := d.call("mkdir"); err != nil {
		return err
	}
	key := taskScratchEntry{p, n}
	if _, ok := d.entries[key]; ok {
		return errors.New("CPU collision; never adopt")
	}
	d.meta[3] = profileMetadata{device: 7, inode: 4, uid: 501, mode: profileDirectoryType | 0700}
	d.entries[key] = 3
	d.parents[3] = p
	d.paths[3] = d.paths[p] + "/" + n
	return nil
}
func (d *taskScratchDouble) empty(fd int) error {
	if err := d.call("empty"); err != nil {
		return err
	}
	if fd != 3 {
		return errors.New("CPU wrong pin")
	}
	if d.nonempty {
		return taskScratchFailure(TaskReadScratchNonEmpty)
	}
	return nil
}

func requireTaskScratchCode(t *testing.T, err error, code TaskReadScratchCode) {
	t.Helper()
	if !errors.Is(err, code) {
		t.Fatalf("expected %s, got %v", code, err)
	}
	var f *TaskReadScratchFailure
	if !errors.As(err, &f) || f.Retry() != "never" {
		t.Fatalf("missing nonretryable classification: %v", err)
	}
}
func taskScratchJoined() TaskReadScratchJoined {
	return TaskReadScratchJoined{OriginalClientExit: true, ReadHandlersDrained: true}
}
func requireTaskScratchCloses(t *testing.T, d *taskScratchDouble) {
	t.Helper()
	want := append([]int(nil), d.opened...)
	for i, j := 0, len(want)-1; i < j; i, j = i+1, j-1 {
		want[i], want[j] = want[j], want[i]
	}
	if !reflect.DeepEqual(want, d.closed) {
		t.Fatalf("original closes: %v, want %v", d.closed, want)
	}
}

func TestTaskReadScratchCPUOneLifetimeRetention(t *testing.T) {
	d := newTaskScratchDouble()
	q := newTaskReadScratch("/app/tmp", d)
	if len(d.calls) != 0 {
		t.Fatal("construction performed I/O")
	}
	root, err := q.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if root != (TaskReadScratchRoot{Path: d.paths[3], Device: 7, Inode: 4, OwnerUID: 501, Mode: 0700}) {
		t.Fatalf("unexpected qualified root: %+v", root)
	}
	copyOwner := *q
	again, err := copyOwner.Open(context.Background())
	if err != nil || again != root {
		t.Fatal("original reopen", again, err)
	}
	if !reflect.DeepEqual(d.opened, []int{0, 1, 2, 3}) {
		t.Fatal("replacement open", d.opened)
	}
	count := 0
	for _, call := range d.calls {
		if call == "mkdir" {
			count++
		}
	}
	if count != 1 {
		t.Fatal("allocation count", count)
	}
	retained, err := q.Close(context.Background(), taskScratchJoined())
	if err != nil {
		t.Fatal(err)
	}
	if retained.Child != root || retained.Parent.Path != "/app/tmp" || retained.Parent.Inode != 3 || !retained.Created || !retained.Attempted || !retained.Qualified || !retained.Released || retained.Observation != "" {
		t.Fatalf("retention: %+v", retained)
	}
	requireTaskScratchCloses(t, d)
	calls := len(d.calls)
	r2, e2 := copyOwner.Close(context.Background(), TaskReadScratchJoined{})
	if r2 != retained || e2 != err || len(d.calls) != calls {
		t.Fatal("close retried or changed")
	}
	zero, e := q.Open(context.Background())
	requireTaskScratchCode(t, e, TaskReadScratchClosed)
	if zero != (TaskReadScratchRoot{}) {
		t.Fatal("closed path disclosed")
	}
	if _, ok := d.entries[taskScratchEntry{2, d.childName}]; !ok {
		t.Fatal("successful artifact lost")
	}
}

func TestTaskReadScratchCPUInvalidInputSticky(t *testing.T) {
	for _, path := range []string{"", "/", "relative", "/app/../tmp", "/app/tmp/", "/app/\x00tmp"} {
		t.Run(path, func(t *testing.T) {
			d := newTaskScratchDouble()
			q := newTaskReadScratch(path, d)
			_, err := q.Open(context.Background())
			requireTaskScratchCode(t, err, TaskReadScratchInvalid)
			_, e := q.Open(context.Background())
			if e != err || len(d.calls) != 0 {
				t.Fatal("invalid input retried")
			}
			r, e := q.Close(context.Background(), taskScratchJoined())
			requireTaskScratchCode(t, e, TaskReadScratchInvalid)
			if !r.Released || r.Created {
				t.Fatal(r)
			}
		})
	}
	q := newTaskReadScratch("/app/tmp", nil)
	_, err := q.Open(context.Background())
	requireTaskScratchCode(t, err, TaskReadScratchUnsupported)
}

func TestTaskReadScratchCPUAllocationFailuresSticky(t *testing.T) {
	for _, phase := range []string{"openRoot", "openParent", "stat", "statRoot", "statEntry", "physical", "name", "mkdir", "openChild", "empty"} {
		t.Run(phase, func(t *testing.T) {
			d := newTaskScratchDouble()
			d.fail = phase
			q := newTaskReadScratch("/app/tmp", d)
			root, err := q.Open(context.Background())
			requireTaskScratchCode(t, err, TaskReadScratchUnavailable)
			if root != (TaskReadScratchRoot{}) {
				t.Fatal("failed allocation disclosed path")
			}
			calls := len(d.calls)
			d.fail = ""
			_, e := q.Open(context.Background())
			if e != err || len(d.calls) != calls {
				t.Fatal("failure retried")
			}
			r, e := q.Close(context.Background(), taskScratchJoined())
			requireTaskScratchCode(t, e, TaskReadScratchUnavailable)
			if !r.Released {
				t.Fatal(r)
			}
			requireTaskScratchCloses(t, d)
			if (phase == "openChild" || phase == "empty") && (!r.Created || r.Child.Path == "") {
				t.Fatal("lost failed/unknown artifact", r)
			}
		})
	}
}

func TestTaskReadScratchCPURefusesParentAndChild(t *testing.T) {
	for _, kind := range []string{"parent-owner", "parent-shared", "symlink", "parent-inode", "physical-alias", "child-mode", "child-owner", "child-device", "name", "collision"} {
		t.Run(kind, func(t *testing.T) {
			d := newTaskScratchDouble()
			switch kind {
			case "parent-owner":
				m := d.meta[2]
				m.uid = 502
				d.meta[2] = m
			case "parent-shared":
				m := d.meta[2]
				m.mode |= 0020
				d.meta[2] = m
			case "symlink":
				m := d.meta[2]
				m.mode = 0120777
				d.meta[2] = m
			case "parent-inode":
				m := d.meta[2]
				m.inode = 0
				d.meta[2] = m
			case "physical-alias":
				d.paths[2] = "/APP/tmp"
			case "name":
				d.childName = "../elsewhere"
			case "collision":
				d.entries[taskScratchEntry{2, d.childName}] = 4
			default:
				d.onCall = func(op string) {
					if op == "openChild" {
						m := d.meta[3]
						switch kind {
						case "child-mode":
							m.mode |= 0040
						case "child-owner":
							m.uid = 502
						case "child-device":
							m.device = 8
						}
						d.meta[3] = m
					}
				}
			}
			q := newTaskReadScratch("/app/tmp", d)
			root, err := q.Open(context.Background())
			if err == nil || root != (TaskReadScratchRoot{}) {
				t.Fatal("unqualified path returned", root, err)
			}
			calls := len(d.calls)
			_, e := q.Open(context.Background())
			if e != err || len(d.calls) != calls {
				t.Fatal("refusal retried")
			}
			_, _ = q.Close(context.Background(), taskScratchJoined())
			requireTaskScratchCloses(t, d)
			if kind == "collision" && d.entries[taskScratchEntry{2, d.childName}] != 4 {
				t.Fatal("preexisting child adopted")
			}
		})
	}
}

func TestTaskReadScratchCPUChangedOrNonemptyRetained(t *testing.T) {
	for _, kind := range []string{"named-child", "named-parent", "physical", "up", "metadata", "nonempty", "unknown", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			d := newTaskScratchDouble()
			q := newTaskReadScratch("/app/tmp", d)
			root, err := q.Open(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			code := TaskReadScratchChanged
			switch kind {
			case "named-child":
				d.meta[4] = d.meta[3]
				m := d.meta[4]
				m.inode = 40
				d.meta[4] = m
				d.entries[taskScratchEntry{2, d.childName}] = 4
			case "named-parent":
				d.meta[4] = d.meta[2]
				m := d.meta[4]
				m.inode = 40
				d.meta[4] = m
				d.entries[taskScratchEntry{1, "tmp"}] = 4
			case "physical":
				d.paths[3] = "/elsewhere"
			case "up":
				d.parents[3] = 1
			case "metadata":
				m := d.meta[3]
				m.mode |= 0040
				d.meta[3] = m
			case "nonempty":
				d.nonempty = true
				code = TaskReadScratchNonEmpty
			case "unknown":
				d.fail = "empty"
				code = TaskReadScratchUnavailable
			case "cancel":
				cancel()
				code = TaskReadScratchUnavailable
			}
			r, err := q.Close(ctx, taskScratchJoined())
			requireTaskScratchCode(t, err, code)
			if r.Child != root || !r.Released || r.Observation != code {
				t.Fatal("original identity lost", r)
			}
			requireTaskScratchCloses(t, d)
		})
	}
}

func TestTaskReadScratchCPUScanBoundaryChanges(t *testing.T) {
	for _, kind := range []string{"rename", "cancel", "nonempty"} {
		t.Run(kind, func(t *testing.T) {
			d := newTaskScratchDouble()
			q := newTaskReadScratch("/app/tmp", d)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			d.onCall = func(op string) {
				if op == "empty" {
					switch kind {
					case "rename":
						d.paths[3] = "/changed"
					case "cancel":
						cancel()
					case "nonempty":
						d.nonempty = true
					}
				}
			}
			root, err := q.Open(ctx)
			if err == nil || root != (TaskReadScratchRoot{}) {
				t.Fatal("scan boundary accepted")
			}
			_, _ = q.Close(context.Background(), taskScratchJoined())
			requireTaskScratchCloses(t, d)
		})
	}
}

func TestTaskReadScratchCPUCloseUnknownAndMissingJoin(t *testing.T) {
	for _, joins := range []TaskReadScratchJoined{{}, {OriginalClientExit: true}, {ReadHandlersDrained: true}} {
		d := newTaskScratchDouble()
		q := newTaskReadScratch("/app/tmp", d)
		_, err := q.Open(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		r, e := q.Close(context.Background(), joins)
		requireTaskScratchCode(t, e, TaskReadScratchJoinMissing)
		if r.Released || len(d.closed) != 0 {
			t.Fatal("unjoined pins closed")
		}
		calls := len(d.calls)
		r2, e2 := q.Close(context.Background(), taskScratchJoined())
		if r2 != r || e2 != e || len(d.calls) != calls {
			t.Fatal("terminal refusal upgraded")
		}
	}
	d := newTaskScratchDouble()
	q := newTaskReadScratch("/app/tmp", d)
	_, err := q.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	d.nonempty = true
	d.closeErrors[3] = true
	d.closeErrors[1] = true
	r, e := q.Close(context.Background(), taskScratchJoined())
	requireTaskScratchCode(t, e, TaskReadScratchCloseUnknown)
	requireTaskScratchCode(t, e, TaskReadScratchNonEmpty)
	var unknown *TaskReadScratchFailure
	if !errors.As(e, &unknown) || !unknown.OutcomeUnknown() {
		t.Fatal("unknown descriptor release hidden by inspection failure", e)
	}
	if r.Released || r.Observation != TaskReadScratchNonEmpty {
		t.Fatal(r)
	}
	requireTaskScratchCloses(t, d)
	closed := append([]int(nil), d.closed...)
	_, _ = q.Close(context.Background(), taskScratchJoined())
	if !reflect.DeepEqual(closed, d.closed) {
		t.Fatal("unknown close retried")
	}
}

func TestTaskReadScratchCPUCancellationAllocationAndConcurrentOwner(t *testing.T) {
	for _, phase := range []string{"initial", "mkdir", "openChild"} {
		t.Run(phase, func(t *testing.T) {
			d := newTaskScratchDouble()
			q := newTaskReadScratch("/app/tmp", d)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if phase == "initial" {
				cancel()
			} else {
				d.onCall = func(op string) {
					if op == phase {
						cancel()
					}
				}
			}
			root, err := q.Open(ctx)
			if err == nil || root != (TaskReadScratchRoot{}) {
				t.Fatal("cancelled allocation accepted")
			}
			calls := len(d.calls)
			_, e := q.Open(context.Background())
			if e != err || len(d.calls) != calls {
				t.Fatal("cancelled attempt retried")
			}
			_, _ = q.Close(context.Background(), taskScratchJoined())
			requireTaskScratchCloses(t, d)
		})
	}
	d := newTaskScratchDouble()
	q := newTaskReadScratch("/app/tmp", d)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := q.Open(context.Background()); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := q.Close(context.Background(), taskScratchJoined()); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if !reflect.DeepEqual(d.opened, []int{0, 1, 2, 3}) {
		t.Fatal("concurrent allocation", d.opened)
	}
	requireTaskScratchCloses(t, d)
}
