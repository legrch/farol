//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"golang.org/x/sys/unix"
)

// Real disposable native stores and boot composition; terminal facts are explicit
// fixtures here. Actual child close/recorder is covered by the TS host integration.
func retirementFixture(t *testing.T) (NativeLaunch, *NativeRuntime) {
	return retirementStorageFixture(t, false)
}
func retirementStorageFixture(t *testing.T, mutations bool) (NativeLaunch, *NativeRuntime) {
	return retirementStorageFixtureAt(t, mutations, false)
}
func retirementStorageFixtureAt(t *testing.T, mutations, desktopLayout bool, desktopName ...string) (NativeLaunch, *NativeRuntime) {
	t.Helper()
	if !*ingressNative {
		t.Skip("Requires exclusive native lane and -ingress-native")
	}
	parent := filepath.Join("..", "_output", "tmp")
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(parent, "retirement-boot-")
	if err != nil {
		t.Fatal(err)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	cleanupRoot := root
	t.Cleanup(func() {
		if !t.Failed() {
			if err := os.RemoveAll(cleanupRoot); err != nil {
				t.Error(err)
			}
		}
	})
	if desktopLayout {
		name := "Farol Dev"
		if len(desktopName) == 1 {
			name = desktopName[0]
		}
		root = filepath.Join(root, name, "farol-state", "go-core")
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, child := range []string{"computer", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(root, child), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if mutations {
		if err := os.Mkdir(filepath.Join(root, "computer", "mutations"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	var st unix.Stat_t
	if err := unix.Lstat(root, &st); err != nil {
		t.Fatal(err)
	}
	launch := NativeLaunch{Profile: ProfileBinding{ProfileID: "retirement-profile", Root: root, Device: uint64(st.Dev), Inode: st.Ino}, OwnerID: "owner", ComputerID: "computer", Home: root, StoreMode: "create", HostLifetimeID: "host-1", ChildLaunchID: "child-1"}
	launch.SettingsMutations = mutations
	if mutations {
		launch.Profile.ProfileID = "00000000-0000-4000-8000-000000000001"
		launch.ComputerID = "00000000-0000-4000-8000-000000000002"
		if desktopLayout {
			launch.Profile.ProfileID = freshEmptyRecoveryFixtureUUID(t)
			launch.ComputerID = freshEmptyRecoveryFixtureUUID(t)
		}
	}
	runtime, err := NewNativeRuntime(context.Background(), launch, "generation-1")
	if err != nil {
		t.Fatal(err)
	}
	if mutations {
		runtime.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, Generation: 1}}}
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Error(err)
		}
	})
	return launch, runtime
}
func preparedTerminal(t *testing.T, runtime *NativeRuntime) wire.CoreTerminalObservation {
	t.Helper()
	prepared := retirementCall(t, runtime, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "handoff-1"})
	if prepared.Status != "ok" {
		t.Fatalf("prepare: %+v", prepared)
	}
	var publication wire.CoreRetirementPrepared
	if json.Unmarshal(prepared.Data, &publication) != nil {
		t.Fatal("prepare decode")
	}
	ack := retirementCall(t, runtime, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: publication.HandoffId, ReceiptDigest: publication.ReceiptDigest})
	if ack.Status != "ok" {
		t.Fatalf("ACK: %+v", ack)
	}
	var known wire.CoreRetirementAcknowledged
	if json.Unmarshal(ack.Data, &known) != nil {
		t.Fatal("ACK decode")
	}
	if repeated := retirementCall(t, runtime, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "handoff-2"}); repeated.Status == "ok" {
		t.Fatal("prepare replay")
	}
	if repeated := retirementCall(t, runtime, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: publication.HandoffId, ReceiptDigest: publication.ReceiptDigest}); repeated.Status == "ok" {
		t.Fatal("ACK replay")
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	return wire.CoreTerminalObservation{HandoffId: known.HandoffId, ReceiptDigest: known.ReceiptDigest, AckDigest: known.AckDigest, BackendGeneration: "generation-1", HostLifetimeId: "host-1", ChildLaunchId: "child-1", ExitCode: "0", Signal: "", Forced: false}
}
func TestNativeRetirementRecorderReplyFailureFencesNextLifetime(t *testing.T) {
	for _, failure := range []string{"write", "late"} {
		t.Run(failure, func(t *testing.T) {
			launch, runtime := retirementFixture(t)
			observation := preparedTerminal(t, runtime)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			err := recordNativeTerminal(ctx, launch.Profile, observation, func(wire.CoreRetirementAcknowledged) error {
				if failure == "late" {
					cancel()
					return nil
				}
				return io.ErrClosedPipe
			})
			if err == nil {
				t.Fatal("lost recorder reply accepted")
			}
			launch.StoreMode = "open"
			launch.HostLifetimeID, launch.ChildLaunchID = "host-2", "child-2"
			launch.PreviousHostDrainConfirmed = true // Even a bad caller cannot erase durable UNKNOWN.
			next, err := NewNativeRuntime(context.Background(), launch, "generation-2")
			if next != nil {
				next.Close()
				t.Fatal("UNKNOWN reopened")
			}
			if err == nil {
				t.Fatal("missing refusal")
			}
		})
	}
}
func TestNativeRetirementRequiresIndependentPreviousHostDrain(t *testing.T) {
	launch, runtime := retirementFixture(t)
	observation := preparedTerminal(t, runtime)
	if err := recordNativeTerminal(context.Background(), launch.Profile, observation, func(wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode = "open"
	launch.HostLifetimeID, launch.ChildLaunchID = "host-2", "child-2"
	next, err := NewNativeRuntime(context.Background(), launch, "generation-2")
	if next != nil {
		next.Close()
		t.Fatal("terminal bytes replaced missing host drain witness")
	}
	if err == nil {
		t.Fatal("missing refusal")
	}
}
func TestNativeRetirementRefusesForcedTerminalAndMalformedDigest(t *testing.T) {
	for _, fault := range []string{"forced", "digest", "signal", "nonzero", "unknown"} {
		t.Run(fault, func(t *testing.T) {
			launch, runtime := retirementFixture(t)
			observation := preparedTerminal(t, runtime)
			switch fault {
			case "forced":
				observation.Forced = true
			case "digest":
				observation.AckDigest = "00"
			case "signal":
				observation.Signal = "SIGTERM"
			case "nonzero":
				observation.ExitCode = "1"
			case "unknown":
				observation.ExitCode = ""
			}
			calls := 0
			err := recordNativeTerminal(context.Background(), launch.Profile, observation, func(wire.CoreRetirementAcknowledged) error { calls++; return errors.New("must not reply") })
			if err == nil || calls != 0 {
				t.Fatal("invalid terminal was published")
			}
		})
	}
}
