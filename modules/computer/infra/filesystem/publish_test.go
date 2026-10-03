package filesystem

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

func replaceFixture() (*Mutable, *fakeMutationFS, mutation.Write) {
	m, f := fakeMutable()
	f.work.children["note.md"] = f.file("old")
	hash := payloadHash([]byte("old"))
	return m, f, mutation.Write{RelativePath: "note.md", Content: "new", ExpectedSHA256: &hash}
}
func TestMutationInjectedGuardedUndoAtMostOnce(t *testing.T) {
	m, f, op := replaceFixture()
	foreign := f.file("foreign")
	f.beforeSwap = func(n int) {
		if n == 1 {
			f.work.children["note.md"] = foreign
		}
	}
	_, err := m.Mutate(context.Background(), fakeRequest(op))
	nativeCode(t, err, "WORKSPACE_MUTATION_CONFLICT")
	if f.swaps != 2 || f.work.children["note.md"] != foreign || stageOf(f) != nil {
		t.Fatal("failed guarded restore")
	}
}
func TestMutationInjectedNewerSavePreventsUndoAndRetainsDisplaced(t *testing.T) {
	m, f, op := replaceFixture()
	foreign, newer := f.file("foreign"), f.file("newer")
	f.beforeSwap = func(n int) {
		if n == 1 {
			f.work.children["note.md"] = foreign
		}
	}
	f.afterSwap = func(n int) {
		if n == 1 {
			f.work.children["note.md"] = newer
		}
	}
	_, err := m.Mutate(context.Background(), fakeRequest(op))
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if f.swaps != 1 || f.work.children["note.md"] != newer || stageOf(f) == nil || stageOf(f).children["candidate"] != foreign {
		t.Fatal("newer save overwritten or displaced lost")
	}
}
func TestMutationInjectedUndoFailureOrChangedCandidateRetainsStage(t *testing.T) {
	for _, name := range []string{"lost undo", "changed candidate", "newer save during undo"} {
		t.Run(name, func(t *testing.T) {
			m, f, op := replaceFixture()
			foreign := f.file("foreign")
			f.beforeSwap = func(n int) {
				if n == 1 {
					f.work.children["note.md"] = foreign
				}
				if n == 2 && name == "newer save during undo" {
					f.work.children["note.md"] = f.file("newer")
				}
			}
			f.swapFault = func(n int) error {
				if n == 2 && name == "lost undo" {
					return errors.New("lost ACK")
				}
				return nil
			}
			f.afterSwap = func(n int) {
				if n == 1 && name == "changed candidate" {
					node := f.work.children["note.md"]
					node.data = []byte("changed")
					node.v.size = 7
					node.v.mtime++
				}
			}
			_, err := m.Mutate(context.Background(), fakeRequest(op))
			nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if f.swaps != 2 || stageOf(f) == nil || stageOf(f).children["candidate"] == nil || f.unlinks != 0 {
				t.Fatal("repeated undo/deleted unowned object")
			}
		})
	}
}
func TestMutationInjectedDisplacedPreimageInPlaceChange(t *testing.T) {
	m, f, op := replaceFixture()
	original := f.work.children["note.md"]
	f.beforeSwap = func(n int) {
		if n == 1 {
			original.data = []byte("foreign")
			original.v.size = 7
			original.v.mtime++
		}
	}
	_, err := m.Mutate(context.Background(), fakeRequest(op))
	nativeCode(t, err, "WORKSPACE_MUTATION_CONFLICT")
	if f.swaps != 2 || f.work.children["note.md"] != original || string(original.data) != "foreign" {
		t.Fatal("lost in-place original")
	}
}
func TestMutationInjectedNoWeakSwapFallback(t *testing.T) {
	m, f, op := replaceFixture()
	f.swapFault = func(int) error { return unix.ENOTSUP }
	_, err := m.Mutate(context.Background(), fakeRequest(op))
	nativeCode(t, err, "WORKSPACE_PATH_REFUSED")
	if f.swaps != 1 || f.links != 0 || string(f.work.children["note.md"].data) != "old" || stageOf(f) != nil {
		t.Fatal("fallback/cleanup mismatch")
	}
}
func TestMutationInjectedPostPublicationUncertaintyNeverCleanRefusal(t *testing.T) {
	for _, name := range []string{"create unlink", "stage removal", "directory sync", "final changed bytes", "stage substitution", "cancel"} {
		t.Run(name, func(t *testing.T) {
			m, f := fakeMutable()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.afterLink = func() {
				switch name {
				case "final changed bytes":
					n := f.work.children["note.md"]
					n.data = []byte("bad")
					n.v.mtime++
				case "stage substitution":
					f.work.children[".farol-mutation-0123456789abcdef"] = f.directory(0700)
				case "cancel":
					cancel()
				}
			}
			f.onUnlink = func(_ int, _ string, dir bool) error {
				if name == "create unlink" && !dir || name == "stage removal" && dir {
					return unix.EIO
				}
				return nil
			}
			f.onSync = func(n *fakeNode) error {
				if name == "directory sync" && n == f.work && f.links == 1 {
					return unix.EIO
				}
				return nil
			}
			_, err := m.Mutate(ctx, fakeRequest(mutation.Write{RelativePath: "note.md", Content: "new"}))
			nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if f.links != 1 || f.swaps != 0 {
				t.Fatal("effect count")
			}
			if name == "create unlink" && (stageOf(f) == nil || stageOf(f).children["candidate"] == nil || f.unlinks != 1) {
				t.Fatal("lost retained stage/retried unlink")
			}
		})
	}
}
func TestMutationInjectedLostFirstPublicationAcknowledgement(t *testing.T) {
	m, f, op := replaceFixture()
	f.swapFault = func(int) error { return errors.New("unknown syscall ACK") }
	_, err := m.Mutate(context.Background(), fakeRequest(op))
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if f.swaps != 1 || f.unlinks != 0 || stageOf(f) == nil {
		t.Fatal("unknown attempt retried/cleaned")
	}
}

func TestMutationInjectedValidSwapThenNewerSaveRetainsOriginal(t *testing.T) {
	m, f, op := replaceFixture()
	original := f.work.children["note.md"]
	newer := f.file("newer")
	f.afterSwap = func(n int) {
		if n == 1 {
			f.work.children["note.md"] = newer
		}
	}
	_, err := m.Mutate(context.Background(), fakeRequest(op))
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if f.swaps != 1 || f.work.children["note.md"] != newer || stageOf(f) == nil || stageOf(f).children["candidate"] != original || f.unlinks != 0 {
		t.Fatal("lost original/newer save")
	}
}
func TestMutationInjectedUnknownParentMkdirAcknowledgement(t *testing.T) {
	m, f := fakeMutable()
	f.onMkdir = func(string) error { return errors.New("lost mkdir ACK") }
	_, err := m.Mutate(context.Background(), fakeRequest(mutation.Write{RelativePath: "nested/note.md", Content: "new"}))
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if f.mkdirs != 1 || f.links != 0 || f.swaps != 0 || f.unlinks != 0 {
		t.Fatal("uncertain parent attempt repeated")
	}
}
