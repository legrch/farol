//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

// Native journal/filesystem and real Go delivery policy, with an explicit
// Settings-store/consent fixture. Separate OS-process framing is tested by the
// read-only CLI journey; this does not claim real Electron/MCP/Shell acceptance.
func TestFreshSessionWritableReopenRetainsOriginalUnknown(t *testing.T) {
	launch, workspace, _ := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	launch.StartupMode, launch.SettingsMutations = "fresh", true
	for n := 0; n < 2; n++ {
		r, err := NewNativeRuntime(context.Background(), launch, fmt.Sprintf("fresh-writable-%d", n))
		if err != nil {
			t.Fatal(err)
		}
		if r.retirement != nil || r.mutations == nil {
			t.Fatal("fresh native mutation composition unavailable")
		}
		generation := n + 2
		r.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, Generation: uint64(generation)}}}
		publication := nativeSettingsPublication(t, r, workspace, generation)
		name := fmt.Sprintf("new-canary-%d.txt", n)
		if err := os.WriteFile(filepath.Join(workspace, name), []byte("before"), 0600); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256([]byte("before"))
		request := wire.ComputerSettingsEditRequest{Publication: publication, WorkspaceId: "00000000-0000-4000-8000-000000000004", RelativePath: name, ExpectedSHA256: hex.EncodeToString(hash[:]), Edits: []wire.ComputerTextEdit{{OldText: "before", NewText: "after"}}}
		out := nativeSettingsCall(t, r, "computer.settings.delivery.apply", fmt.Sprintf("00000000-0000-4000-8000-%012d", n+1000), wire.SettingsDeliveryApply{DeadlineMillis: fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli()), Request: request})
		var offered wire.SettingsDeliveryResult
		if out.Status != "ok" || json.Unmarshal(out.Data, &offered) != nil || offered.Result == nil || offered.Result.Phase != "completed" || offered.Result.Publication != "durable" || offered.ReceiptId == nil {
			t.Fatalf("fresh real mutation receipt unavailable: %#v", out)
		}
		data, err := os.ReadFile(filepath.Join(workspace, name))
		if err != nil || string(data) != "after" {
			t.Fatal("new file edit did not execute exactly once", err)
		}
		ack := nativeSettingsCall(t, r, "computer.settings.delivery.ack", fmt.Sprintf("new-ack-%d", n), wire.SettingsDeliveryACK{DeadlineMillis: fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli()), ReceiptId: *offered.ReceiptId, Pending: offered.Pending})
		if ack.Status != "ok" {
			t.Fatal("current delivery ACK unconfirmed", ack)
		}
		closed := nativeSettingsCall(t, r, "core.fresh.close", "close-current", wire.CoreFreshClose{})
		if closed.Status != "ok" || r.Close() != nil {
			t.Fatal("current fresh drain failed", closed)
		}
		after := recoverySnapshot(t, launch.Profile.Root)
		for key, original := range before {
			// New canary publication intentionally changes this directory's
			// version. Every pre-existing file and journal stays exact.
			if key == "/workspace" {
				continue
			}
			if after[key] != original {
				t.Fatal("fresh write/reopen changed original UNKNOWN or history", key)
			}
		}
	}
}

// A signed-out packaged host still has an idle reciprocal Settings poll.
// Fresh drain must wake it normally before the host closes the inherited pipe.
func TestFreshSessionQuiescesSettingsPollingBeforeDrainReply(t *testing.T) {
	for _, fenced := range []bool{false, true} {
		t.Run(fmt.Sprint("fenced-", fenced), func(t *testing.T) {
			launch, _, _ := recoveryNativeFixture(t)
			launch.StartupMode, launch.SettingsMutations = "fresh", true
			r, err := NewNativeRuntime(context.Background(), launch, "fresh-idle-settings")
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			// Saved Settings/consent is an explicit fixture, not a host RPC.
			r.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, Generation: 2}}}
			if fenced {
				r.settingsStore.fence()
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				command, err := r.settingsStore.next(ctx, uint64(time.Now().Add(5*time.Second).UnixMilli()))
				if command != nil {
					done <- fmt.Errorf("unexpected Settings command")
					return
				}
				done <- err
			}()
			closed := nativeSettingsCall(t, r, "core.fresh.close", "close-idle-settings", wire.CoreFreshClose{})
			if fenced {
				if closed.Status != "unknown" {
					t.Fatal("fenced exchange reported drained", closed)
				}
				return
			}
			if closed.Status != "ok" {
				t.Fatal("current fresh drain failed", closed)
			}
			r.settingsStore.mu.Lock()
			quiesced := r.settingsStore.quiesced
			r.settingsStore.mu.Unlock()
			if !quiesced {
				t.Fatal("drained reply left the reciprocal Settings poll active")
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal("poll lost instead of quiesced", err)
				}
			case <-time.After(time.Second):
				t.Fatal("quiesced Settings poll did not complete")
			}
		})
	}
}

