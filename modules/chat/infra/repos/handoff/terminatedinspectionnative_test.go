//go:build darwin || linux

package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
	lifecycleapp "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"golang.org/x/sys/unix"
)

// AUTHOR ONLY until the Lead selects the existing chat-closed-inspection-native
// lane. Actual lifecycle/repository owners create the chain in a fresh disposable
// profile; normal child exit is explicitly fixture input, not process evidence.
// Every newly allocated fixture root is deliberately retained, positive and
// negative alike, for post-run evidence. Cleanup closes only owned descriptors;
// it never recursively deletes or adopts a root. No installed profile, provider
// or app is used.
func terminatedInspectionNativeFixture(t *testing.T, ancestor bool) (Roots, port.JournalScope) {
	t.Helper()
	base, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	parent, err := os.MkdirTemp(base, "farol-chat-terminatedinspection-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true terminal=synthetic process_closure=unproven", parent)
	chat := filepath.Join(parent, "chat")
	if err := os.Mkdir(chat, 0700); err != nil {
		t.Fatal(err)
	}
	root := func(path string) Root {
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			t.Fatal(err)
		}
		return Root{Path: path, Identity: port.JournalRoot{Device: uint64(s.Dev), Inode: uint64(s.Ino), OwnerUID: s.Uid}}
	}
	roots := Roots{ProfileID: "profile", Parent: root(parent), Chat: root(chat)}
	b := nativeBinding(roots)
	scope := port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
	chatRoot := lifecyclerepo.Root{Path: chat, ProfileID: b.ProfileID, Device: b.ChatRoot.Device, Inode: b.ChatRoot.Inode, OwnerUID: b.ChatRoot.OwnerUID}
	limits := lifecyclerepo.Limits{Bytes: 1048576, Records: 4096}
	ctx := context.Background()
	journal, err := lifecyclerepo.New(ctx, chatRoot, limits)
	if err != nil {
		t.Fatal(err)
	}
	retainJournal := func(opened *lifecyclerepo.Repository) {
		t.Cleanup(func() {
			if err := opened.Close(); err != nil {
				t.Error(err)
			}
		})
	}
	retainJournal(journal)
	cycles := 1
	if ancestor {
		cycles = 2
	}
	for cycle := 1; cycle <= cycles; cycle++ {
		actual, err := lifecycleapp.New(ctx, scope, lifecycleapp.Dependencies{Gate: &sync.Mutex{}, Journal: journal})
		if err != nil {
			t.Fatal(err)
		}
		origin, err := actual.Retire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		repo := openRepo(t, roots)
		service, err := policy.New(repo)
		if err != nil {
			t.Fatal(err)
		}
		p, err := service.Capture(ctx, b, fmt.Sprintf("terminated-%d", cycle), origin)
		if err != nil {
			t.Fatal(err)
		}
		ack, err := service.Acknowledge(ctx, port.HandoffACK{Publication: *p})
		if err != nil {
			t.Fatal(err)
		}
		if err := journal.Close(); err != nil {
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
		// A distinct recorder repository persists an explicitly synthetic terminal.
		recorder := openRepo(t, roots)
		service, err = policy.New(recorder)
		if err != nil {
			t.Fatal(err)
		}
		zero := 0
		if err := service.ObserveTerminal(ctx, port.HandoffTerminal{Publication: *p, KnownACKDigest: ack, Kind: port.HandoffNormalExit, StopMode: port.HandoffGracefulStop, ExitCode: &zero}); err != nil {
			t.Fatal(err)
		}
		if err := recorder.Close(); err != nil {
			t.Fatal(err)
		}
		if cycle == cycles {
			break
		}
		// Only fixture setup consumes the actual first retirement to obtain the
		// existing lifecycle successor. The inspector never receives its proof.
		successorStore := openRepo(t, roots)
		service, err = policy.New(successorStore)
		if err != nil {
			t.Fatal(err)
		}
		b = historyNextBinding(b, cycle+1)
		scope = port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
		successor, err := service.Consume(ctx, *p, port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: scope, NextBinding: b, AttemptID: "fixture-successor"})
		if err != nil {
			t.Fatal(err)
		}
		journal, err = lifecyclerepo.NewAfterRetirement(ctx, chatRoot, successor.Scope, limits, successor.Proof)
		if err != nil {
			t.Fatal(err)
		}
		retainJournal(journal)
		if err := successorStore.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return roots, scope
}

