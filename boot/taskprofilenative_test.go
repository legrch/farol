//go:build darwin

package boot

// Authoring target (Lead-owned exclusive native lane):
// First compile ./boot with go test -c into a fresh private output (no test runs).
// Then run that frozen binary from boot with -test.run '^TestNativeTaskProfileStorageQualification$'
// -test.count=1 -test.v -test.timeout=45s -ingress-native.
// Compilation is a separate bounded phase; native execution plus its original
// child-exit observation has an outer <=60s budget. No app build output is used.
// A hard timeout cannot promise cleanup: retain the
// logged fresh roots and classify unfinished cleanup UNKNOWN, without retry.
// This qualifies local Darwin profile/journal composition only. Chat identity,
// authority and its browser are CPU fixtures; no Chat/Task turn, provider call,
// process, schema, T0, exposure, installed profile or power-loss proof is supplied.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
	"golang.org/x/sys/unix"
)

// Do not reuse retirementStorageFixture: it opens unrelated native owners and
// its root cleanup does not independently observe this Task journal's namespace.
// Every root here is newly allocated. No quarantined path or operation is used.
type taskProfileNativeFixture struct {
	root       string
	binding    ProfileBinding
	qualified  *QualifiedProfile
	chat       *chatComputerFixture
	profiles   []*taskProfileNativeOwner
	ancestors  map[string]os.FileInfo
	known      map[string]taskProfileNativeEntry
	deleteSafe bool
}

type taskProfileNativeOwner struct {
	profile        *TaskProfile
	closeAttempted bool
}

type taskProfileNativeEntry struct {
	device, inode uint64
	uid, mode     uint32
	data          string
}

