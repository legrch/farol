//go:build darwin

package mutation_test

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
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	repository "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Real disposable Darwin storage only. Host/consent/execution identities are
// fixtures; no child process, shell, app, provider or execution permission exists.
// A second Repository lifetime follows a known Close, not recovery from a crash.
func nativeProcessFixture(t *testing.T) (repository.Root, processsvc.ConnectorReservationScope, processsvc.Intent) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, child := range []string{"mutations", "workspace"} {
		if err := os.Mkdir(filepath.Join(root, child), 0700); err != nil {
			t.Fatal(err)
		}
	}
	physical := func(path string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			t.Fatal("invalid disposable directory")
		}
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10)}
	}
	id := physical(root)
	device, _ := strconv.ParseUint(id.Device, 10, 64)
	inode, _ := strconv.ParseUint(id.Inode, 10, 64)
	binding := repository.Root{Path: root, Device: device, Inode: inode, OwnerUID: uint32(os.Geteuid())}
	scope := processsvc.ConnectorReservationScope{
		Host:    port.ConnectorHost{ProfileID: "profile", BackendGeneration: "backend", BuildID: "build", RuntimeID: "runtime", LaunchDigest: strings.Repeat("a", 64), ConnectorGeneration: 18446744073709551615},
		OwnerID: "owner", ComputerID: "computer", ComputerGeneration: 3, Generation: 1, CallID: "call",
	}
	workspace := filepath.Join(root, "workspace")
	intent := processsvc.Intent{OperationID: "operation",
		Binding:  port.TaskBinding{Identity: authority.Identity{OwnerID: scope.OwnerID, SessionID: "session", TaskID: "execution-scope", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"},
		Seal:     processsvc.Seal{Digest: strings.Repeat("b", 64), WorkspaceID: "workspace", Root: workspace, Cwd: workspace, RootIdentity: physical(workspace)},
		Deadline: time.Unix(1700000000, 123456789),
	}
	return binding, scope, intent
}

func openProcessRepository(t *testing.T, root repository.Root) *repository.Repository {
	t.Helper()
	r, err := repository.New(context.Background(), root)
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

func reserveProcess(t *testing.T, r *repository.Repository, scope processsvc.ConnectorReservationScope, intent processsvc.Intent, want processsvc.ReservationStatus) {
	t.Helper()
	selected, err := r.ConnectorProcessReservation(scope)
	if err != nil {
		t.Fatal(err)
	}
	got, err := selected.Reserve(context.Background(), intent)
	if err != nil || got == nil || got.Status != want || got.Intent.OperationID != intent.OperationID || got.Intent.Binding != intent.Binding || got.Intent.Seal != intent.Seal || !got.Intent.Deadline.Equal(intent.Deadline) {
		t.Fatalf("reservation: %+v, %v", got, err)
	}
}

func processRecord(t *testing.T, root repository.Root) ([]byte, string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root.Path, "mutations"))
	if err != nil || len(entries) != 1 || !entries[0].Type().IsRegular() {
		t.Fatalf("expected one original durable record: %v, %v", entries, err)
	}
	file := filepath.Join(root.Path, "mutations", entries[0].Name())
	info, err := os.Lstat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("record permissions", err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return data, entries[0].Name()
}

func TestNativeConnectorProcessReservationPersistsAcrossKnownClose(t *testing.T) {
	root, scope, intent := nativeProcessFixture(t)
	r := openProcessRepository(t, root)
	reserveProcess(t, r, scope, intent, processsvc.Reserved)
	original, name := processRecord(t, root)
	// Independent published operation-key formula: changing the action must not
	// provide another namespace for the same external connector operation.
	key := sha256.Sum256([]byte(`["external-connector-v3","operation","owner","profile","computer"]`))
	if name != hex.EncodeToString(key[:])+".json" {
		t.Fatal("process escaped the existing connector operation namespace")
	}
	var envelope struct {
		Version int    `json:"schemaVersion"`
		Kind    string `json:"kind"`
	}
	if json.Unmarshal(original, &envelope) != nil || envelope.Version != 4 || envelope.Kind != "workspace_connector_process" {
		t.Fatal("record is not the explicit process reservation format")
	}
	reserveProcess(t, r, scope, intent, processsvc.Existing)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	next := openProcessRepository(t, root)
	reserveProcess(t, next, scope, intent, processsvc.Existing)
	changed := scope
	changed.Host.BackendGeneration = "successor-backend"
	selected, err := next.ConnectorProcessReservation(changed)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := selected.Reserve(context.Background(), intent); err == nil || got != nil {
		t.Fatal("new host identity made retained work executable")
	}
	retained, retainedName := processRecord(t, root)
	if name != retainedName || !bytes.Equal(original, retained) {
		t.Fatal("duplicate or new host changed original durable reservation")
	}
}

func TestNativeConnectorProcessSharesWriteEditOperationFence(t *testing.T) {
	for _, first := range []string{"process", "mutation"} {
		t.Run(first, func(t *testing.T) {
			root, scope, intent := nativeProcessFixture(t)
			r := openProcessRepository(t, root)
			state, err := domain.NewPrepared(domain.Binding{
				Identity:           domain.Identity{Scope: domain.ScopeConnector, OperationID: intent.OperationID, OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID},
				ComputerGeneration: scope.ComputerGeneration, WorkspaceID: intent.Seal.WorkspaceID, RelativePath: "note.md", RequestDigest: strings.Repeat("c", 64),
				Connector: domain.ConnectorOrigin{BuildID: scope.Host.BuildID, BackendGeneration: scope.Host.BackendGeneration, RuntimeID: scope.Host.RuntimeID, ConnectorGeneration: scope.Host.ConnectorGeneration,
					SessionID: intent.Binding.SessionID, TaskID: intent.Binding.TaskID, TaskEpoch: intent.Binding.TaskEpoch, ParticipantID: intent.Binding.ParticipantID, TurnID: intent.Binding.TurnID,
					CallID: scope.CallID, Generation: scope.Generation, Operation: domain.WriteKind},
			})
			if err != nil {
				t.Fatal(err)
			}
			if first == "process" {
				reserveProcess(t, r, scope, intent, processsvc.Reserved)
			} else {
				admitted, err := r.Admit(context.Background(), state)
				if err != nil || admitted.Status != port.MutationAdmitted {
					t.Fatal("original mutation reservation", err)
				}
			}
			original, name := processRecord(t, root)
			if first == "process" {
				if got, err := r.Admit(context.Background(), state); err == nil || got.Status == port.MutationAdmitted {
					t.Fatal("process operation ID admitted a write")
				}
			} else {
				selected, err := r.ConnectorProcessReservation(scope)
				if err != nil {
					t.Fatal(err)
				}
				if got, err := selected.Reserve(context.Background(), intent); err == nil || got != nil {
					t.Fatal("write operation ID admitted a process")
				}
			}
			retained, retainedName := processRecord(t, root)
			if name != retainedName || !bytes.Equal(original, retained) {
				t.Fatal("cross-kind refusal changed original durable record")
			}
		})
	}
}