// Disposable native stores only, with no Electron, provider, Shell, process
// cleanup or real-profile admission. Existing UNKNOWN bytes remain historical.
func TestFreshSessionRetainsHistoryWithoutPreviousRetirement(t *testing.T) {
	launch, _, _ := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	launch.StartupMode = "fresh"
	for _, gen := range []string{"fresh-a", "fresh-b"} {
		r, err := NewNativeRuntime(context.Background(), launch, gen)
		if err != nil {
			t.Fatal(err)
		}
		if r.retirement != nil || r.fresh == nil || r.mutations != nil || r.connector.processes != nil {
			t.Fatal("fresh run gained previous retirement or unqualified mutation/process authority")
		}
		methods, err := r.Methods()
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := methods["core.retirement.prepare"]; ok {
			t.Fatal("old retirement route exposed")
		}
		out, err := methods["core.fresh.close"].Handle(context.Background(), desktop.Request{OperationID: "close-current", Body: []byte(`{}`)})
		if err != nil || out.Status != "ok" {
			t.Fatal(out, err)
		}
		again, _ := r.Methods()
		repeated, err := again["core.fresh.close"].Handle(context.Background(), desktop.Request{OperationID: "second-close", Body: []byte(`{}`)})
		if err != nil || repeated.Status != "refused" {
			t.Fatal("fresh drain was admitted twice", repeated, err)
		}
		if err = r.Close(); err != nil {
			t.Fatal(err)
		}
		after := recoverySnapshot(t, launch.Profile.Root)
		for key, value := range before {
			if after[key] != value {
				t.Fatalf("historical state changed: %s", key)
			}
		}
	}
	// The ordinary consumed-journal path still refuses missing previous drain.
	launch.StartupMode = "normal"
	if r, err := NewNativeRuntime(context.Background(), launch, "ordinary-unconfirmed"); r != nil || err == nil {
		if r != nil {
			_ = r.Close()
		}
		t.Fatal("previous retirement guard weakened")
	}
}

