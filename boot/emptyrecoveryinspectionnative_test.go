//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Real native stores/claims and original empty Retire/Capture. The previous
// child terminal is an explicit fixture, not host/process/maintenance proof.
func emptyRecoveryFixture(t *testing.T) emptyRecoveryInspectionInput {
	return emptyRecoveryFixtureAt(t, true)
}
func emptyRecoveryFixtureAt(t *testing.T, desktopLayout bool) emptyRecoveryInspectionInput {
	return emptyRecoveryFixtureStateAt(t, desktopLayout, false)
}
func emptyRecoveryFixtureStateAt(t *testing.T, desktopLayout, interrupted bool, unacknowledged ...bool) emptyRecoveryInspectionInput {
	return emptyRecoveryFixtureNamed(t, desktopLayout, interrupted, "Farol Dev", unacknowledged...)
}
func emptyRecoveryFixtureNamed(t *testing.T, desktopLayout, interrupted bool, name string, unacknowledged ...bool) emptyRecoveryInspectionInput {
	return emptyRecoveryFixtureWithMutations(t, desktopLayout, interrupted, name, true, unacknowledged...)
}

func emptyRecoveryFixtureWithMutations(t *testing.T, desktopLayout, interrupted bool, name string, mutations bool, unacknowledged ...bool) emptyRecoveryInspectionInput {
	fiveResults := interrupted || len(unacknowledged) == 1 && unacknowledged[0]
	t.Helper()
	launch, runtime := retirementStorageFixtureAt(t, true, desktopLayout, name)
	terminal := preparedTerminal(t, runtime)
	if err := recordNativeTerminal(context.Background(), launch.Profile, terminal, func(wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode = "open"
	launch.PreviousHostDrainConfirmed = true
	launch.HostLifetimeID = "failed-host"
	launch.ChildLaunchID = "failed-child"
	current, err := NewNativeRuntime(context.Background(), launch, "failed-current")
	if err != nil {
		t.Fatal(err)
	}
	if interrupted {
		// This in-process fixture has no desktop Settings responder. Preserve
		// the same explicit store double used by the first fixture lifetime.
		current.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, Generation: 1}}}
		prepared := retirementCall(t, current, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "interrupted-handoff"})
		var publication wire.CoreRetirementPrepared
		if prepared.Status != "ok" || json.Unmarshal(prepared.Data, &publication) != nil {
			t.Fatal("interrupted prepare", prepared.Status)
		}
		ack := retirementCall(t, current, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: publication.HandoffId, ReceiptDigest: publication.ReceiptDigest})
		if ack.Status != "ok" {
			t.Fatal("interrupted ACK", ack.Status)
		}
	}
	if err := current.Close(); err != nil {
		t.Fatal(err)
	} // deliberately no next Retire
	q, err := QualifyProfile(launch.Profile)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	computer, chat, err := q.Roots()
	if err != nil {
		t.Fatal(err)
	}
	h, err := handoffrepo.New(context.Background(), handoffRoots(launch, chat))
	if err != nil {
		t.Fatal(err)
	}
	head, err := h.Load(context.Background())
	if err != nil || head.Record == nil || (!interrupted && head.Record.Consumption == nil) {
		t.Fatal("missing consumed head", err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	l, err := lifecyclerepo.Inspect(context.Background(), lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
	if err != nil {
		t.Fatal(err)
	}
	root := mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}
	m, err := mutationrepo.New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	expected := make([]mutationrepo.ExpectedSettledRecord, 0, 2)
	kinds := []domain.Kind{domain.WriteKind, domain.EditKind}
	if fiveResults {
		kinds = append(kinds, domain.WriteKind, domain.EditKind, domain.EditKind)
	}
	if !mutations {
		kinds = nil
	}
	for index, kind := range kinds {
		operation := string(kind) + "-fixture"
		if fiveResults {
			operation += "-" + strconv.Itoa(index)
		}
		b := domain.Binding{Identity: domain.Identity{Scope: domain.ScopeConnector, OperationID: operation, OwnerID: launch.OwnerID, ProfileID: launch.Profile.ProfileID, ComputerID: launch.ComputerID}, WorkspaceID: "synthetic", ComputerGeneration: 1, RelativePath: operation + ".md", RequestDigest: strings.Repeat("a", 64), Connector: domain.ConnectorOrigin{BuildID: BuildID, BackendGeneration: "failed-current", RuntimeID: "synthetic-runtime", ConnectorGeneration: 1, SessionID: "synthetic-session", TaskID: "synthetic-task", ParticipantID: "synthetic-participant", TurnID: "synthetic-turn", CallID: operation, TaskEpoch: 1, Generation: 1, Operation: kind}}
		prepared, err := domain.NewPrepared(b)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := m.Admit(context.Background(), prepared); err != nil {
			t.Fatal(err)
		}
		receipt := domain.Receipt{Operation: kind, RelativePath: b.RelativePath, Bytes: 1, AfterSHA256: strings.Repeat("b", 64)}
		if kind == domain.EditKind {
			receipt.Replacements = 1
			hash := strings.Repeat("c", 64)
			receipt.BeforeSHA256 = &hash
		}
		completed, err := prepared.Complete(receipt)
		if fiveResults && index == 4 {
			completed, err = prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"})
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := m.Save(context.Background(), completed); err != nil {
			t.Fatal(err)
		}
		keyInput, _ := json.Marshal([]string{"external-connector-v3", operation, launch.OwnerID, launch.Profile.ProfileID, launch.ComputerID})
		keyDigest := sha256.Sum256(keyInput)
		key := hex.EncodeToString(keyDigest[:]) + ".json"
		raw, err := os.ReadFile(filepath.Join(computer.Path, "mutations", key))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		expected = append(expected, mutationrepo.ExpectedSettledRecord{Key: key, SHA256: hex.EncodeToString(sum[:]), Binding: b})
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	access, err := os.ReadFile(filepath.Join(computer.Path, "computer-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	var binding chatport.HandoffBinding
	if interrupted {
		binding = head.Record.Publication.Binding
	} else {
		binding = head.Record.Consumption.NextBinding
	}
	in := emptyRecoveryInspectionInput{Profile: launch.Profile, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID, AccessDigest: sha256.Sum256(access), Mutations: expected, Selection: chatport.EmptyRecoverySelection{OperationID: "835a913b-bc20-42c6-bf56-9b83852cde3c", Current: binding, HeadDigest: head.Digest, LifecycleDigest: l.SnapshotDigest, Next: chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: "maintenance"}, BuildID: BuildID, HostLifetimeID: "maintenance-host", ChildLaunchID: "maintenance-child"}}
	if interrupted {
		in.Interrupted = &interruptedRetirementInput{OriginalHandoffID: head.Record.Publication.HandoffID, ExpectedACKDigest: head.Digest}
	}
	in.UnacknowledgedDev = !interrupted && fiveResults
	return in
}

func TestNativeEmptyRecoveryInspectionCompositePreservesAndHoldsClaims(t *testing.T) {
	in := emptyRecoveryFixture(t)
	accessPath := filepath.Join(in.Profile.Root, "computer", "computer-access.json")
	before, err := os.ReadFile(accessPath)
	if err != nil {
		t.Fatal(err)
	}
	visits := 0
	err = inspectEmptyRecovery(context.Background(), in, func(v emptyRecoveryInspection) error {
		visits++
		if v.Plan.Selection != in.Selection || v.HandoffSteps != 4 || len(v.Retained.Retained) != 2 {
			t.Fatal("wrong composite observation")
		}
		if writer, err := accessrepo.Open(v.Computer.Path, accessrepo.Binding{ProfileID: in.Profile.ProfileID, OwnerID: in.OwnerID, ComputerID: in.ComputerID}, accessrepo.Clock{}); err == nil {
			writer.Close()
			t.Fatal("access claim not retained")
		}
		return nil
	})
	if err != nil || visits != 1 {
		t.Fatal(err, visits)
	}
	after, err := os.ReadFile(accessPath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("inspection mutated Computer state", err)
	}
}

func TestNativeEmptyRecoveryInspectionRefusesWholeNamespaceAndLateTaskChange(t *testing.T) {
	for _, kind := range []string{"chat-staging", "computer-unknown", "task-pending", "late-task-change", "stale-selection"} {
		t.Run(kind, func(t *testing.T) {
			in := emptyRecoveryFixture(t)
			path := ""
			switch kind {
			case "chat-staging":
				path = filepath.Join(in.Profile.Root, "chat", ".chat-lifecycle-123.tmp")
			case "computer-unknown":
				path = filepath.Join(in.Profile.Root, "computer", "unknown")
			case "task-pending":
				path = filepath.Join(in.Profile.Root, "task", "pending")
			case "stale-selection":
				in.Selection.LifecycleDigest[0]++
			}
			if path != "" {
				if err := os.WriteFile(path, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			visits := 0
			err := inspectEmptyRecovery(context.Background(), in, func(v emptyRecoveryInspection) error {
				visits++
				if kind == "late-task-change" {
					path := filepath.Join(v.Task.Path, "late")
					if err := os.WriteFile(path, []byte("retained"), 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			})
			if err == nil {
				t.Fatal("unsafe composite observation accepted")
			}
			if kind != "late-task-change" && visits != 0 {
				t.Fatal("unsafe input reached visitor")
			}
		})
	}
}

func TestNativeEmptyRecoveryInspectionCommandUsesBoundedReadonlyProjection(t *testing.T) {
	in := emptyRecoveryFixture(t)
	binding := in.Profile
	in.Profile = ProfileBinding{}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"inspect-empty-recovery", "--profile", binding.ProfileID, "--profile-root", binding.Root, "--profile-device", strconv.FormatUint(binding.Device, 10), "--profile-inode", strconv.FormatUint(binding.Inode, 10), "--expected-build", BuildID}
	var out, diagnostics bytes.Buffer
	if code := Run(args, io.NopCloser(bytes.NewReader(raw)), inspectionCommandCloser{&out}, &diagnostics); code != 0 {
		t.Fatal(code, diagnostics.String())
	}
	var projected struct {
		Schema             string `json:"schema"`
		RecoveryAuthorized bool   `json:"recoveryAuthorized"`
		Retained           []struct {
			Key string `json:"key"`
		} `json:"retainedMutationResults"`
	}
	if err := json.Unmarshal(out.Bytes(), &projected); err != nil || projected.Schema != "farol-empty-recovery-inspection/1" || projected.RecoveryAuthorized || len(projected.Retained) != 2 {
		t.Fatal("invalid readonly projection", err)
	}
	for _, forbidden := range []string{binding.Root, "HOST_ACKNOWLEDGED", "LIVE_OWNER_CALLBACK", "Receipt", "synthetic-session", "synthetic-task"} {
		if bytes.Contains(out.Bytes(), []byte(forbidden)) {
			t.Fatal("unnecessary private metadata escaped")
		}
	}
}

func TestNativeEmptyRecoveryTaskBaselineSpansBothScanBoundaries(t *testing.T) {
	for _, boundary := range []string{"before-first", "after-first", "before-final", "after-final"} {
		t.Run(boundary, func(t *testing.T) {
			in := emptyRecoveryFixture(t)
			q, err := QualifyProfile(in.Profile)
			if err != nil {
				t.Fatal(err)
			}
			defer q.Close()
			root, err := q.TaskRoot()
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			change := func() {
				p := filepath.Join(root.Path, "transient-task")
				if err := os.WriteFile(p, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(p); err != nil {
					t.Fatal(err)
				}
			}
			err = withEmptyRecoveryTaskInventory(context.Background(), root, func() error { return nil }, func() error {
				calls++
				before := (calls == 1 && boundary == "before-first") || (calls == 2 && boundary == "before-final")
				after := (calls == 1 && boundary == "after-first") || (calls == 2 && boundary == "after-final")
				if before {
					change()
				}
				err := inspectExactRecoveryDirectory(context.Background(), root, map[string]uint32{})
				if after {
					change()
				}
				return err
			})
			if err == nil || calls != 2 {
				t.Fatal("scan gap hid transient task membership", calls, err)
			}
		})
	}
}
