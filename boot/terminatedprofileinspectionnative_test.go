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
	"reflect"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"golang.org/x/sys/unix"
)

// New disposable profile; every root is retained, even on known success. Actual
// NativeRuntime/Retire/ACK/recorder/store owners are used, but child exit, host
// drain, Settings and completed File receipts are explicit fixtures. This cannot
// qualify an installed app, helper restore, real file effect or process closure.
func terminatedProfileNativeFixture(t *testing.T, ancestor bool) terminatedProfileInspectionInput {
	t.Helper()
	if !*ingressNative {
		t.Skip("requires explicit Lead -ingress-native lane")
	}
	base, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "farol-terminated-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true terminal=synthetic process_closure=unproven", root)
	for _, name := range []string{"computer", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "computer", "mutations"), 0700); err != nil {
		t.Fatal(err)
	}
	var identity unix.Stat_t
	if err := unix.Lstat(root, &identity); err != nil {
		t.Fatal(err)
	}
	launch := NativeLaunch{Profile: ProfileBinding{ProfileID: freshEmptyRecoveryFixtureUUID(t), Root: root, Device: uint64(identity.Dev), Inode: identity.Ino}, OwnerID: "owner", ComputerID: freshEmptyRecoveryFixtureUUID(t), Home: root, StoreMode: "create", SettingsMutations: true}
	cycles := 1
	if ancestor {
		cycles = 2
	}
	var last wire.CoreTerminalObservation
	for n := 1; n <= cycles; n++ {
		generation := fmt.Sprintf("fixture-generation-%d", n)
		launch.HostLifetimeID, launch.ChildLaunchID = fmt.Sprintf("fixture-host-%d", n), fmt.Sprintf("fixture-child-%d", n)
		runtime, err := NewNativeRuntime(context.Background(), launch, generation)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := runtime.Close(); err != nil {
				t.Error(err)
			}
		})
		runtime.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, Generation: 1}}}
		prepared := retirementCall(t, runtime, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: fmt.Sprintf("fixture-handoff-%d", n)})
		var publication wire.CoreRetirementPrepared
		if prepared.Status != "ok" || json.Unmarshal(prepared.Data, &publication) != nil {
			t.Fatal("original preparation refused", prepared.Status)
		}
		ack := retirementCall(t, runtime, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: publication.HandoffId, ReceiptDigest: publication.ReceiptDigest})
		var known wire.CoreRetirementAcknowledged
		if ack.Status != "ok" || json.Unmarshal(ack.Data, &known) != nil {
			t.Fatal("original ACK refused", ack.Status)
		}
		if err := runtime.Close(); err != nil {
			t.Fatal(err)
		}
		last = wire.CoreTerminalObservation{HandoffId: known.HandoffId, ReceiptDigest: known.ReceiptDigest, AckDigest: known.AckDigest, BackendGeneration: generation, HostLifetimeId: launch.HostLifetimeID, ChildLaunchId: launch.ChildLaunchID, ExitCode: "0", Signal: "", Forced: false}
		if err := recordNativeTerminal(context.Background(), launch.Profile, last, func(wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
			t.Fatal(err)
		}
		launch.StoreMode, launch.PreviousHostDrainConfirmed = "open", true // Explicit fixture; not process proof.
	}
	qualified, err := QualifyProfile(launch.Profile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := qualified.Close(); err != nil {
			t.Error(err)
		}
	})
	computer, chat, err := qualified.Roots()
	if err != nil {
		t.Fatal(err)
	}
	h, err := handoffrepo.AcquireTerminatedRetirementInspection(context.Background(), handoffRoots(launch, chat), chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: last.BackendGeneration})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	hv, err := h.Observation()
	if err != nil || h.Verify() != nil {
		t.Fatal("fixture original head unavailable", err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	ackRaw, err := hex.DecodeString(last.AckDigest)
	if err != nil || len(ackRaw) != 32 {
		t.Fatal("original ACK digest malformed", err)
	}
	in := terminatedProfileInspectionInput{Profile: launch.Profile, Publication: hv.Publication, KnownACKDigest: [32]byte(ackRaw), OwnerID: launch.OwnerID, ComputerID: launch.ComputerID}
	m, err := mutationrepo.New(context.Background(), mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := m.Close(); err != nil {
			t.Error(err)
		}
	})
	for _, kind := range []domain.Kind{domain.WriteKind, domain.EditKind} {
		operation := string(kind) + "-fixture"
		b := domain.Binding{Identity: domain.Identity{Scope: domain.ScopeConnector, OperationID: operation, OwnerID: launch.OwnerID, ProfileID: launch.Profile.ProfileID, ComputerID: launch.ComputerID}, WorkspaceID: "synthetic", ComputerGeneration: 1, RelativePath: operation + ".md", RequestDigest: strings.Repeat("a", 64), Connector: domain.ConnectorOrigin{BuildID: BuildID, BackendGeneration: last.BackendGeneration, RuntimeID: "synthetic-runtime", ConnectorGeneration: 1, SessionID: "synthetic-session", TaskID: "synthetic-task", ParticipantID: "synthetic-participant", TurnID: "synthetic-turn", CallID: operation, TaskEpoch: 1, Generation: 1, Operation: kind}}
		prepared, err := domain.NewPrepared(b)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := m.Admit(context.Background(), prepared); err != nil {
			t.Fatal(err)
		}
		receipt := domain.Receipt{Operation: kind, RelativePath: b.RelativePath, Bytes: 1, AfterSHA256: strings.Repeat("b", 64)}
		if kind == domain.EditKind {
			before := strings.Repeat("c", 64)
			receipt.BeforeSHA256, receipt.Replacements = &before, 1
		}
		complete, err := prepared.Complete(receipt)
		if err != nil {
			t.Fatal(err)
		}
		if err := m.Save(context.Background(), complete); err != nil {
			t.Fatal(err)
		}
		keyInput, err := json.Marshal([]string{"external-connector-v3", operation, launch.OwnerID, launch.Profile.ProfileID, launch.ComputerID})
		if err != nil {
			t.Fatal(err)
		}
		keySHA := sha256.Sum256(keyInput)
		key := hex.EncodeToString(keySHA[:]) + ".json"
		raw, err := os.ReadFile(filepath.Join(computer.Path, "mutations", key))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(raw)
		in.Mutations = append(in.Mutations, mutationrepo.ExpectedSettledRecord{Key: key, SHA256: hex.EncodeToString(digest[:]), Binding: b})
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(computer.Path, "computer-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	in.AccessDigest = sha256.Sum256(raw)
	if err := qualified.Close(); err != nil {
		t.Fatal(err)
	}
	return in
}

type terminatedProfileNativeEntry struct {
	Device, Inode uint64
	UID, Mode     uint32
	Size          int64
	Digest        [32]byte
}

func terminatedProfileNativeInventory(t *testing.T, root string) map[string]terminatedProfileNativeEntry {
	t.Helper()
	values := make(map[string]terminatedProfileNativeEntry)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			return err
		}
		v := terminatedProfileNativeEntry{Device: uint64(s.Dev), Inode: s.Ino, UID: s.Uid, Mode: uint32(s.Mode), Size: s.Size}
		if !entry.IsDir() {
			if uint32(s.Mode)&unix.S_IFMT != unix.S_IFREG || s.Nlink != 1 {
				return fmt.Errorf("unexpected fixture object")
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			v.Digest = sha256.Sum256(raw)
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		values[rel] = v
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func TestNativeTerminatedProfileInspectionOriginalOwnersAndExactClaims(t *testing.T) {
	for _, ancestor := range []bool{false, true} {
		t.Run(fmt.Sprintf("ancestor=%t", ancestor), func(t *testing.T) {
			in := terminatedProfileNativeFixture(t, ancestor)
			before := terminatedProfileNativeInventory(t, in.Profile.Root)
			calls := 0
			err := inspectTerminatedProfile(context.Background(), in, func(v terminatedProfileInspection) error {
				calls++
				steps := 3
				if ancestor {
					steps = 7
				}
				if v.Scope != (chatport.JournalScope{ProfileID: in.Profile.ProfileID, BackendGeneration: in.Publication.Binding.BackendGeneration}) || v.HandoffSteps != steps || v.LifecycleDigest != in.Publication.ReceiptDigest || v.Access.Digest != in.AccessDigest || v.HandoffDigest == ([32]byte{}) || len(v.Retained.Retained) != 2 {
					t.Fatal("joined metadata differs")
				}
				if err := accessrepo.WithClosedInspection(context.Background(), v.Computer.Path, v.Access.Binding, in.AccessDigest, func(accessrepo.ClosedInspection) error { t.Fatal("visitor lost access lock"); return nil }); err == nil {
					t.Fatal("visitor lost access lock")
				}
				if lease, err := handoffrepo.AcquireTerminatedRetirementInspection(context.Background(), handoffRoots(NativeLaunch{Profile: in.Profile}, v.Chat), v.Scope); err == nil {
					lease.Close()
					t.Fatal("visitor lost handoff claim")
				}
				if _, err := mutationrepo.InspectSettled(context.Background(), v.Retained.Root, mutationrepo.SettledSelection{OwnerID: in.OwnerID, ProfileID: in.Profile.ProfileID, ComputerID: in.ComputerID}, in.Mutations, func(mutationrepo.SettledInspection) error { t.Fatal("visitor lost mutation writer lock"); return nil }); err == nil {
					t.Fatal("overlapping mutation inspection accepted")
				}
				return nil
			})
			if err != nil || calls != 1 {
				t.Fatal("normal closed inspection refused", err, calls)
			}
			if !reflect.DeepEqual(before, terminatedProfileNativeInventory(t, in.Profile.Root)) {
				t.Fatal("inspection changed original profile bytes/identities")
			}
			if err := inspectTerminatedProfile(context.Background(), in, func(terminatedProfileInspection) error { return nil }); err != nil {
				t.Fatal("inspection leaked original claim", err)
			}
		})
		if t.Failed() {
			return
		}
	}
}

func TestNativeTerminatedProfileInspectionRefusesAndPreserves(t *testing.T) {
	for _, kind := range []string{"selected-ack", "selected-publication", "access-digest", "mutation-digest", "unknown", "task-entry", "chat-staging", "late-task", "cancelled-visitor"} {
		t.Run(kind, func(t *testing.T) {
			in := terminatedProfileNativeFixture(t, true)
			switch kind {
			case "selected-ack":
				in.KnownACKDigest[0]++
			case "selected-publication":
				in.Publication.Binding.ChildLaunchID = "other-original"
			case "access-digest":
				in.AccessDigest[0]++
			case "mutation-digest":
				in.Mutations[0].SHA256 = strings.Repeat("f", 64)
			case "unknown":
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "chat", "chat-handoff.unknown"), []byte("synthetic unknown"), 0600); err != nil {
					t.Fatal(err)
				}
			case "task-entry":
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "task", "unexpected"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "chat-staging":
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "chat", ".chat-handoff-staging"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := terminatedProfileNativeInventory(t, in.Profile.Root)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			err := inspectTerminatedProfile(ctx, in, func(terminatedProfileInspection) error {
				calls++
				if kind == "late-task" {
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "task", "late"), nil, 0600); err != nil {
						t.Fatal(err)
					}
					before = terminatedProfileNativeInventory(t, in.Profile.Root)
				}
				if kind == "cancelled-visitor" {
					cancel()
				}
				return nil
			})
			wantCalls := 0
			if kind == "late-task" || kind == "cancelled-visitor" {
				wantCalls = 1
			}
			if err == nil || calls != wantCalls {
				t.Fatal("unsettled/unjoined profile accepted", err, calls)
			}
			if !reflect.DeepEqual(before, terminatedProfileNativeInventory(t, in.Profile.Root)) {
				t.Fatal("refusal changed retained original profile")
			}
		})
		if t.Failed() {
			return
		}
	}
}
