//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

// Real disposable native preservation/owners/retirement. Initiating host ACK
// and exact child terminal below are fixtures, not actual host/process proof.
func TestNativeEmptyRecoveryPreparationPreservesAndRetiresNewOwner(t *testing.T) {
	in := emptyRecoveryFixture(t)
	old := NativeRoot{Path: filepath.Join(in.Profile.Root, "chat"), ProfileID: in.Profile.ProfileID, Device: in.Selection.Current.ChatRoot.Device, Inode: in.Selection.Current.ChatRoot.Inode, OwnerUID: in.Selection.Current.ChatRoot.OwnerUID}
	before, err := emptyRecoveryArchiveFiles(context.Background(), old)
	if err != nil {
		t.Fatal(err)
	}
	ackCalls := 0
	ack, err := prepareEmptyRecovery(context.Background(), in, func(p chatport.HandoffPublication) error {
		ackCalls++
		if p.Binding.BackendGeneration != in.Selection.Next.BackendGeneration || p.Binding.ChatRoot == in.Selection.Current.ChatRoot || p.HandoffID != in.Selection.OperationID {
			t.Fatal("wrong new owner")
		}
		return nil
	})
	if err != nil || ackCalls != 1 {
		t.Fatal(ack, err, ackCalls)
	}
	old.Path = filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)
	after, err := emptyRecoveryArchiveFiles(context.Background(), old)
	if err != nil || !equalEmptyRecoveryFiles(before, after) {
		t.Fatal("archive changed", err)
	}
	if _, err := prepareEmptyRecovery(context.Background(), in, func(chatport.HandoffPublication) error { t.Fatal("replayed ACK"); return nil }); err == nil {
		t.Fatal("recovery replay")
	}
	launch := NativeLaunch{Profile: in.Profile, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Home: in.Profile.Root, StoreMode: "open", SettingsMutations: true, HostLifetimeID: "normal-next-host", ChildLaunchID: "normal-next-child", PreviousHostDrainConfirmed: true}
	if runtime, err := NewNativeRuntime(context.Background(), launch, "normal-next"); err == nil {
		runtime.Close()
		t.Fatal("pending maintenance permitted runtime")
	}
	terminal := wire.CoreTerminalObservation{HandoffId: ack.HandoffId, ReceiptDigest: ack.ReceiptDigest, AckDigest: ack.AckDigest, BackendGeneration: in.Selection.Next.BackendGeneration, HostLifetimeId: in.Selection.HostLifetimeID, ChildLaunchId: in.Selection.ChildLaunchID, ExitCode: "0", Signal: "", Forced: false}
	if err := recordNativeTerminal(context.Background(), in.Profile, terminal, func(wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// Explicit qualified-host completion fixture. No fake Quit and no deletion
	// of old journals: the pending intent is retained beside its physical archive.
	if err := os.Rename(emptyRecoveryPendingPath(in.Profile.Root), filepath.Join(old.Path, "maintenance-intent.json")); err != nil {
		t.Fatal(err)
	}
	next, err := NewNativeRuntime(context.Background(), launch, "normal-next")
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func equalEmptyRecoveryFiles(a, b map[string]emptyRecoveryFile) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func TestNativeEmptyRecoveryPreparationLostACKFencesAndPreserves(t *testing.T) {
	in := emptyRecoveryFixture(t)
	computerPath := filepath.Join(in.Profile.Root, "computer", "computer-access.json")
	raw, err := os.ReadFile(computerPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	_, err = prepareEmptyRecovery(context.Background(), in, func(chatport.HandoffPublication) error { return errors.New("explicit lost ACK fixture") })
	if !errors.Is(err, handoff.Unknown) {
		t.Fatal("lost ACK not unknown", err)
	}
	if _, err := os.Lstat(emptyRecoveryPendingPath(in.Profile.Root)); err != nil {
		t.Fatal("pending fence missing", err)
	}
	if _, err := os.Lstat(filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID, "chat-lifecycle.json")); err != nil {
		t.Fatal("old state lost", err)
	}
	raw, err = os.ReadFile(computerPath)
	if err != nil || sha256.Sum256(raw) != sum {
		t.Fatal("Computer changed", err)
	}
	if err := refusePendingEmptyRecovery(in.Profile); err == nil {
		t.Fatal("unknown allowed runtime")
	}
}

func TestNativeEmptyRecoveryPreparationLateFailureRemainsUnknown(t *testing.T) {
	for _, kind := range []string{"archive", "task", "intent-replacement", "intent-symlink", "intent-fifo", "intent-hardlink"} {
		t.Run(kind, func(t *testing.T) {
			in := emptyRecoveryFixture(t)
			calls := 0
			ack, err := prepareEmptyRecovery(context.Background(), in, func(chatport.HandoffPublication) error {
				calls++
				intent := emptyRecoveryPendingPath(in.Profile.Root)
				switch kind {
				case "archive":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID, "chat-lifecycle.json"), []byte("changed"), 0600); err != nil {
						t.Fatal(err)
					}
				case "task":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "task", "late"), []byte("changed"), 0600); err != nil {
						t.Fatal(err)
					}
				default:
					raw, err := os.ReadFile(intent)
					if err != nil {
						t.Fatal(err)
					}
					retained := intent + ".original"
					if err := os.Rename(intent, retained); err != nil {
						t.Fatal(err)
					}
					var replaceErr error
					switch kind {
					case "intent-replacement":
						replaceErr = os.WriteFile(intent, raw, 0600)
					case "intent-symlink":
						replaceErr = os.Symlink(retained, intent)
					case "intent-fifo":
						replaceErr = unix.Mkfifo(intent, 0600)
					case "intent-hardlink":
						replaceErr = os.Link(retained, intent)
					}
					if replaceErr != nil {
						t.Fatal(replaceErr)
					}
				}
				return nil
			})
			if calls != 1 || !errors.Is(err, handoff.Unknown) || ack != (wire.CoreRetirementAcknowledged{}) {
				t.Fatal("late failure lost uncertainty", calls, ack, err)
			}
			if _, err := os.Lstat(emptyRecoveryPendingPath(in.Profile.Root)); err != nil {
				t.Fatal("pending evidence lost", err)
			}
			if err := refusePendingEmptyRecovery(in.Profile); err == nil {
				t.Fatal("late unknown allowed runtime")
			}
		})
	}
}