func newTaskProfileNativeFixture(t *testing.T) *taskProfileNativeFixture {
	t.Helper()
	if !*ingressNative {
		t.Skip("Requires exclusive Lead native lane and -ingress-native")
	}
	parent, err := filepath.Abs(filepath.Join("..", "_output", "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	// Go runs this package from boot. Keep the repository path, never adopt
	// a resolved _output/tmp redirect, and create only individual checked children.
	repository := filepath.Dir(filepath.Dir(parent))
	ancestors := make(map[string]os.FileInfo)
	for _, path := range []string{repository, filepath.Join(repository, "_output"), parent} {
		if path != repository {
			if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal("native parent creation refused; no retry", err)
				}
			} else if err != nil {
				t.Fatal("native parent observation unavailable", err)
			}
		}
		ancestors[path] = taskProfileNativeDirectory(t, path)
	}
	root, err := os.MkdirTemp(parent, "task-profile-native-")
	if err != nil {
		t.Fatal(err)
	}
	f := &taskProfileNativeFixture{root: root, ancestors: ancestors}
	t.Logf("Fresh owned Task profile root: %s", root)
	t.Cleanup(func() { f.cleanup(t) })
	f.checkPaths(t)
	for _, name := range []string{"computer", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	var st unix.Stat_t
	if err := unix.Lstat(root, &st); err != nil {
		t.Fatal(err)
	}
	f.binding = ProfileBinding{ProfileID: "profile", Root: root, Device: uint64(st.Dev), Inode: st.Ino}
	f.qualified, err = QualifyProfile(f.binding) // Production Darwin qualification.
	if err != nil || f.qualified == nil {
		t.Fatalf("actual profile qualification: %v", err)
	}
	f.chat = newChatComputerFixture(t) // No create/start/send/admission is invoked.
	return f
}

func taskProfileNativeDirectory(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Lstat(path)
	real, realErr := filepath.EvalSymlinks(path)
	var native unix.Stat_t
	if err != nil || realErr != nil || real != path || !info.IsDir() || unix.Lstat(path, &native) != nil || native.Uid != uint32(os.Geteuid()) || native.Mode&0022 != 0 || native.Mode&07000 != 0 {
		t.Fatal("native repository path identity/mode refused; never adopt a redirect")
	}
	return info
}

func (f *taskProfileNativeFixture) checkPaths(t *testing.T) {
	t.Helper()
	for path, original := range f.ancestors {
		if !os.SameFile(original, taskProfileNativeDirectory(t, path)) {
			t.Fatal("original repository ancestor changed; retain evidence")
		}
	}
	_ = taskProfileNativeDirectory(t, f.root)
}

func (f *taskProfileNativeFixture) open(peer wire.Context, chat *ChatIngress) (*taskProfileNativeOwner, error) {
	p, err := OpenTaskProfile(f.qualified, peer, "owner", chat)
	if p == nil {
		return nil, err
	}
	owned := &taskProfileNativeOwner{profile: p}
	f.profiles = append(f.profiles, owned) // Also retain any unexpected partial return.
	return owned, err
}

func (o *taskProfileNativeOwner) close(t *testing.T) {
	t.Helper()
	if o.closeAttempted {
		return // Never retry a failed/unknown native close.
	}
	o.closeAttempted = true
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := o.profile.Close(ctx); err != nil {
		t.Errorf("Task journal cleanup unconfirmed; retain original root: %v", err)
	}
}

// Observe only this fixture's fixed namespace. No recursive walk, repair,
// chmod, marker removal, stale-lock recovery or adoption of an unexpected file.
func taskProfileNativeObserve(t *testing.T, root string, taskChildren ...string) map[string]taskProfileNativeEntry {
	t.Helper()
	out := make(map[string]taskProfileNativeEntry)
	directories := []string{"", "computer", "chat"}
	directories = append(directories, taskChildren...)
	wantRoot := []string{"chat", "computer"}
	wantRoot = append(wantRoot, taskChildren...)
	for _, name := range directories {
		path := filepath.Join(root, name)
		var st unix.Stat_t
		if err := unix.Lstat(path, &st); err != nil {
			t.Fatal("native directory observation failed; retain root", err)
		}
		if st.Mode&(unix.S_IFMT|07777) != unix.S_IFDIR|0700 || st.Uid != uint32(os.Geteuid()) {
			t.Fatal("native directory identity/mode refused; retain root")
		}
		out[name] = taskProfileNativeEntry{device: uint64(st.Dev), inode: st.Ino, uid: st.Uid, mode: uint32(st.Mode)}
		entries, err := os.ReadDir(path)
		if err != nil {
			t.Fatal("native namespace observation failed; retain root", err)
		}
		if name == "" {
			if len(entries) != len(wantRoot) {
				t.Fatal("unexpected profile namespace; retain root")
			}
			for _, entry := range entries {
				found := false
				for _, wanted := range wantRoot {
					found = found || entry.Name() == wanted
				}
				if !found {
					t.Fatal("unexpected profile child; retain root")
				}
			}
			continue
		}
		for _, entry := range entries {
			if name != "task" || entry.Name() != ".task-journal.lock" && entry.Name() != "journal.json" {
				t.Fatal("unexpected/partial journal namespace; retain root")
			}
			key := filepath.Join(name, entry.Name())
			file := filepath.Join(root, key)
			if err := unix.Lstat(file, &st); err != nil || st.Mode&(unix.S_IFMT|07777) != unix.S_IFREG|0600 || st.Uid != uint32(os.Geteuid()) || st.Nlink != 1 || st.Size < 1 || st.Size > 4096 {
				t.Fatal("unexpected journal file identity/mode/size; retain root", err)
			}
			data, err := os.ReadFile(file)
			if err != nil || int64(len(data)) != st.Size {
				t.Fatal("journal byte observation failed; retain root", err)
			}
			out[key] = taskProfileNativeEntry{device: uint64(st.Dev), inode: st.Ino, uid: st.Uid, mode: uint32(st.Mode), data: string(data)}
		}
	}
	return out
}

func (f *taskProfileNativeFixture) cleanup(t *testing.T) {
	for i := len(f.profiles) - 1; i >= 0; i-- {
		f.profiles[i].close(t)
	}
	if f.qualified != nil {
		if err := f.qualified.Close(); err != nil {
			t.Errorf("qualified descriptor cleanup UNKNOWN; retain root: %v", err)
		}
	}
	if f.chat != nil && (len(f.chat.journal.entries) != 0 || len(f.chat.ingress.handles) != 0 || len(f.chat.ingress.used) != 0 || f.chat.physical.prepares != 0 || f.chat.physical.sends != 0 || f.chat.physical.observes != 0) {
		t.Error("storage qualification unexpectedly used Chat fixture")
	}
	if t.Failed() || !f.deleteSafe {
		t.Logf("RETAIN owned root (refusal/error/unfinished qualification): %s", f.root)
		return
	}
	// All exact owners have closed successfully. Observe identity and original
	// bytes once more before deleting only the enumerated fresh known entries.
	f.checkPaths(t)
	if got := taskProfileNativeObserve(t, f.root, "task"); !reflect.DeepEqual(got, f.known) {
		t.Fatal("post-cleanup root/journal changed; retain root")
	}
	for _, name := range []string{"task/journal.json", "task/.task-journal.lock", "task", "chat", "computer", ""} {
		if err := os.Remove(filepath.Join(f.root, name)); err != nil {
			t.Errorf("fresh-root deletion incomplete; retain remaining entries, no retry: %v", err)
			return
		}
	}
}

func requireTaskProfileNativeRefusal(t *testing.T, err error, code string) {
	t.Helper()
	var failure *TaskRuntimeFailure
	if !errors.As(err, &failure) || failure == nil || failure.Code != code || errors.Is(err, task.ErrUnknown) {
		t.Fatalf("expected classified %s; got %v; retain root", code, err)
	}
}

func TestNativeTaskProfileStorageQualification(t *testing.T) {
	if !*ingressNative {
		t.Skip("Requires exclusive Lead native lane and -ingress-native")
	}
	t.Run("original-journal-close", func(t *testing.T) {
		f := newTaskProfileNativeFixture(t)
		before := taskProfileNativeObserve(t, f.root, "task")
		root, err := f.qualified.TaskRoot()
		if err != nil || root.Path != filepath.Join(f.root, "task") || root.ProfileID != f.binding.ProfileID || root.Device != before["task"].device || root.Inode != before["task"].inode || root.OwnerUID != before["task"].uid || root.Mode != 0700 {
			t.Fatal("actual fixed Task child not qualified", err)
		}
		owned, err := f.open(f.chat.ingress.peer, f.chat.ingress)
		if err != nil || owned == nil {
			t.Fatal("actual OpenTaskProfile failed; retain root", err)
		}
		p := owned.profile
		journal, ok := p.journal.(*taskrepo.Filesystem)
		if !ok || p.closeJournal == nil || len(p.tasks) != 0 || len(p.clients) != 0 || len(p.routes) != 0 {
			t.Fatal("original native journal/no-turn composition missing")
		}
		ctx := context.Background()
		if snapshot, err := journal.Read(ctx, "unclaimed-task"); err != nil || snapshot != nil {
			t.Fatal("fresh journal is not known empty", err)
		}
		if operation, err := journal.Lookup(ctx, "unclaimed-operation"); err != nil || operation != nil {
			t.Fatal("fresh journal has an unexpected operation", err)
		}
		f.known = taskProfileNativeObserve(t, f.root, "task")
		if len(f.known) != 6 || f.known["task/journal.json"].data == "" || f.known["task/.task-journal.lock"].data == "" {
			t.Fatal("native journal did not publish its two original files")
		}
		for name, identity := range before {
			if f.known[name] != identity {
				t.Fatal("opening changed fixed directory identity")
			}
		}
		owned.close(t)
		if t.Failed() {
			return
		}
		if p.journal != journal || !errors.Is(p.available(ctx), task.ErrUnavailable) {
			t.Fatal("Close replaced journal or retained profile authority")
		}
		if _, err := journal.Read(ctx, "unclaimed-task"); !errors.Is(err, task.ErrUnavailable) {
			t.Fatal("original journal remained readable after Close", err)
		}
		if _, err := journal.Lookup(ctx, "unclaimed-operation"); !errors.Is(err, task.ErrUnavailable) {
			t.Fatal("original journal remained available after Close", err)
		}
		// Closed load must fence mutations before input validation or any claim.
		if admission, err := journal.Admit(ctx, task.Intent{}, 0, task.Task{}); admission != nil || !errors.Is(err, task.ErrUnavailable) {
			t.Fatal("original closed journal accepted admission", err)
		}
		if err := journal.Invalidate(ctx, port.Snapshot{}); !errors.Is(err, task.ErrUnavailable) {
			t.Fatal("original closed journal accepted invalidation", err)
		}
		if current, err := f.qualified.TaskRoot(); err != nil || current != root {
			t.Fatal("TaskProfile.Close consumed/changed outer qualified owner", err)
		}
		if got := taskProfileNativeObserve(t, f.root, "task"); !reflect.DeepEqual(got, f.known) {
			t.Fatal("Close changed original journal bytes or root identity")
		}
		f.deleteSafe = true // Cleanup still requires successful outer Close/observation.
	})

	for _, kind := range []string{"missing-task-root", "changed-task-root", "profile-mismatch", "peer-mismatch"} {
		t.Run(kind, func(t *testing.T) {
			f := newTaskProfileNativeFixture(t)
			original := taskProfileNativeObserve(t, f.root, "task")
			peer, chat := f.chat.ingress.peer, f.chat.ingress
			children := []string{"task"}
			code := "TASK_RUNTIME_OWNER_UNAVAILABLE"
			switch kind {
			case "missing-task-root", "changed-task-root":
				if err := os.Rename(filepath.Join(f.root, "task"), filepath.Join(f.root, "task-original")); err != nil {
					t.Fatal("fixture move failed; retain root", err)
				}
				children = []string{"task-original"}
				if kind == "changed-task-root" {
					if err := os.Mkdir(filepath.Join(f.root, "task"), 0700); err != nil {
						t.Fatal("fixture replacement failed; retain root", err)
					}
					children = append(children, "task")
				}
			case "profile-mismatch":
				peer.ProfileId = "other-profile"
				var err error
				chat, err = NewChatIngress(chat.facade, peer, "owner")
				if err != nil {
					t.Fatal(err)
				}
			case "peer-mismatch":
				peer.BackendGeneration = "other-backend"
				code = "TASK_RUNTIME_INPUT_INVALID"
			}
			before := taskProfileNativeObserve(t, f.root, children...)
			for _, name := range []string{"", "computer", "chat"} {
				if before[name] != original[name] {
					t.Fatal("fixture changed unrelated original directory identity")
				}
			}
			if kind == "missing-task-root" || kind == "changed-task-root" {
				if before["task-original"] != original["task"] || kind == "changed-task-root" && before["task"] == original["task"] {
					t.Fatal("fixture did not preserve original and distinct replacement identity")
				}
			}
			if owned, err := f.open(peer, chat); owned != nil {
				t.Fatal("refused boundary opened a Task owner; retain root")
			} else {
				requireTaskProfileNativeRefusal(t, err, code)
			}
			if got := taskProfileNativeObserve(t, f.root, children...); len(got) != len(children)+3 || !reflect.DeepEqual(got, before) {
				t.Fatal("refusal claimed/created Task files or changed original root")
			}
			// Keep the moved original/replacement/refusal evidence even on PASS.
		})
	}

	t.Run("concurrent-writer-refused", func(t *testing.T) {
		f := newTaskProfileNativeFixture(t)
		first, err := f.open(f.chat.ingress.peer, f.chat.ingress)
		if err != nil || first == nil {
			t.Fatal("first original writer unavailable; retain root", err)
		}
		before := taskProfileNativeObserve(t, f.root, "task")
		// Independent real native open while the first descriptor holds flock.
		// Same-process concurrent lifetimes; no cross-process/crash claim is made.
		if second, err := f.open(f.chat.ingress.peer, f.chat.ingress); second != nil {
			t.Fatal("second writer acquired original leased root; retain root")
		} else {
			requireTaskProfileNativeRefusal(t, err, "TASK_RUNTIME_UNAVAILABLE")
		}
		if snapshot, err := first.profile.journal.Read(context.Background(), "unclaimed-task"); err != nil || snapshot != nil {
			t.Fatal("refused writer disturbed original journal", err)
		}
		first.close(t)
		if t.Failed() {
			return
		}
		after := taskProfileNativeObserve(t, f.root, "task")
		if !reflect.DeepEqual(after, before) {
			t.Fatal("concurrent refusal/Close changed original bytes or identity")
		}
		// Do not reopen after refusal; retain this root for the Lead's evidence.
	})
}
