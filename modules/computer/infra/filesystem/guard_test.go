package filesystem

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Pure owner/lease/journal doubles and the inode/syscall model. These exercise
// BOTH real application producers and Mutable, but not Store disk, boot guards,
// native filesystem syscalls, connector sockets, processes or provider calls.
type publicationOwners struct {
	access, execution sync.Mutex
	approval          authority.Approval
	participant       authority.Participant
	binding           port.TaskBinding
	now               time.Time
	withdrawn         bool
	connector         bool
	inside            bool
}

func (o *publicationOwners) Now() time.Time            { return o.now }
func (o *publicationOwners) Deadline() time.Time       { return o.now.Add(15 * time.Second) }
func (o *publicationOwners) Binding() port.TaskBinding { return o.binding }
func (o *publicationOwners) WithCurrent(_ context.Context, inspect func(*authority.Approval) error) error {
	o.access.Lock()
	defer o.access.Unlock()
	o.inside = true
	defer func() { o.inside = false }()
	if o.withdrawn {
		return inspect(nil)
	}
	a := o.approval.Clone()
	return inspect(&a)
}
func (o *publicationOwners) WithSnapshot(_ context.Context, _ string, inspect func(port.AccessSnapshot) error) error {
	o.access.Lock()
	defer o.access.Unlock()
	o.execution.Lock()
	defer o.execution.Unlock()
	o.inside = true
	defer func() { o.inside = false }()
	if o.withdrawn {
		return inspect(port.AccessSnapshot{})
	}
	p, a := o.participant.Clone(), o.approval.Clone()
	return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
}
func (o *publicationOwners) withdraw() {
	o.access.Lock()
	defer o.access.Unlock()
	o.withdrawn = true
}

type publicationJournal struct {
	owners            *publicationOwners
	record            *mutation.State
	admissions, saves int
}

func (j *publicationJournal) Admit(_ context.Context, s *mutation.State) (port.MutationAdmission, error) {
	if j.owners.inside {
		panic("admission under authority gate")
	}
	j.admissions++
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
func (j *publicationJournal) Load(_ context.Context, _ mutation.Identity) (*mutation.State, error) {
	if j.owners.inside {
		panic("journal load under authority gate")
	}
	if j.record == nil {
		return nil, nil
	}
	c := j.record.Clone()
	return &c, nil
}
func (j *publicationJournal) Save(_ context.Context, s *mutation.State) error {
	if j.owners.inside {
		panic("terminal persistence under authority gate")
	}
	j.saves++
	c := s.Clone()
	j.record = &c
	return nil
}

type boundaryMutationFS struct {
	*fakeMutationFS
	beforeEffect func()
}

func (f boundaryMutationFS) link(a int, b string, c int, d string) error {
	f.beforeEffect()
	return f.fakeMutationFS.link(a, b, c, d)
}
func (f boundaryMutationFS) swap(a int, b string, c int, d string) error {
	f.beforeEffect()
	return f.fakeMutationFS.swap(a, b, c, d)
}

func publicationFixture(t *testing.T, route, kind string, paths ...string) (*Mutable, *fakeMutationFS, *publicationOwners, *publicationJournal, func() error) {
	t.Helper()
	path := "note.md"
	if len(paths) != 0 {
		path = paths[0]
	}
	m, f := fakeMutable()
	now := time.UnixMilli(1800000000000)
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7, ExpiresAt: now.Add(time.Hour),
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "7", Inode: "2"}}},
		Capabilities: []authority.Capability{authority.Write}, Network: authority.NoNetwork, Commands: authority.NoCommands}
	b := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"}
	p := authority.Participant{ParticipantID: b.ParticipantID, Role: authority.Main, MutationOwnership: authority.TaskOwnership,
		Grant: authority.Grant{Identity: b.Identity, AuthorityID: "grant", ComputerID: "computer", ComputerGeneration: 7,
			Policy: authority.Policy{ExpiresAt: now.Add(time.Minute), Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: a.Capabilities, Network: a.Network, Commands: a.Commands}}}
	o := &publicationOwners{approval: a, participant: p, binding: b, now: now, connector: route == "connector"}
	j := &publicationJournal{owners: o}
	var op mutationsvc.Operation = mutationsvc.Write{RelativePath: path, Content: "new"}
	operation := mutation.WriteKind
	if kind != "create" {
		f.work.children["note.md"] = f.file("old")
		hash := payloadHash([]byte("old"))
		op = mutationsvc.Write{RelativePath: path, Content: "new", ExpectedSHA256: &hash}
		if kind == "edit" {
			op = mutationsvc.Edit{RelativePath: path, ExpectedSHA256: hash, Edits: []mutationsvc.TextEdit{{OldText: "old", NewText: "new"}}}
			operation = mutation.EditKind
		}
	}
	if route == "settings" {
		s, err := mutationsvc.NewForOwnerExecution(context.Background(), mutationsvc.OwnerSelection{OperationID: "op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer", ComputerGeneration: 7}, o, j, m, Digester{}, &sync.Mutex{}, o)
		if err != nil {
			t.Fatal(err)
		}
		return m, f, o, j, func() error {
			_, err := s.Execute(context.Background(), mutationsvc.OwnerRequest{WorkspaceID: "work", Operation: op})
			return err
		}
	}
	selection := mutationsvc.ConnectorSelection{ConnectorOwner: mutationsvc.ConnectorOwner{OperationID: "op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, ComputerGeneration: 7,
		Origin: mutation.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, CallID: "call", Generation: 1, Operation: operation}}
	s, err := mutationsvc.NewForConnectorExecution(selection, o, j, m, Digester{}, &sync.Mutex{}, o)
	if err != nil {
		t.Fatal(err)
	}
	return m, f, o, j, func() error {
		_, err := s.Execute(context.Background(), mutationsvc.ConnectorRequest{WorkspaceID: "work", Operation: op})
		return err
	}
}

