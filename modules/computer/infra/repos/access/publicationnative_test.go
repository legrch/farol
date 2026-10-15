//go:build darwin

package access

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// This bounded witness uses disposable native Store persistence and actual
// Mutable link/swap. It does not qualify
// boot activation/host guards, sockets, providers or an installed application.
type nativePublicationApproval struct{ store *Store }

func (a nativePublicationApproval) WithCurrent(ctx context.Context, inspect func(*authority.Approval) error) error {
	return a.store.WithOwnerApproval(ctx, func(_ Status, a *authority.Approval) error { return inspect(a) })
}

type nativePublicationTask struct {
	binding port.TaskBinding
	gate    sync.Mutex
}

func (a *nativePublicationTask) WithCurrent(_ context.Context, inspect func(*port.TaskBinding) error) error {
	a.gate.Lock()
	defer a.gate.Unlock()
	b := a.binding
	return inspect(&b)
}

type nativePublicationRecords struct{ record *mutation.State }

func (j *nativePublicationRecords) Admit(_ context.Context, s *mutation.State) (port.MutationAdmission, error) {
	status := port.MutationAdmitted
	if j.record != nil {
		status = port.MutationExisting
	} else {
		c := s.Clone()
		j.record = &c
	}
	c := j.record.Clone()
	return port.MutationAdmission{Status: status, Record: &c}, nil
}
func (j *nativePublicationRecords) Load(_ context.Context, _ mutation.Identity) (*mutation.State, error) {
	if j.record == nil {
		return nil, nil
	}
	c := j.record.Clone()
	return &c, nil
}
func (j *nativePublicationRecords) Save(_ context.Context, s *mutation.State) error {
	c := s.Clone()
	j.record = &c
	return nil
}

type nativePublicationBoundary struct {
	producer *filesystem.Mutable
	store    *Store
	t        *testing.T
	revision uint64
	done     chan error
	calls    int
	// Join withdrawal after the first authorized parent effect and before
	// returning its guard, so no later mkdir can race the test scheduler.
	waitBeforeNext bool
}

