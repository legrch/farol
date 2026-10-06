//go:build darwin || linux

package handoff

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
	lifecycleapp "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"golang.org/x/sys/unix"
)

// These tests qualify disposable native files/locks and the existing actual
// lifecycle successor constructor. They do NOT qualify boot, process exit,
// initiating host trust, recorder attestation, Electron or normal Quit/reopen.
func nativeRoots(t *testing.T) Roots {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(parent, 0700); err != nil {
		t.Fatal(err)
	}
	chat := filepath.Join(parent, "chat")
	if err = os.Mkdir(chat, 0700); err != nil {
		t.Fatal(err)
	}
	root := func(path string) Root {
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			t.Fatal(err)
		}
		return Root{Path: path, Identity: port.JournalRoot{Device: uint64(s.Dev), Inode: s.Ino, OwnerUID: s.Uid}}
	}
	return Roots{ProfileID: "profile", Parent: root(parent), Chat: root(chat)}
}
func nativeBinding(roots Roots) port.HandoffBinding {
	return port.HandoffBinding{ProfileID: roots.ProfileID, BackendGeneration: "generation-1", BuildID: "build", HostLifetimeID: "host-1", ChildLaunchID: "child-1", ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity}
}
func openRepo(t *testing.T, roots Roots) *Repository {
	t.Helper()
	r, err := New(context.Background(), roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(); err != nil {
			t.Error(err)
		}
	})
	return r
}
func TestNativeHandoffActualRetireSuccessorAndSecondCycle(t *testing.T) {
	for _, name := range []string{"empty", "withdrawn-read", "empty-cross-build"} {
		t.Run(name, func(t *testing.T) {
			nativeActualRetireSuccessor(t, name == "withdrawn-read", name == "empty-cross-build")
		})
	}
}