func TestMutationPublicationPureWithdrawalAtSyscall(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		for _, kind := range []string{"create", "replace", "edit"} {
			t.Run(route+"/"+kind, func(t *testing.T) {
				m, f, o, j, execute := publicationFixture(t, route, kind)
				var done chan struct{}
				m.fs = boundaryMutationFS{fakeMutationFS: f, beforeEffect: func() {
					// This is AFTER final validation, immediately BEFORE the modeled
					// link/swap effect. TryLock deterministically distinguishes the
					// vulnerable unlocked handoff without scheduling/time assumptions.
					if o.access.TryLock() {
						o.withdrawn = true
						o.access.Unlock()
						t.Error("withdrawal completed between validation and publication")
						return
					}
					if o.connector && o.execution.TryLock() {
						o.execution.Unlock()
						t.Error("execution owner released before syscall")
					}
					done = make(chan struct{})
					attempted := make(chan struct{})
					go func() { close(attempted); o.withdraw(); close(done) }()
					<-attempted
				}}
				_ = execute() // Final disclosure may win or lose against withdrawal.
				if done != nil {
					<-done
				}
				if j.record == nil || j.record.Phase() != mutation.Completed || j.admissions != 1 || j.saves != 1 || string(f.work.children["note.md"].data) != "new" {
					t.Fatal("known publication lost or journal under owner gate")
				}
				if (kind == "create" && (f.links != 1 || f.swaps != 0)) || (kind != "create" && (f.links != 0 || f.swaps != 1)) {
					t.Fatal("not exactly one effect")
				}
				if err := execute(); err == nil {
					t.Fatal("withdrawn authority disclosed late result")
				}
				if j.admissions != 1 || j.saves != 1 || f.links+f.swaps != 1 {
					t.Fatal("withdrawal caused replay")
				}
			})
		}
	}
}

func TestMutationPublicationPureAuthorityChangedDuringStaging(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		for _, kind := range []string{"create", "replace", "edit"} {
			for _, change := range []string{"withdraw", "generation", "owner", "root", "write access", "exclusion"} {
				t.Run(route+"/"+kind+"/"+change, func(t *testing.T) {
					_, f, o, j, execute := publicationFixture(t, route, kind)
					f.onSync = func(n *fakeNode) error {
						if n.children != nil {
							return nil
						}
						if !o.access.TryLock() {
							t.Fatal("staging IO held access owner")
						}
						defer o.access.Unlock()
						switch change {
						case "withdraw":
							o.withdrawn = true
						case "generation":
							o.approval.Generation++
						case "owner":
							o.approval.OwnerID = "other"
						case "root":
							o.approval.Workspaces[0].RootIdentity.Inode = "9"
						case "write access":
							o.approval.Workspaces[0].Access = authority.ReadAccess
						case "exclusion":
							o.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/note.md"}}
						}
						return nil
					}
					_ = execute() // A failed record can be disclosed under surviving read authority.
					if f.links+f.swaps != 0 || j.record == nil || j.record.Phase() != mutation.Failed || stageOf(f) != nil {
						t.Fatal("publication after changed authority")
					}
					_ = execute()
					if j.admissions != 1 || j.saves != 1 || f.links+f.swaps != 0 {
						t.Fatal("changed authority retried")
					}
				})
			}
		}
	}
}