func terminatedInspectionNativeUnchanged(t *testing.T, path string, before map[string]closedInspectionNativeEntry) {
	t.Helper()
	after := closedInspectionNativeInventory(t, path)
	if len(before) != len(after) {
		t.Fatal("inspection created/deleted entries")
	}
	for name, b := range before {
		a, ok := after[name]
		if !ok || !stable(b.meta, a.meta) || b.digest != a.digest {
			t.Fatal("inspection changed entry", name)
		}
	}
}

func TestTerminatedRetirementInspectionNativeActualOwnersAndClaim(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead chat-closed-inspection-native lane")
	}
	for _, ancestor := range []bool{false, true} {
		if !t.Run(fmt.Sprintf("consumed_ancestor=%t", ancestor), func(t *testing.T) {
			roots, scope := terminatedInspectionNativeFixture(t, ancestor)
			before := closedInspectionNativeInventory(t, roots.Chat.Path)
			l, err := AcquireTerminatedRetirementInspection(context.Background(), roots, scope)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := l.Close(); err != nil {
					t.Error(err)
				}
			})
			v, err := l.Observation()
			steps := 3
			if ancestor {
				steps = 7
			}
			if err != nil || v.Scope != scope || v.HeadStage != port.HandoffTerminated || len(v.Stages) != steps || v.Head == nil || v.Head.Record.Consumption != nil || *v.Head.Record.Terminal.ExitCode != 0 {
				t.Fatal("actual terminated chain differs", err)
			}
			if other, err := AcquireTerminatedRetirementInspection(context.Background(), roots, scope); err == nil {
				if err := other.Close(); err != nil {
					t.Error(err)
				}
				t.Fatal("inspection lost existing exclusive claim")
			}
			*v.Head.Record.Terminal.ExitCode = 99
			v.Head.Record.ACK.Publication.HandoffID = "changed"
			v.Stages[0].Digest[0]++
			if err := l.Verify(); err != nil {
				t.Fatal(err)
			}
			if err := l.Close(); err != nil {
				t.Fatal(err)
			}
			terminatedInspectionNativeUnchanged(t, roots.Chat.Path, before)
			other, err := AcquireTerminatedRetirementInspection(context.Background(), roots, scope)
			if err != nil {
				t.Fatal("inspection leaked its claim", err)
			}
			if err := other.Close(); err != nil {
				t.Fatal(err)
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

func TestTerminatedRetirementInspectionNativeRefusalsPreserveStorage(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead chat-closed-inspection-native lane")
	}
	for _, kind := range []string{"scope", "parent-root", "chat-root", "unknown", "hidden-staging", "staging", "gap", "missing-claim", "claim-mode", "claim-held", "commit-digest"} {
		if !t.Run(kind, func(t *testing.T) {
			roots, scope := terminatedInspectionNativeFixture(t, true)
			chat := roots.Chat.Path
			current := roots
			switch kind {
			case "scope":
				scope.BackendGeneration = "wrong"
			case "parent-root":
				current.Parent.Identity.Inode++
			case "chat-root":
				current.Chat.Identity.Inode++
			case "unknown", "hidden-staging", "staging":
				name := unknownName
				if kind == "hidden-staging" {
					name = ".chat-handoff-staging"
				} else if kind == "staging" {
					name = "chat-handoff-staging"
				}
				if err := os.WriteFile(filepath.Join(chat, name), []byte("retained fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			case "gap", "missing-claim":
				name := stepName(2, "attempt")
				if kind == "missing-claim" {
					name = claimName
				}
				if err := os.Rename(filepath.Join(chat, name), filepath.Join(roots.Parent.Path, "retained-entry")); err != nil {
					t.Fatal(err)
				}
			case "claim-mode":
				if err := os.Chmod(filepath.Join(chat, claimName), 0644); err != nil {
					t.Fatal(err)
				}
			case "claim-held":
				fd, err := unix.Open(filepath.Join(chat, claimName), unix.O_RDONLY|unix.O_NOFOLLOW, 0)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := unix.Close(fd); err != nil {
						t.Error(err)
					}
				})
				if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
					t.Fatal(err)
				}
			case "commit-digest":
				if err := os.WriteFile(filepath.Join(chat, stepName(1, "commit")), make([]byte, 64), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := closedInspectionNativeInventory(t, chat)
			l, err := AcquireTerminatedRetirementInspection(context.Background(), current, scope)
			if l != nil || err == nil {
				if l != nil {
					if err := l.Close(); err != nil {
						t.Error(err)
					}
				}
				t.Fatal("invalid storage acquired a lease", err)
			}
			terminatedInspectionNativeUnchanged(t, chat, before)
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

func TestTerminatedRetirementInspectionNativeFinalVerifyDetectsChanges(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead chat-closed-inspection-native lane")
	}
	for _, kind := range []string{"bytes", "same-bytes-identity", "claim-identity", "root-identity", "unknown", "staging"} {
		if !t.Run(kind, func(t *testing.T) {
			roots, scope := terminatedInspectionNativeFixture(t, true)
			chat := roots.Chat.Path
			l, err := AcquireTerminatedRetirementInspection(context.Background(), roots, scope)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := l.Close(); err != nil {
					t.Error(err)
				}
			})
			if _, err := l.Observation(); err != nil || l.Verify() != nil {
				t.Fatal("initial observation failed", err)
			}
			switch kind {
			case "bytes":
				attempt := filepath.Join(chat, stepName(7, "attempt"))
				raw, err := os.ReadFile(attempt)
				if err != nil {
					t.Fatal(err)
				}
				// Keep the replacement record and commit canonical, but break the
				// exact previous ACK digest. Final Verify must reject the mutation.
				r, err := decode(raw)
				if err != nil {
					t.Fatal(err)
				}
				r.Terminal.KnownACKDigest[0]++
				raw, err = encode(r)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(attempt, raw, 0600); err != nil {
					t.Fatal(err)
				}
				digest := sha256.Sum256(raw)
				if err := os.WriteFile(filepath.Join(chat, stepName(7, "commit")), []byte(hex.EncodeToString(digest[:])), 0600); err != nil {
					t.Fatal(err)
				}
			case "same-bytes-identity", "claim-identity":
				name := stepName(1, "attempt")
				if kind == "claim-identity" {
					name = claimName
				}
				file := filepath.Join(chat, name)
				raw, err := os.ReadFile(file)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(file, filepath.Join(roots.Parent.Path, "retained-original")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "root-identity":
				if err := os.Rename(chat, chat+".retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(chat, 0700); err != nil {
					t.Fatal(err)
				}
			case "unknown", "staging":
				name := unknownName
				if kind == "staging" {
					name = ".chat-handoff-staging"
				}
				if err := os.WriteFile(filepath.Join(chat, name), []byte("late fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			observedChat := chat
			if kind == "root-identity" {
				observedChat += ".retained"
			}
			before := closedInspectionNativeInventory(t, observedChat)
			failure := l.Verify()
			if failure == nil || l.Verify() != failure {
				t.Fatal("late change accepted or failed verification retried", failure)
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("failed lease exposed stale observation")
			}
			if err := l.Close(); err != nil {
				t.Fatal("failed verification leaked claim", err)
			}
			terminatedInspectionNativeUnchanged(t, observedChat, before)
			if kind != "unknown" {
				if _, err := os.Lstat(filepath.Join(observedChat, unknownName)); !os.IsNotExist(err) {
					t.Fatal("inspection poisoned storage", err)
				}
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}