func TestFreshSessionAbandonedGenerationIsNeverReopened(t *testing.T) {
	launch, _, _ := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	launch.StartupMode = "fresh"
	first, err := NewNativeRuntime(context.Background(), launch, "abandoned-session")
	if err != nil {
		t.Fatal(err)
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	abandoned := recoverySnapshot(t, launch.Profile.Root)
	if repeated, err := NewNativeRuntime(context.Background(), launch, "abandoned-session"); repeated != nil || err == nil {
		if repeated != nil {
			_ = repeated.Close()
		}
		t.Fatal("same generation was reopened")
	}
	next, err := NewNativeRuntime(context.Background(), launch, "independent-session")
	if err != nil {
		t.Fatal(err)
	}
	if err = next.Close(); err != nil {
		t.Fatal(err)
	}
	after := recoverySnapshot(t, launch.Profile.Root)
	for key, value := range before {
		if after[key] != value {
			t.Fatal("original history changed", key)
		}
	}
	for key, value := range abandoned {
		if after[key] != value {
			t.Fatal("abandoned generation changed", key)
		}
	}
}

func TestFreshSessionRefusesCurrentOwner(t *testing.T) {
	launch, old := retirementStorageFixture(t, true)
	defer old.Close()
	before := recoverySnapshot(t, launch.Profile.Root)
	launch.StoreMode = "open"
	launch.StartupMode = "fresh"
	launch.SettingsMutations = false
	if r, err := NewNativeRuntime(context.Background(), launch, "competing"); r != nil || err == nil {
		if r != nil {
			_ = r.Close()
		}
		t.Fatal("active owner admitted")
	}
	after := recoverySnapshot(t, launch.Profile.Root)
	for key, value := range before {
		if after[key] != value {
			t.Fatal("conflict mutated historical state", key)
		}
	}
}

func TestFreshSessionRefusesIndependentChatOwnerAndLostClaim(t *testing.T) {
	launch, _, _ := recoveryNativeFixture(t)
	claim := filepath.Join(launch.Profile.Root, "chat", "chat-lifecycle.claim")
	fd, err := os.Open(claim)
	if err != nil {
		t.Fatal(err)
	}
	if err = unix.Flock(int(fd.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	launch.StartupMode = "fresh"
	if r, err := NewNativeRuntime(context.Background(), launch, "busy-chat"); r != nil || err == nil {
		if r != nil {
			_ = r.Close()
		}
		t.Fatal("old Chat owner admitted")
	}
	if err = fd.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := NewNativeRuntime(context.Background(), launch, "new-chat")
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(launch.Profile.Root, "chat", "fresh-session.claim")
	if err = os.Rename(original, original+".retained"); err != nil {
		t.Fatal(err)
	}
	if err = r.fresh.verify(); err == nil {
		t.Fatal("lost current claim accepted")
	}
	methods, _ := r.Methods()
	out, err := methods["core.fresh.close"].Handle(context.Background(), desktop.Request{OperationID: "close-lost", Body: []byte(`{}`)})
	if err != nil || out.Status != "unknown" {
		t.Fatal(out, err)
	}
	if err = r.Close(); err == nil {
		t.Fatal("lost claim close reported clean")
	}
}

func TestFreshSessionRefusesUnsafeOrPartialOriginalClaims(t *testing.T) {
	for _, kind := range []string{"partial", "mode", "symlink", "root-mode"} {
		t.Run(kind, func(t *testing.T) {
			launch, _, _ := recoveryNativeFixture(t)
			root := filepath.Join(launch.Profile.Root, "chat")
			claim := filepath.Join(root, "chat-lifecycle.claim")
			switch kind {
			case "partial":
				if err := os.Rename(claim, claim+".retained"); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(claim, 0644); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Rename(claim, claim+".retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(claim+".retained", claim); err != nil {
					t.Fatal(err)
				}
			case "root-mode":
				if err := os.Chmod(root, 0755); err != nil {
					t.Fatal(err)
				}
			}
			var before map[string]string
			if kind != "symlink" {
				before = recoverySnapshot(t, launch.Profile.Root)
			}
			launch.StartupMode = "fresh"
			if r, err := NewNativeRuntime(context.Background(), launch, "unsafe-original"); r != nil || err == nil {
				if r != nil {
					_ = r.Close()
				}
				t.Fatal("unsafe original claims admitted")
			}
			if kind == "symlink" {
				if target, err := os.Readlink(claim); err != nil || target != claim+".retained" {
					t.Fatal("symlink was repaired", target, err)
				}
			} else {
				after := recoverySnapshot(t, launch.Profile.Root)
				for key, value := range before {
					if after[key] != value {
						t.Fatal("unsafe historical bytes changed", key)
					}
				}
			}
			matches, err := filepath.Glob(filepath.Join(root, "fresh-*", "chat"))
			if err != nil || len(matches) != 0 {
				t.Fatal("unsafe claims allowed new Chat state", matches, err)
			}
		})
	}
}

func TestFreshAdmissionRejectsContradictionsWithoutChangingHistory(t *testing.T) {
	for name, change := range map[string]func(*NativeLaunch){
		"previous-drain": func(l *NativeLaunch) { l.PreviousHostDrainConfirmed = true },
		"missing-host":   func(l *NativeLaunch) { l.HostLifetimeID = "" },
		"missing-child":  func(l *NativeLaunch) { l.ChildLaunchID = "" },
		"codex-read":     func(l *NativeLaunch) { l.CodexRead = &NativeCodexReadSelection{} },
	} {
		t.Run(name, func(t *testing.T) {
			launch, _, _ := recoveryNativeFixture(t)
			before := recoverySnapshot(t, launch.Profile.Root)
			launch.StartupMode = "fresh"
			change(&launch)
			r, err := NewNativeRuntime(context.Background(), launch, "contradictory-fresh")
			if r != nil || err == nil {
				if r != nil {
					_ = r.Close()
				}
				t.Fatal("contradictory fresh selection admitted")
			}
			after := recoverySnapshot(t, launch.Profile.Root)
			for key, value := range before {
				if after[key] != value {
					t.Fatal("refused selection changed historical state", key)
				}
			}
			if _, err := os.Lstat(filepath.Join(launch.Profile.Root, "chat", "fresh-session.claim")); !os.IsNotExist(err) {
				t.Fatal("contradictory selection reached fresh claim creation", err)
			}
		})
	}
}