func TestMutationPublicationPureMalformedGuard(t *testing.T) {
	for _, kind := range []string{"create", "replace", "edit"} {
		for _, name := range []string{"missing", "skipped", "late", "repeated", "lost acknowledgement", "swallowed refusal"} {
			t.Run(kind+"/"+name, func(t *testing.T) {
				m, f, _, _, _ := publicationFixture(t, "settings", kind)
				var op mutation.Operation = mutation.Write{RelativePath: "note.md", Content: "new"}
				hash := payloadHash([]byte("old"))
				if kind == "replace" {
					op = mutation.Write{RelativePath: "note.md", Content: "new", ExpectedSHA256: &hash}
				}
				if kind == "edit" {
					op = mutation.Edit{RelativePath: "note.md", ExpectedSHA256: hash, Edits: []mutation.TextEdit{{OldText: "old", NewText: "new"}}}
				}
				r := fakeRequest(op)
				var late func() error
				r.WithPublication = func(_ context.Context, publish func() error) error {
					switch name {
					case "skipped":
						return nil
					case "late":
						late = publish
						return nil
					case "repeated":
						_ = publish()
						return publish()
					case "lost acknowledgement":
						_ = publish()
						return errors.New("lost guard ACK")
					case "swallowed refusal":
						f.swapFault = func(int) error { return unix.ENOTSUP }
						_ = publish()
						return nil
					}
					return publish()
				}
				if name == "swallowed refusal" && kind == "create" {
					return
				} // Swap-only deterministic refusal.
				if name == "missing" {
					r.WithPublication = nil
				}
				receipt, err := m.Mutate(context.Background(), r)
				if err == nil || receipt != nil {
					t.Fatal("malformed guard reported success")
				}
				if late != nil && late() == nil {
					t.Fatal("late callback published")
				}
				want := 0
				if name == "repeated" || name == "lost acknowledgement" || name == "swallowed refusal" {
					want = 1
					nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
				}
				if f.links+f.swaps != want {
					t.Fatal("late or repeated syscall")
				}
				if want == 1 && (stageOf(f) == nil || f.unlinks != 0) {
					t.Fatal("uncertain guard cleaned/replayed")
				}
			})
		}
	}
}

func TestMutationPublicationPureGuardedUndoKeepsKnownConflict(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		for _, kind := range []string{"replace", "edit"} {
			t.Run(route+"/"+kind, func(t *testing.T) {
				_, f, _, j, execute := publicationFixture(t, route, kind)
				foreign := f.file("foreign")
				f.beforeSwap = func(n int) {
					if n == 1 {
						f.work.children["note.md"] = foreign
					}
				}
				if err := execute(); err != nil {
					t.Fatal(err)
				}
				if j.record.Phase() != mutation.Failed || j.record.Failure().Code != "WORKSPACE_MUTATION_CONFLICT" || f.swaps != 2 || f.work.children["note.md"] != foreign || stageOf(f) != nil {
					t.Fatal("guard copied a known conflict into unknown or lost original")
				}
				_ = execute()
				if f.swaps != 2 || j.admissions != 1 || j.saves != 1 {
					t.Fatal("known conflict replayed")
				}
			})
		}
	}
}

func TestMutationPublicationPureUnknownRemainsFenced(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		for _, kind := range []string{"create", "replace", "edit"} {
			t.Run(route+"/"+kind, func(t *testing.T) {
				_, f, _, j, execute := publicationFixture(t, route, kind)
				if kind == "create" {
					f.onUnlink = func(int, string, bool) error { return errors.New("lost cleanup ACK") }
				} else {
					f.swapFault = func(int) error { return errors.New("lost publication ACK") }
				}
				if err := execute(); err != nil {
					t.Fatal(err)
				}
				if j.record.Phase() != mutation.OutcomeUnknown || f.links+f.swaps != 1 || stageOf(f) == nil {
					t.Fatal("uncertain syscall upgraded or stage lost")
				}
				_ = execute()
				if j.record.Phase() != mutation.OutcomeUnknown || f.links+f.swaps != 1 || j.admissions != 1 || j.saves != 1 {
					t.Fatal("unknown upgraded/retried")
				}
			})
		}
	}
}
