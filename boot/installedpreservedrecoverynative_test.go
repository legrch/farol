//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Synthetic closed profile only. Reservation creation never starts a process.
func installedPreservedRecoveryFixture(t *testing.T) emptyRecoveryInspectionInput {
	t.Helper()
	in := emptyRecoveryFixtureNamed(t, true, false, "Farol")
	in.InstalledPreserved = true
	for _, selected := range in.Mutations {
		in.Preserved = append(in.Preserved, mutationrepo.ExpectedPreservedRecord{Key: selected.Key, SHA256: selected.SHA256, Identity: selected.Binding.Identity})
	}
	in.Mutations = []mutationrepo.ExpectedSettledRecord{}
	profile, err := QualifyProfile(in.Profile)
	if err != nil {
		t.Fatal(err)
	}
	computer, _, err := profile.Roots()
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.Close(); err != nil {
		t.Fatal(err)
	}
	root := mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}
	repo, err := mutationrepo.New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	scope := processsvc.ConnectorReservationScope{Host: port.ConnectorHost{ProfileID: in.Profile.ProfileID, BackendGeneration: in.Selection.Current.BackendGeneration, BuildID: BuildID, RuntimeID: "refused-runtime", LaunchDigest: strings.Repeat("a", 64), ConnectorGeneration: 1}, OwnerID: in.OwnerID, ComputerID: in.ComputerID, ComputerGeneration: 1, Generation: 1, CallID: "refused-call"}
	intent := processsvc.Intent{OperationID: "unresolved-read-only-process", Binding: port.TaskBinding{Identity: authority.Identity{OwnerID: in.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"}, Seal: processsvc.Seal{Digest: strings.Repeat("b", 64), WorkspaceID: "synthetic", Root: computer.Path, Cwd: computer.Path, RootIdentity: authority.RootIdentity{Device: strconv.FormatUint(computer.Device, 10), Inode: strconv.FormatUint(computer.Inode, 10)}}, Deadline: time.Unix(1700000000, 0)}
	selected, err := repo.ConnectorProcessReservation(scope)
	if err != nil {
		t.Fatal(err)
	}
	got, err := selected.Reserve(context.Background(), intent)
	if err != nil || got.Status != processsvc.Reserved {
		t.Fatal("reserve fixture", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	identity := domain.Identity{Scope: domain.ScopeConnector, OperationID: intent.OperationID, OwnerID: in.OwnerID, ProfileID: in.Profile.ProfileID, ComputerID: in.ComputerID}
	keyInput, _ := json.Marshal([]string{"external-connector-v3", identity.OperationID, identity.OwnerID, identity.ProfileID, identity.ComputerID})
	keySum := sha256.Sum256(keyInput)
	key := hex.EncodeToString(keySum[:]) + ".json"
	raw, err := os.ReadFile(filepath.Join(computer.Path, "mutations", key))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	in.Preserved = append(in.Preserved, mutationrepo.ExpectedPreservedRecord{Key: key, SHA256: hex.EncodeToString(sum[:]), Identity: identity})
	return in
}

func TestNativeInstalledPreservedRecoveryKeepsUnknownReservationsAndWriterClaim(t *testing.T) {
	in := installedPreservedRecoveryFixture(t)
	calls := 0
	err := inspectEmptyRecovery(context.Background(), in, func(v emptyRecoveryInspection) error {
		calls++
		if v.PreservedRetained == nil || len(v.PreservedRetained.Retained) != 3 || v.PreservedRetained.ReservedProcesses != 1 {
			t.Fatal("wrong retained selection")
		}
		if repo, err := mutationrepo.New(context.Background(), v.PreservedRetained.Root); err == nil {
			repo.Close()
			t.Fatal("lost writer exclusion")
		}
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatal(calls, err)
	}
	for _, selected := range in.Preserved {
		raw, err := os.ReadFile(filepath.Join(in.Profile.Root, "computer", "mutations", selected.Key))
		sum := sha256.Sum256(raw)
		if err != nil || hex.EncodeToString(sum[:]) != selected.SHA256 {
			t.Fatal("retained journal changed", err)
		}
	}
}

func TestNativeInstalledPreservedRecoveryRejectsCrossedSelection(t *testing.T) {
	for _, fault := range []string{"empty-mode", "dev-mode", "missing-set", "wrong-digest", "late-record", "task-record"} {
		t.Run(fault, func(t *testing.T) {
			in := installedPreservedRecoveryFixture(t)
			original, err := os.ReadFile(filepath.Join(in.Profile.Root, "chat", "chat-lifecycle.json"))
			if err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "empty-mode":
				in.InstalledEmpty = true
			case "dev-mode":
				in.InstalledPreserved = false
			case "missing-set":
				in.Preserved = in.Preserved[:2]
			case "wrong-digest":
				in.Preserved[0].SHA256 = strings.Repeat("f", 64)
			case "task-record":
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "task", "unexpected"), []byte("1"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			err = inspectEmptyRecovery(context.Background(), in, func(v emptyRecoveryInspection) error {
				calls++
				if fault == "late-record" {
					return os.WriteFile(filepath.Join(v.Computer.Path, "mutations", "late"), []byte("1"), 0600)
				}
				return nil
			})
			if err == nil || fault != "late-record" && calls != 0 {
				t.Fatal("unsafe selection admitted", calls, err)
			}
			after, e := os.ReadFile(filepath.Join(in.Profile.Root, "chat", "chat-lifecycle.json"))
			if e != nil || !bytes.Equal(original, after) {
				t.Fatal("failed inspection changed Chat")
			}
		})
	}
}