func (n *nativePublicationBoundary) Mutate(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
	n.calls++
	guard := r.WithPublication
	r.WithPublication = func(ctx context.Context, publish func() error) error {
		err := guard(ctx, func() error {
			// Validation finished; Mutable's exact link/swap follows in publish.
			if n.store.mutex.TryLock() {
				n.store.mutex.Unlock()
				n.t.Error("sole Store owner released before native publication")
			}
			attempted := make(chan struct{})
			n.done = make(chan error, 1)
			go func() { close(attempted); n.done <- n.store.RevokeApproval(context.Background(), n.revision) }()
			<-attempted
			return publish()
		})
		if n.waitBeforeNext && n.done != nil {
			if withdrawErr := <-n.done; withdrawErr != nil {
				n.t.Fatal(withdrawErr)
			}
		}
		return err
	}
	return n.producer.Mutate(ctx, r)
}
func TestNativeMutationPublicationSerializesSoleStoreWithdrawal(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		for _, kind := range []string{"create", "replace", "edit", "parents"} {
			t.Run(route+"/"+kind, func(t *testing.T) {
				f := fixtureState(t)
				ctx := context.Background()
				f.approval.Workspaces[0].Access = authority.WriteAccess
				f.approval.Capabilities = []authority.Capability{authority.Write}
				f.admission.Policy.Workspaces[0].Access = authority.WriteAccess
				f.admission.Policy.Capabilities = []authority.Capability{authority.Write}
				f.participant.MutationOwnership = authority.TaskOwnership
				approve(t, f)
				var op mutationsvc.Operation = mutationsvc.Write{RelativePath: "note.md", Content: "new"}
				operation := mutation.WriteKind
				if kind == "parents" {
					op = mutationsvc.Write{RelativePath: "nested/deeper/note.md", Content: "new"}
				}
				if kind != "create" && kind != "parents" {
					if err := os.WriteFile(filepath.Join(f.workspace, "note.md"), []byte("old"), 0600); err != nil {
						t.Fatal(err)
					}
					hash := fmt.Sprintf("%x", sha256.Sum256([]byte("old")))
					op = mutationsvc.Write{RelativePath: "note.md", Content: "new", ExpectedSHA256: &hash}
					if kind == "edit" {
						operation = mutation.EditKind
						op = mutationsvc.Edit{RelativePath: "note.md", ExpectedSHA256: hash, Edits: []mutationsvc.TextEdit{{OldText: "old", NewText: "new"}}}
					}
				}
				journal := &nativePublicationRecords{}
				native := &nativePublicationBoundary{producer: filesystem.NewMutable(f.home), store: f.store, t: t, waitBeforeNext: kind == "parents"}
				var execute func() error
				if route == "settings" {
					s, err := mutationsvc.NewForOwnerExecution(ctx, mutationsvc.OwnerSelection{OperationID: "op", OwnerID: "owner", ProfileID: testBinding.ProfileID, ComputerID: "computer", ComputerGeneration: 3}, nativePublicationApproval{f.store}, journal, native, filesystem.Digester{}, &sync.Mutex{}, f.clock)
					if err != nil {
						t.Fatal(err)
					}
					execute = func() error {
						_, err := s.Execute(ctx, mutationsvc.OwnerRequest{WorkspaceID: "work", Operation: op})
						return err
					}
				} else {
					p := admit(t, f)
					binding := port.TaskBinding{Identity: p.Grant.Identity, ParticipantID: p.ParticipantID, TurnID: "turn"}
					issuer, err := execution.New(f.store, &nativePublicationTask{binding: binding}, f.clock, execution.Ceiling{Participant: *p, Approval: f.approval})
					if err != nil {
						t.Fatal(err)
					}
					lease, err := issuer.Admit(ctx, authority.Write)
					if err != nil {
						t.Fatal(err)
					}
					selected := mutationsvc.ConnectorSelection{ConnectorOwner: mutationsvc.ConnectorOwner{OperationID: "op", OwnerID: "owner", ProfileID: testBinding.ProfileID, ComputerID: "computer"}, ComputerGeneration: 3, Origin: mutation.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 1, SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch, ParticipantID: binding.ParticipantID, TurnID: binding.TurnID, CallID: "call", Generation: 1, Operation: operation}}
					s, err := mutationsvc.NewForConnectorExecution(selected, lease, journal, native, filesystem.Digester{}, &sync.Mutex{}, f.clock)
					if err != nil {
						t.Fatal(err)
					}
					execute = func() error {
						_, err := s.Execute(ctx, mutationsvc.ConnectorRequest{WorkspaceID: "work", Operation: op})
						return err
					}
				}
				native.revision = status(t, f.store).Revision
				_ = execute() // Disclosure may lose to withdrawal; known completion must survive.
				if native.done == nil {
					t.Fatal("publication was not entered")
				}
				if kind == "parents" {
					if journal.record == nil || journal.record.Phase() != mutation.OutcomeUnknown {
						t.Fatal("partial native directory effect lost")
					}
					parent, err := os.Stat(filepath.Join(f.workspace, "nested"))
					if err != nil || !parent.IsDir() {
						t.Fatal("authorized first parent not retained", err)
					}
					if _, err := os.Lstat(filepath.Join(f.workspace, "nested/deeper")); !os.IsNotExist(err) {
						t.Fatal("a later parent was created after completed withdrawal", err)
					}
					if err := execute(); err == nil || native.calls != 1 {
						t.Fatal("partial native directory effect retried")
					}
					return
				}
				if err := <-native.done; err != nil {
					t.Fatal(err)
				}
				if journal.record == nil || journal.record.Phase() != mutation.Completed {
					t.Fatal("native result not retained")
				}
				data, err := os.ReadFile(filepath.Join(f.workspace, "note.md"))
				if err != nil || string(data) != "new" {
					t.Fatal("native publication not observed", err)
				}
				if err := execute(); err == nil || native.calls != 1 {
					t.Fatal("withdrawn authority retried/disclosed result")
				}
			})
		}
	}
}
