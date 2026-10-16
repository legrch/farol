//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"golang.org/x/sys/unix"
)

var preservedProfileNative = flag.Bool("preserved-profile-native", false, "run retained native whole-profile preservation fixtures")

// Native repositories, actual File edit/read/ACK and actual Chat lifecycle/result
// owners; browser and Settings/consent are explicit doubles. No Electron, child
// exit, original host/descendant closure or installed maintenance is proved.
// Every fixture is retained, including failed/unknown attempts.
func preservedProfileFixture(t *testing.T, unresolved bool, withFile ...bool) (preservedProfileInspectionInput, string) {
	return preservedProfileFixtureAt(t, "", unresolved, withFile...)
}

// A native host producer may supply its own newly created retained private
// fixture parent. Ordinary test callers retain the original user-temp route.
func preservedProfileFixtureAt(t *testing.T, base string, unresolved bool, withFile ...bool) (preservedProfileInspectionInput, string) {
	t.Helper()
	if !*preservedProfileNative {
		t.Skip("requires -preserved-profile-native")
	}
	parent, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if base == "" {
		base, err = os.MkdirTemp(parent, "farol-preserved-profile-")
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Log("retained fixture:", base)
	root := filepath.Join(base, "Farol Dev", "farol-next-state", "go-core")
	for _, name := range []string{"computer/mutations", "chat", "task"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	var st unix.Stat_t
	if err := unix.Lstat(root, &st); err != nil {
		t.Fatal(err)
	}
	launch := NativeLaunch{Profile: ProfileBinding{ProfileID: freshEmptyRecoveryFixtureUUID(t), Root: root, Device: uint64(st.Dev), Inode: st.Ino}, OwnerID: "owner", ComputerID: freshEmptyRecoveryFixtureUUID(t), Home: base, StoreMode: "create", HostLifetimeID: "original-fixture-host", ChildLaunchID: "original-fixture-child", SettingsMutations: true}
	runtime, err := NewNativeRuntime(context.Background(), launch, "original-generation")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Error(err)
		}
	})
	runtime.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, Generation: 1}}}
	workspace := filepath.Join(base, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(workspace, "note.md")
	const original = "one old fragment\n"
	if err := os.WriteFile(target, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	doFile := len(withFile) == 0 || withFile[0]
	operationID := freshEmptyRecoveryFixtureUUID(t)
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	before := sha256.Sum256([]byte(original))
	if doFile {
		request := wire.ComputerSettingsEditRequest{Publication: publication, WorkspaceId: "00000000-0000-4000-8000-000000000004", RelativePath: "note.md", ExpectedSHA256: hex.EncodeToString(before[:]), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}}
		out := nativeSettingsCall(t, runtime, "computer.settings.delivery.apply", operationID, wire.SettingsDeliveryApply{DeadlineMillis: fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli()), Request: request})
		var offered wire.SettingsDeliveryResult
		if out.Status != "ok" || json.Unmarshal(out.Data, &offered) != nil || offered.Result == nil || offered.Result.Phase != "completed" || offered.ReceiptId == nil {
			t.Fatal("actual File edit did not settle", out.Status, string(out.Data))
		}
		raw, err := os.ReadFile(target)
		if err != nil || string(raw) != "one new fragment\n" {
			t.Fatal("actual File bytes missing", err)
		}
		if nativeSettingsCall(t, runtime, "computer.settings.delivery.ack", "native-preserved-file-ack", wire.SettingsDeliveryACK{DeadlineMillis: fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli()), ReceiptId: *offered.ReceiptId, Pending: offered.Pending}).Status != "ok" {
			t.Fatal("actual File ACK refused")
		}
	}
	peer := &retainedNativePeer{t: t, runtime: runtime}
	input := chatport.ConversationInput{Binding: chatport.TurnBinding{ProfileID: launch.Profile.ProfileID, BackendGeneration: "original-generation", OwnerID: launch.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", OperationID: "operation-1", TurnID: "turn-1", TurnGeneration: 1}, Selection: chatport.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "controlled-account", ModelID: "controlled-model", Effort: "low"}, Required: chatport.RequiredControls{Model: true}, Prompt: "Synthetic preservation qualification"}
	ctx := context.Background()
	conversation, err := runtime.chat.CreateConversation(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		peer.run(func(d uint64) error { _, err := runtime.chat.PrepareNext(ctx, d); return err }, "prepare")
		peer.run(func(d uint64) error { return conversation.Send(ctx, d) }, "verify-send", "send")
		for _, kind := range []string{"accepted", "answer-delta", "completed"} {
			peer.run(func(d uint64) error { return conversation.Observe(ctx, d) }, kind)
		}
		result, err := conversation.Result(ctx)
		if err != nil || !result.Complete {
			t.Fatal("missing original result", err)
		}
		if err := conversation.Acknowledge(ctx, result.ResultID); err != nil {
			t.Fatal(err)
		}
		peer.run(func(d uint64) error { return conversation.Observe(ctx, d) }, "quiescent")
		if n == 0 {
			input.Binding.OperationID, input.Binding.TurnID, input.Binding.TurnGeneration = "operation-2", "turn-2", 2
			conversation, err = runtime.chat.FollowConversation(ctx, conversation, input)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if peer.sends != 2 {
		t.Fatal("unexpected browser fixture Send count")
	}
	// Deliberately no old Retire, initiating ACK or terminal recorder.
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	if unresolved {
		if err := os.WriteFile(filepath.Join(root, "chat", "chat-results", "chat-results.unknown"), []byte("UNKNOWN"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	bounded, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q, err := QualifyProfile(launch.Profile)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	computer, chat, err := q.Roots()
	if err != nil {
		t.Fatal(err)
	}
	scope := chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: "original-generation"}
	h, err := handoffrepo.AcquirePreservationInspection(bounded, handoffRoots(launch, chat), scope)
	if err != nil {
		t.Fatal(err)
	}
	hv, err := h.Observation()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	l, err := lifecyclerepo.AcquirePreservationInspection(bounded, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, scope, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
	if err != nil {
		t.Fatal(err)
	}
	lv, err := l.Observation()
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := results.AcquirePreservationInspection(bounded, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: lv.Root}, scope, results.TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	rv, err := r.Observation()
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	access, err := os.ReadFile(filepath.Join(computer.Path, "computer-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected []mutationrepo.ExpectedOwnerRecord
	if doFile {
		names, err := os.ReadDir(filepath.Join(computer.Path, "mutations"))
		if err != nil || len(names) != 1 {
			t.Fatal("fixture expected exactly its one native File journal", err)
		}
		key := names[0].Name()
		record, err := os.ReadFile(filepath.Join(computer.Path, "mutations", key))
		if err != nil {
			t.Fatal(err)
		}
		var stored struct {
			SchemaVersion int
			Kind          string
			Record        struct {
				Identity                                 domain.Identity
				ComputerGeneration                       uint64
				WorkspaceID, RelativePath, RequestDigest string
				Phase                                    string
			}
		}
		if json.Unmarshal(record, &stored) != nil || stored.SchemaVersion != 2 || stored.Kind != "workspace_owner_mutation" || stored.Record.Phase != "completed" || stored.Record.Identity.OperationID != operationID {
			t.Fatal("unexpected native File record")
		}
		binding := domain.Binding{Identity: stored.Record.Identity, ComputerGeneration: stored.Record.ComputerGeneration, WorkspaceID: stored.Record.WorkspaceID, RelativePath: stored.Record.RelativePath, RequestDigest: stored.Record.RequestDigest}
		digest := sha256.Sum256(record)
		expected = []mutationrepo.ExpectedOwnerRecord{{Key: key, SHA256: hex.EncodeToString(digest[:]), Binding: binding}}
	}
	in := preservedProfileInspectionInput{Profile: launch.Profile, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, AccessDigest: sha256.Sum256(access), Mutations: expected, Selection: chatport.PreservedRecoverySelection{OperationID: freshEmptyRecoveryFixtureUUID(t), Current: chatport.PreservedRecoveryBinding{Scope: scope, ParentRoot: hv.ParentRoot, ChatRoot: hv.ChatRoot}, Next: chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: "fresh-maintenance-generation"}, BuildID: BuildID, HostLifetimeID: "new-maintenance-host", ChildLaunchID: "new-maintenance-child", HandoffDigest: hv.HeadDigest, LifecycleDigest: lv.SnapshotDigest, ResultsDigest: rv.SnapshotDigest}}
	return in, workspace
}

func TestPreservedProfileNativeCompositeRetainsClaimsAndBytes(t *testing.T) {
	in, workspace := preservedProfileFixture(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	before := recoverySnapshot(t, in.Profile.Root)
	fileBefore, err := os.ReadFile(filepath.Join(workspace, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	visits := 0
	err = inspectPreservedProfile(ctx, in, func(v preservedProfileInspection) error {
		visits++
		if v.Lifecycle.TurnCount != 2 || v.Results.ResultCount != 2 || !v.Results.Unresolved || v.Mutations == nil || len(v.Mutations.Retained) != 1 || !v.Plan.RetainsUnresolvedResults {
			t.Fatal("lost actual nonempty/UNKNOWN metadata")
		}
		paths := []string{"computer/computer-access.lock", "chat/chat-handoff.claim", "chat/chat-lifecycle.claim", "chat/chat-results/chat-results.claim", "computer/.mutation-writer.lock"}
		for _, name := range paths {
			fd, err := unix.Open(filepath.Join(in.Profile.Root, name), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			lockErr := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
			closeErr := unix.Close(fd)
			if lockErr != unix.EWOULDBLOCK || closeErr != nil {
				t.Fatal("composite released an original claim", name, lockErr, closeErr)
			}
		}
		return nil
	})
	if err != nil || visits != 1 {
		t.Fatal("native composite refused", err, visits)
	}
	after := recoverySnapshot(t, in.Profile.Root)
	fileAfter, err := os.ReadFile(filepath.Join(workspace, "note.md"))
	if err != nil || !reflect.DeepEqual(before, after) || string(fileBefore) != string(fileAfter) {
		t.Fatal("read-only composite changed original state", err)
	}
}

func TestPreservedProfileNativeRefusesFinalChangeAndCancellation(t *testing.T) {
	for _, fault := range []string{"profile-staging", "metadata-added", "task-staging", "chat-staging", "mutation-staging", "cancel", "lagging-expiry", "visitor-error"} {
		t.Run(fault, func(t *testing.T) {
			in, _ := preservedProfileFixture(t, false)
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			deadline := time.Now().Add(10 * time.Second)
			if fault == "lagging-expiry" {
				deadline = time.Now().Add(300 * time.Millisecond)
			}
			lag := &preservedProfileLagContext{Context: parent, until: deadline}
			sentinel := errors.New("trusted visitor refused")
			visits := 0
			var before map[string]string
			err := inspectPreservedProfile(lag, in, func(preservedProfileInspection) error {
				visits++
				switch fault {
				case "profile-staging":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, ".unknown"), []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				case "metadata-added":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "profile.json"), []byte("{}"), 0600); err != nil {
						t.Fatal(err)
					}
				case "task-staging":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "task", ".unknown"), []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				case "chat-staging":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "chat", ".unknown"), []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				case "mutation-staging":
					if err := os.WriteFile(filepath.Join(in.Profile.Root, "computer", "mutations", ".unknown"), []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				case "cancel":
					cancel()
				case "lagging-expiry":
					time.Sleep(time.Until(deadline) + time.Millisecond)
				}
				before = recoverySnapshot(t, in.Profile.Root)
				return sentinel
			})
			if err == nil || visits != 1 || !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
				t.Fatal("final refusal or custody lost", err, visits)
			}
			// The common access boundary classifies callback errors; no original error
			// string is promoted into settlement or a successful partial observation.
			if lag.reads != 1 {
				t.Fatal("original deadline reread", lag.reads)
			}
		})
	}
}

func TestPreservedProfileNativePreparationArchivesUnknownWithoutOldRetirement(t *testing.T) {
	in, _ := preservedProfileFixture(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var original map[string]emptyRecoveryFile
	var oldChat NativeRoot
	if err := inspectPreservedProfile(ctx, in, func(v preservedProfileInspection) error {
		oldChat = v.Chat
		var err error
		original, err = emptyRecoveryArchiveFiles(ctx, v.Chat)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	ack, err := preparePreservedProfileRecovery(ctx, in, func(p chatport.HandoffPublication) error {
		calls++
		if p.Binding.BackendGeneration != in.Selection.Next.BackendGeneration || p.Binding.ChatRoot == in.Selection.Current.ChatRoot || p.Binding.HostLifetimeID != in.Selection.HostLifetimeID {
			t.Fatal("new maintenance attributed to original lifetime")
		}
		return nil // Explicit host-ACK fixture; not a native child/host proof.
	})
	if err != nil || calls != 1 || ack.HandoffId == "" {
		t.Fatal("native archive preparation refused", err, calls)
	}
	archived := oldChat
	archived.Path = filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)
	current, err := emptyRecoveryArchiveFiles(ctx, archived)
	if err != nil || !reflect.DeepEqual(original, current) {
		t.Fatal("original nonempty/UNKNOWN archive changed", err)
	}
	if _, err := os.Lstat(emptyRecoveryPendingPath(in.Profile.Root)); err != nil {
		t.Fatal("pending fence removed before real terminal", err)
	}
	before := recoverySnapshot(t, in.Profile.Root)
	if _, err := preparePreservedProfileRecovery(ctx, in, func(chatport.HandoffPublication) error { t.Fatal("second maintenance initiated"); return nil }); err == nil {
		t.Fatal("original maintenance replayed")
	}
	if !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
		t.Fatal("refused second call changed new state")
	}
}

func TestPreservedProfileNativeEmptyMutationBranchKeepsChat(t *testing.T) {
	in, workspace := preservedProfileFixture(t, false, false)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	before := recoverySnapshot(t, in.Profile.Root)
	visits := 0
	err := inspectPreservedProfile(ctx, in, func(v preservedProfileInspection) error {
		visits++
		if v.EmptyMutations == nil || v.Mutations != nil || v.Results.ResultCount != 2 || v.Lifecycle.TurnCount != 2 {
			t.Fatal("empty Computer discarded nonempty Chat")
		}
		return nil
	})
	raw, readErr := os.ReadFile(filepath.Join(workspace, "note.md"))
	if err != nil || readErr != nil || visits != 1 || string(raw) != "one old fragment\n" || !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
		t.Fatal("empty mutation branch changed existing state", err, readErr, visits)
	}
}

func TestPreservedProfileNativeUnconfirmedInitiatingACKKeepsFence(t *testing.T) {
	for _, fault := range []string{"ack-lost", "lagging-expiry"} {
		t.Run(fault, func(t *testing.T) {
			in, workspace := preservedProfileFixture(t, true)
			parent := &preservedProfileLagContext{Context: context.Background(), until: time.Now().Add(10 * time.Second)}
			if fault == "lagging-expiry" {
				parent.until = time.Now().Add(time.Second)
			}
			fileBefore, err := os.ReadFile(filepath.Join(workspace, "note.md"))
			if err != nil {
				t.Fatal(err)
			}
			var chat NativeRoot
			var original map[string]emptyRecoveryFile
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := inspectPreservedProfile(ctx, in, func(v preservedProfileInspection) error {
				chat = v.Chat
				var err error
				original, err = emptyRecoveryArchiveFiles(ctx, v.Chat)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			calls := 0
			ack, err := preparePreservedProfileRecovery(parent, in, func(chatport.HandoffPublication) error {
				calls++
				if fault == "ack-lost" {
					return errors.New("initiating ACK unavailable")
				}
				time.Sleep(time.Until(parent.until) + time.Millisecond)
				return nil
			})
			if err == nil || calls != 1 || ack.HandoffId != "" {
				t.Fatal("unconfirmed ACK became success", err, calls, ack)
			}
			if parent.reads != 1 || parent.Err() != nil {
				t.Fatal("did not exercise the fixed original deadline", parent.reads, parent.Err())
			}
			chat.Path = filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)
			archived, err := emptyRecoveryArchiveFiles(ctx, chat)
			if err != nil || !reflect.DeepEqual(original, archived) {
				t.Fatal("failed preparation lost original archive", err)
			}
			if _, err := os.Lstat(emptyRecoveryPendingPath(in.Profile.Root)); err != nil {
				t.Fatal("lost permanent intent", err)
			}
			before := recoverySnapshot(t, in.Profile.Root)
			unexpected, err := NewNativeRuntime(context.Background(), NativeLaunch{Profile: in.Profile, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Home: filepath.Dir(workspace), StoreMode: "open", HostLifetimeID: "withheld-host", ChildLaunchID: "withheld-child", PreviousHostDrainConfirmed: true, SettingsMutations: true}, "withheld-generation")
			if unexpected != nil {
				if closeErr := unexpected.Close(); closeErr != nil {
					t.Error(closeErr)
				}
				t.Fatal("pending unknown maintenance returned a normal writer")
			}
			if err == nil {
				t.Fatal("pending unknown maintenance admitted a normal writer")
			}
			raw, err := os.ReadFile(filepath.Join(workspace, "note.md"))
			if err != nil || string(raw) != string(fileBefore) || !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
				t.Fatal("refused writer changed existing state", err)
			}
		})
	}
}

func TestPreservedProfileNativePriorArchiveAndMetadataStayExact(t *testing.T) {
	in, _ := preservedProfileFixture(t, true)
	prior := filepath.Join(in.Profile.Root, "chat-retired-"+freshEmptyRecoveryFixtureUUID(t))
	if err := os.Mkdir(prior, 0700); err != nil {
		t.Fatal(err)
	}
	held := filepath.Join(prior, "retained.unknown")
	if err := os.WriteFile(held, []byte("UNKNOWN"), 0600); err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(in.Profile.Root, "profile.json")
	if err := os.WriteFile(metadata, []byte("{\"fixture\":\"opaque-metadata-custody\"}"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	priorStat := unix.Stat_t{}
	metaStat := unix.Stat_t{}
	if unix.Lstat(prior, &priorStat) != nil || unix.Lstat(metadata, &metaStat) != nil {
		t.Fatal("prior custody observation failed")
	}
	ack, err := preparePreservedProfileRecovery(ctx, in, func(chatport.HandoffPublication) error { return nil })
	if err != nil || ack.HandoffId == "" {
		t.Fatal("prior immutable archive blocked qualified new preservation", err)
	}
	var afterPrior, afterMeta unix.Stat_t
	if unix.Lstat(prior, &afterPrior) != nil || unix.Lstat(metadata, &afterMeta) != nil || !sameEmptyRecoveryStat(priorStat, afterPrior) || !sameEmptyRecoveryStat(metaStat, afterMeta) {
		t.Fatal("prior archive or metadata version changed")
	}
	raw, err := os.ReadFile(held)
	if err != nil || string(raw) != "UNKNOWN" {
		t.Fatal("prior unknown was lost", err)
	}
}

func TestPreservedProfileNativeRefusesChangedPriorArchive(t *testing.T) {
	in, _ := preservedProfileFixture(t, false)
	prior := filepath.Join(in.Profile.Root, "chat-retired-"+freshEmptyRecoveryFixtureUUID(t))
	if err := os.Mkdir(prior, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(prior, "retained.unknown")
	if err := os.WriteFile(file, []byte("UNKNOWN"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	visits := 0
	err := inspectPreservedProfile(ctx, in, func(preservedProfileInspection) error { visits++; return os.WriteFile(file, []byte("changed"), 0600) })
	if err == nil || visits != 1 {
		t.Fatal("opaque prior archive mutation escaped full final custody", err, visits)
	}
	raw, err := os.ReadFile(file)
	if err != nil || string(raw) != "changed" {
		t.Fatal("refusal repaired or discarded changed evidence", err)
	}
}