func nativeActualRetireSuccessor(t *testing.T, withdrawRead, crossBuild bool) {
	t.Helper()
	ctx := context.Background()
	roots := nativeRoots(t)
	b := nativeBinding(roots)
	chatRoot := lifecyclerepo.Root{Path: roots.Chat.Path, ProfileID: roots.ProfileID, Device: roots.Chat.Identity.Device, Inode: roots.Chat.Identity.Inode, OwnerUID: roots.Chat.Identity.OwnerUID}
	limits := lifecyclerepo.Limits{Bytes: 1048576, Records: 4096}
	journal, err := lifecyclerepo.New(ctx, chatRoot, limits)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { journal.Close() })
	actual, err := lifecycleapp.New(ctx, port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, lifecycleapp.Dependencies{Gate: &sync.Mutex{}, Journal: journal})
	if err != nil {
		t.Fatal(err)
	}
	if withdrawRead {
		fixed := port.TurnBinding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "read-turn", OperationID: "read-operation", TurnGeneration: 1}
		// Actual live admission and withdrawal; no Browser or provider is assembled.
		h, err := actual.Admit(ctx, fixed, strings.Repeat("a", 64))
		if err != nil {
			t.Fatal(err)
		}
		if err := actual.WithdrawReadIntent(ctx, h); err != nil {
			t.Fatal(err)
		}
		if err := h.WithCurrent(ctx, func(current *port.CurrentTurn) error {
			if current != nil {
				t.Fatal("withdrawn read remains current")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	origin, err := actual.Retire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, roots)
	service, _ := policy.New(repo)
	publication, err := service.Capture(ctx, b, "handoff-1", origin)
	if err != nil {
		t.Fatal(err)
	}
	head, err := repo.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	w := head.Record.Receipt.Write
	if withdrawRead {
		if w.PreviousRevision != 3 || w.Revision != 4 || len(w.Turns) != 1 || w.Turns[0].AcknowledgedRevision != 3 || w.Turns[0].Binding.OperationID != "read-operation" {
			t.Fatal("capture did not retain exact withdrawn-read receipt")
		}
	} else if w.PreviousRevision != 0 || len(w.Turns) != 0 {
		t.Fatal("empty retirement changed")
	}
	if head.EmptyRetirementChain == withdrawRead {
		t.Fatal("native scan misclassified retirement prefix")
	}
	ack, err := service.Acknowledge(ctx, port.HandoffACK{Publication: *publication})
	if err != nil {
		t.Fatal(err)
	}
	if err = repo.Close(); err != nil {
		t.Fatal(err)
	}
	// A separate repository lifetime represents recorder persistence; the child
	// terminal below is an explicit FIXTURE, not an observed real process event.
	recorder := openRepo(t, roots)
	service, _ = policy.New(recorder)
	zero := 0
	if err = service.ObserveTerminal(ctx, port.HandoffTerminal{Publication: *publication, KnownACKDigest: ack, Kind: port.HandoffNormalExit, StopMode: port.HandoffGracefulStop, ExitCode: &zero}); err != nil {
		t.Fatal(err)
	}
	if err = recorder.Close(); err != nil {
		t.Fatal(err)
	}
	successorStore := openRepo(t, roots)
	service, _ = policy.New(successorStore)
	next := b
	if crossBuild {
		next.BuildID = "new-build"
	}
	next.BackendGeneration = "generation-2"
	next.HostLifetimeID = "host-2"
	next.ChildLaunchID = "child-2"
	nextScope := port.JournalScope{ProfileID: roots.ProfileID, BackendGeneration: next.BackendGeneration}
	successor, err := service.Consume(ctx, *publication, port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: nextScope, NextBinding: next, AttemptID: "attempt-2"})
	if err != nil {
		t.Fatal(err)
	}
	consumed, err := successorStore.Load(ctx)
	if err != nil || consumed.Record.Publication != *publication || consumed.Record.Consumption.NextBinding != next {
		t.Fatal("native cross-build provenance changed", err)
	}
	if _, err = service.Consume(ctx, *publication, port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: nextScope, NextBinding: next, AttemptID: "attempt-2"}); err == nil {
		t.Fatal("consumed successor replayed")
	}
	reopened, err := lifecyclerepo.NewAfterRetirement(ctx, chatRoot, successor.Scope, limits, successor.Proof)
	if err != nil {
		t.Fatal("existing lifecycle successor rejected retained actual origin", err)
	}
	t.Cleanup(func() { reopened.Close() })
	if err := successor.Proof.WithRetirement(ctx, func(*port.RetirementReceipt) error {
		t.Fatal("native constructor proof reused")
		return nil
	}); !errors.Is(err, policy.Refused) {
		t.Fatal("native constructor did not consume proof", err)
	}
	actualNext, err := lifecycleapp.New(ctx, successor.Scope, lifecycleapp.Dependencies{Gate: &sync.Mutex{}, Journal: reopened})
	if err != nil {
		t.Fatal(err)
	}
	nextOrigin, err := actualNext.Retire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := nextOrigin.WithRetirement(ctx, func(r *port.RetirementReceipt) error {
		if r.Write.PreviousRevision != 0 || r.Write.Revision != 1 || r.Write.Turns == nil || len(r.Write.Turns) != 0 || r.Write.Scope != nextScope {
			t.Fatal("native successor restored retired handles or history")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Capture(ctx, next, "handoff-2", nextOrigin); err != nil {
		t.Fatal("matching actual successor cannot retire", err)
	}
	if err = successorStore.Close(); err != nil {
		t.Fatal(err)
	}
	final := openRepo(t, roots)
	head, err = final.Load(ctx)
	if err != nil || head.Record.Publication.Binding != next || head.Record.Stage != port.HandoffCaptured {
		t.Fatal("second-cycle continuity lost", err)
	}
}
func TestNativeHandoffQualificationAndPermanentFences(t *testing.T) {
	for _, name := range []string{"parent-mode", "chat-mode", "cross-parent", "cross-chat", "claim-symlink", "claim-hardlink", "claim-fifo", "attempt-only", "orphan-commit", "gap", "unknown-name", "malformed", "file-mode", "file-hardlink", "file-symlink", "unknown-fence"} {
		t.Run(name, func(t *testing.T) {
			roots := nativeRoots(t)
			path := func(s string) string { return filepath.Join(roots.Chat.Path, s) }
			r := recordFixture()
			r.Publication.Binding = nativeBinding(roots)
			r.Receipt.Write.Root = roots.Chat.Identity
			raw, err := encode(r)
			if err != nil {
				t.Fatal(err)
			}
			write := func(n string, data []byte) {
				if err := os.WriteFile(path(n), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "parent-mode":
				os.Chmod(roots.Parent.Path, 0755)
			case "chat-mode":
				os.Chmod(roots.Chat.Path, 0755)
			case "cross-parent":
				roots.Parent.Identity.Inode++
			case "cross-chat":
				roots.Chat.Identity.Inode++
			case "claim-symlink":
				os.Symlink("target", path(claimName))
			case "claim-hardlink":
				write("target", []byte("x"))
				os.Link(path("target"), path(claimName))
			case "claim-fifo":
				if err = unix.Mkfifo(path(claimName), 0600); err != nil {
					t.Fatal(err)
				}
			default:
				write(claimName, []byte{})
				switch name {
				case "attempt-only":
					write(stepName(1, "attempt"), raw)
				case "orphan-commit":
					write(stepName(1, "commit"), []byte("x"))
				case "gap":
					write(stepName(2, "attempt"), raw)
				case "unknown-name":
					write("chat-handoff-unrecognized.tmp", []byte("x"))
				case "malformed":
					write(stepName(1, "attempt"), []byte("{"))
					write(stepName(1, "commit"), []byte("bad"))
				case "file-mode":
					write(stepName(1, "attempt"), raw)
					os.Chmod(path(stepName(1, "attempt")), 0644)
				case "file-hardlink":
					write("target", raw)
					os.Link(path("target"), path(stepName(1, "attempt")))
				case "file-symlink":
					write("target", raw)
					os.Symlink("target", path(stepName(1, "attempt")))
				case "unknown-fence":
					write(unknownName, []byte("UNKNOWN"))
				}
			}
			repo, err := New(context.Background(), roots)
			if err == nil {
				_, err = repo.Load(context.Background())
				repo.Close()
			}
			if err == nil {
				t.Fatal("unsafe native state accepted")
			}
			// Failure retains evidence. No deletion or alternate-root recovery occurs.
			if name == "attempt-only" {
				if _, err = os.Lstat(path(stepName(1, "attempt"))); err != nil {
					t.Fatal("attempt fence removed")
				}
			}
		})
	}
}
func TestNativeHandoffExclusiveCompareAndPublication(t *testing.T) {
	roots := nativeRoots(t)
	repo := openRepo(t, roots)
	if second, err := New(context.Background(), roots); err == nil {
		second.Close()
		t.Fatal("concurrent owner acquired claim")
	}
	r := recordFixture()
	r.Publication.Binding = nativeBinding(roots)
	r.Receipt.Write.Root = roots.Chat.Identity
	head, err := repo.Publish(context.Background(), [32]byte{}, r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = repo.Publish(context.Background(), [32]byte{}, r); !errors.Is(err, Refused) {
		t.Fatal("CAS replay accepted", err)
	}
	if err = repo.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openRepo(t, roots)
	visible, err := reopened.Load(context.Background())
	if err != nil || visible.Digest != head.Digest {
		t.Fatal("durable readback differs", err)
	}
	// A retained record with removed claim must not recreate authority.
	if err = reopened.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(roots.Chat.Path, claimName)); err != nil {
		t.Fatal(err)
	} // disposable fault injection only
	if restored, err := New(context.Background(), roots); err == nil {
		restored.Close()
		t.Fatal("removed claim silently recreated")
	}
}

func TestNativeHandoffUncertainKnownPublicationFencesReopen(t *testing.T) {
	ctx := context.Background()
	roots := nativeRoots(t)
	repo := openRepo(t, roots)
	r := recordFixture()
	r.Publication.Binding = nativeBinding(roots)
	r.Receipt.Write.Root = roots.Chat.Identity
	if _, err := repo.Publish(ctx, [32]byte{}, r); err != nil {
		t.Fatal(err)
	}
	// Simulate caller learning a late/lost reply after the adapter returned known
	// bytes. The distinct one-shot uncertainty fence must survive a new lifetime.
	if err := repo.Fence(ctx); err != nil {
		t.Fatal(err)
	}
	if err := repo.Fence(ctx); err != nil {
		t.Fatal("cached fence outcome changed", err)
	}
	if _, err := repo.Load(ctx); !errors.Is(err, Unknown) {
		t.Fatal("fenced repository usable", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if next, err := New(ctx, roots); err == nil {
		next.Close()
		t.Fatal("uncertain known bytes reopened")
	}
	for _, name := range []string{claimName, stepName(1, "attempt"), stepName(1, "commit"), unknownName} {
		if _, err := os.Lstat(filepath.Join(roots.Chat.Path, name)); err != nil {
			t.Fatal("evidence removed", err)
		}
	}
}
