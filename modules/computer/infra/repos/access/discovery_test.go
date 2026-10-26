package access

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	"golang.org/x/sys/unix"
)

// Real disposable filesystem/state + published Computer contract. Task admission
// and time are controlled fixtures; no provider, production settings or route is
// exercised. Every composite uses ONE already admitted fixed operation lease.
type discoveryNative struct {
	port.Workspace
	reads, inspections []string
	hook               func(kind, path string)
}

func (n *discoveryNative) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.reads = append(n.reads, r.RelativePath)
	if r.Range != nil {
		panic("instruction read is ranged")
	}
	out, err := n.Workspace.Read(ctx, r)
	if n.hook != nil {
		n.hook("read", r.RelativePath)
	}
	return out, err
}
func (n *discoveryNative) Inspect(ctx context.Context, r port.ListRequest) (*port.DirectoryBinding, error) {
	n.inspections = append(n.inspections, r.Workspace.WorkspaceID+":"+r.RelativePath)
	out, err := n.Workspace.(port.DirectoryInspector).Inspect(ctx, r)
	if n.hook != nil {
		n.hook("inspect", r.RelativePath)
	}
	return out, err
}
func (n *discoveryNative) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	panic("discovery must inspect the directory without enumerating children")
}

func discoveryContract(t *testing.T, f stateFixture, lease port.ExecutionAccessRepository, n port.Workspace) *workspacect.Contract {
	t.Helper()
	s, err := workspacesvc.NewForExecution(lease, n, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	return workspacect.New(s)
}
func catalogueRequest(l port.ExecutionAccessRepository) workspacect.CatalogueRequest {
	b := l.Binding()
	return workspacect.CatalogueRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 99, CallID: "disposable-catalogue"}
}
func bootstrapRequest(l port.ExecutionAccessRepository, directory string) workspacect.BootstrapRequest {
	r := catalogueRequest(l)
	return workspacect.BootstrapRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: "disposable-bootstrap", WorkspaceID: "work", RelativeDirectory: directory}
}
func writeInstruction(t *testing.T, f stateFixture, path, text string) {
	t.Helper()
	full := filepath.Join(f.workspace, path)
	if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestNativeBootstrapNarrowedScopeInstructionsAndMissingAreIndependent(t *testing.T) {
	f := fixtureState(t)
	writeInstruction(t, f, "AGENTS.md", "private ancestor instruction")
	writeInstruction(t, f, "src/AGENTS.md", "root rules")
	writeInstruction(t, f, "src/nested/AGENTS.md", "nested rules")
	if err := os.Mkdir(filepath.Join(f.workspace, "src/nested/leaf"), 0700); err != nil {
		t.Fatal(err)
	}
	f.admission.Workspaces[0].Root = filepath.Join(f.workspace, "src")
	approve(t, f)
	p := admit(t, f)
	tasks := &leaseTasks{binding: &port.TaskBinding{Identity: f.admission.Identity, ParticipantID: p.ParticipantID, TurnID: "trusted-turn"}}
	l := admittedLease(t, issuerLeases(t, f.store, f, executionsvc.Ceiling{Participant: *p, Approval: f.approval}, tasks), authority.List)
	n := &discoveryNative{Workspace: filesystem.New(f.home)}
	out, err := discoveryContract(t, f, l, n).Bootstrap(context.Background(), bootstrapRequest(l, "nested/leaf"))
	if err != nil || out == nil || !out.Complete || out.Root != filepath.Join(f.workspace, "src") || out.ApprovedRoot.Path != f.workspace || out.TurnID != l.Binding().TurnID || out.Generation != 99 || out.CallID != "disposable-bootstrap" {
		t.Fatalf("native bootstrap: %v", err)
	}
	if !slices.Equal(n.reads, []string{"AGENTS.md", "nested/AGENTS.md", "nested/leaf/AGENTS.md", "AGENTS.md", "nested/AGENTS.md", "nested/leaf/AGENTS.md"}) || len(n.inspections) != 2 {
		t.Fatal("native traversal escaped scope")
	}
	if v, ok := out.Instructions[0].(workspacect.ReadInstruction); !ok || v.Text != "root rules" {
		t.Fatal("ancestor escaped or contract variant lost")
	}
	if _, ok := out.Instructions[2].(workspacect.MissingInstruction); !ok {
		t.Fatal("missing became unavailable")
	}
	// Published DTOs are independent of subsequent native edits and policy copies.
	writeInstruction(t, f, "src/AGENTS.md", "later edit")
	if out.Instructions[0].(workspacect.ReadInstruction).Text != "root rules" {
		t.Fatal("published DTO aliases native bytes")
	}
}
func TestNativeBootstrapUnavailableCannotExpandInstructionsOrAuthority(t *testing.T) {
	for _, test := range []struct {
		name, code string
		prepare    func(*testing.T, stateFixture)
	}{
		{"denied", "AUTHORITY_PATH_DENIED", func(_ *testing.T, _ stateFixture) {}},
		{"symlink", "WORKSPACE_PATH_REFUSED", func(t *testing.T, f stateFixture) {
			if err := os.Symlink("README.md", filepath.Join(f.workspace, "AGENTS.md")); err != nil {
				t.Fatal(err)
			}
		}},
		{"binary", "WORKSPACE_NOT_TEXT", func(t *testing.T, f stateFixture) { writeInstruction(t, f, "AGENTS.md", "rules\x00secret") }},
		{"directory", "WORKSPACE_NOT_A_FILE", func(t *testing.T, f stateFixture) {
			if err := os.Mkdir(filepath.Join(f.workspace, "AGENTS.md"), 0700); err != nil {
				t.Fatal(err)
			}
		}},
		{"large", "WORKSPACE_FILE_TOO_LARGE", func(t *testing.T, f stateFixture) {
			writeInstruction(t, f, "AGENTS.md", strings.Repeat("x", 256*1024+1))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixtureState(t)
			test.prepare(t, f)
			if test.name == "denied" {
				f.admission.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: filepath.Join(f.workspace, "AGENTS.md"), RestrictionSource: authority.OwnerRestrictionSource}}
			}
			approve(t, f)
			p := admit(t, f)
			tasks := &leaseTasks{binding: &port.TaskBinding{Identity: f.admission.Identity, ParticipantID: p.ParticipantID, TurnID: "trusted-turn"}}
			l := admittedLease(t, issuerLeases(t, f.store, f, executionsvc.Ceiling{Participant: *p, Approval: f.approval}, tasks), authority.List)
			out, err := discoveryContract(t, f, l, filesystem.New(f.home)).Bootstrap(context.Background(), bootstrapRequest(l, "."))
			if err != nil || out == nil || out.Complete {
				t.Fatalf("unavailability: %v", err)
			}
			if v, ok := out.Instructions[0].(workspacect.UnavailableInstruction); !ok || v.Code != test.code || v.RelativePath != "AGENTS.md" {
				t.Fatalf("wrong unavailable: %#v", out.Instructions)
			}
		})
	}
}
func TestNativeBootstrapConcurrentInstructionEditDiscardsAllText(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	writeInstruction(t, f, "AGENTS.md", "first rules")
	l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
	n := &discoveryNative{Workspace: filesystem.New(f.home)}
	n.hook = func(kind, _ string) {
		if kind == "read" && len(n.reads) == 1 {
			writeInstruction(t, f, "AGENTS.md", "later rules")
		}
	}
	out, err := discoveryContract(t, f, l, n).Bootstrap(context.Background(), bootstrapRequest(l, "."))
	if out != nil || len(n.reads) != 2 || len(n.inspections) != 1 {
		t.Fatal("changed native chain disclosed/retried")
	}
	expectContextFailure(t, err, "COMPUTER_INSTRUCTIONS_CHANGED")
}
func TestNativeBootstrapLaterPhaseRevocationAndFixedDeadlineDiscardCollection(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*testing.T, stateFixture, *leaseTasks)
	}{
		{"participant revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			if err := f.store.RevokeParticipant(context.Background(), status(t, f.store).Revision, "main"); err != nil {
				t.Fatal(err)
			}
		}},
		{"approval revoke", "COMPUTER_APPROVAL_NOT_FOUND", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			if err := f.store.RevokeApproval(context.Background(), status(t, f.store).Revision); err != nil {
				t.Fatal(err)
			}
		}},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			a := f.approval.Clone()
			a.Generation++
			if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, a); err != nil {
				t.Fatal(err)
			}
		}},
		{"fixed deadline", "AUTHORITY_EXPIRED", func(_ *testing.T, f stateFixture, _ *leaseTasks) { f.clock.ms.Add(15000) }},
		{"trusted turn", "AUTHORITY_TASK_MISMATCH", func(_ *testing.T, _ stateFixture, o *leaseTasks) {
			o.change(func(b *port.TaskBinding) { b.TurnID = "other-turn" })
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, ceiling, tasks := fixtureLeases(t)
			writeInstruction(t, f, "AGENTS.md", "root")
			writeInstruction(t, f, "nested/AGENTS.md", "nested")
			l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
			n := &discoveryNative{Workspace: filesystem.New(f.home)}
			n.hook = func(kind, _ string) {
				if kind == "read" && len(n.reads) == 3 {
					test.change(t, f, tasks)
				}
			}
			out, err := discoveryContract(t, f, l, n).Bootstrap(context.Background(), bootstrapRequest(l, "nested"))
			if out != nil || len(n.reads) != 3 || len(n.inspections) != 1 {
				t.Fatal("later phase disclosed/reminted/retried")
			}
			expectContextFailure(t, err, test.code)
		})
	}
}
func TestNativeCatalogueOnlyMaterializedScopeIDsAndCurrentPhysicalRoots(t *testing.T) {
	f := fixtureState(t)
	for _, id := range []string{"second", "approval-only"} {
		root := filepath.Join(filepath.Dir(f.workspace), id)
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		var st unix.Stat_t
		if err := unix.Stat(root, &st); err != nil {
			t.Fatal(err)
		}
		f.approval.Workspaces = append(f.approval.Workspaces, authority.ApprovedWorkspace{WorkspaceID: id, Root: root, Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: fmt.Sprint(st.Dev), Inode: fmt.Sprint(st.Ino)}})
		if id == "second" {
			f.admission.Workspaces = append([]authority.Scope{{WorkspaceID: id, Root: root, Mode: authority.Subtree, Access: authority.ReadAccess}}, f.admission.Workspaces...)
		}
	}
	approve(t, f)
	p := admit(t, f)
	tasks := &leaseTasks{binding: &port.TaskBinding{Identity: f.admission.Identity, ParticipantID: p.ParticipantID, TurnID: "trusted-turn"}}
	l := admittedLease(t, issuerLeases(t, f.store, f, executionsvc.Ceiling{Participant: *p, Approval: f.approval}, tasks), authority.List)
	n := &discoveryNative{Workspace: filesystem.New(f.home)}
	out, err := discoveryContract(t, f, l, n).Catalogue(context.Background(), catalogueRequest(l))
	if err != nil || out == nil || len(out.Workspaces) != 2 || out.Workspaces[0].WorkspaceID != "second" || out.Workspaces[1].WorkspaceID != "work" || out.Workspaces[1].Root != f.workspace || out.Workspaces[1].ApprovedRoot.Device != f.approval.Workspaces[0].RootIdentity.Device || !slices.Equal(n.inspections, []string{"second:.", "work:.", "second:.", "work:."}) || len(n.reads) != 0 {
		t.Fatalf("native catalogue: %v", err)
	}
	n.hook = func(kind, _ string) {
		if kind == "inspect" && len(n.inspections) == 8 {
			if err := f.store.RevokeApproval(context.Background(), status(t, f.store).Revision); err != nil {
				t.Fatal(err)
			}
		}
	}
	out, err = discoveryContract(t, f, l, n).Catalogue(context.Background(), catalogueRequest(l))
	if out != nil || len(n.inspections) != 8 {
		t.Fatal("revoked catalogue disclosed/retried")
	}
	expectContextFailure(t, err, "COMPUTER_APPROVAL_NOT_FOUND")
}
func TestNativeDiscoveryAcrossOuterExpiryFreshTurnReconnectAndColdRestore(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	writeInstruction(t, f, "AGENTS.md", "native rules")
	issuer := issuerLeases(t, f.store, f, ceiling, tasks)
	first := admittedLease(t, issuer, authority.List)
	f.clock.ms.Add(2000)
	for _, l := range []*executionsvc.Lease{first, admittedLease(t, issuer, authority.List)} {
		contract := discoveryContract(t, f, l, filesystem.New(f.home))
		if out, err := contract.Bootstrap(context.Background(), bootstrapRequest(l, ".")); err != nil || out == nil || !out.Complete {
			t.Fatalf("outer expiry bootstrap: %v", err)
		}
		if out, err := contract.Catalogue(context.Background(), catalogueRequest(l)); err != nil || out == nil {
			t.Fatalf("outer expiry catalogue: %v", err)
		}
	}
	tasks.change(func(b *port.TaskBinding) { b.TurnID = "trusted-turn-2" })
	n := &discoveryNative{Workspace: filesystem.New(f.home)}
	out, err := discoveryContract(t, f, first, n).Bootstrap(context.Background(), bootstrapRequest(first, "."))
	if out != nil || len(n.inspections) != 0 {
		t.Fatal("old turn entered native")
	}
	expectContextFailure(t, err, "AUTHORITY_TASK_MISMATCH")
	// Reconnect and cold restore create new issuers from the SAME seal and
	// current trusted Task projection. They do not renew the old execution.
	issuer = issuerLeases(t, f.store, f, ceiling, tasks)
	second := admittedLease(t, issuer, authority.List)
	if out, err := discoveryContract(t, f, second, n).Bootstrap(context.Background(), bootstrapRequest(second, ".")); err != nil || out == nil {
		t.Fatalf("fresh trusted turn: %v", err)
	}
	store := restored(t, f)
	old, err := discoveryContract(t, f, second, n).Catalogue(context.Background(), catalogueRequest(second))
	if old != nil {
		t.Fatal("closed owner served cached collection")
	}
	expectContextFailure(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	third := admittedLease(t, issuerLeases(t, store, f, ceiling, tasks), authority.List)
	if out, err := discoveryContract(t, f, third, n).Bootstrap(context.Background(), bootstrapRequest(third, ".")); err != nil || out == nil {
		t.Fatalf("cold restored bootstrap: %v", err)
	}
}

// This wrapper observes phase boundaries BEFORE the real lease gate; it cannot
// manufacture snapshots or change the captured Binding value.
type observedLease struct {
	port.ExecutionAccessRepository
	calls int
	hook  func(int)
}

func (l *observedLease) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	l.calls++
	if l.hook != nil {
		l.hook(l.calls)
	}
	return l.ExecutionAccessRepository.WithSnapshot(ctx, id, inspect)
}
func TestNativeEmptyCatalogueFinalGateCannotBeSkipped(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*testing.T, stateFixture, *leaseTasks)
	}{
		{"none", "", func(_ *testing.T, _ stateFixture, _ *leaseTasks) {}},
		{"deadline", "AUTHORITY_EXPIRED", func(_ *testing.T, f stateFixture, _ *leaseTasks) { f.clock.ms.Add(15000) }},
		{"revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			if err := f.store.RevokeParticipant(context.Background(), status(t, f.store).Revision, "main"); err != nil {
				t.Fatal(err)
			}
		}},
		{"turn", "AUTHORITY_TASK_MISMATCH", func(_ *testing.T, _ stateFixture, o *leaseTasks) {
			o.change(func(b *port.TaskBinding) { b.TurnID = "other" })
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixtureState(t)
			f.admission.Workspaces[0].Mode = authority.Exact
			f.admission.Workspaces[0].Paths = []string{filepath.Join(f.workspace, "README.md")}
			f.admission.Capabilities = []authority.Capability{authority.Read}
			approve(t, f)
			p := admit(t, f)
			tasks := &leaseTasks{binding: &port.TaskBinding{Identity: f.admission.Identity, ParticipantID: p.ParticipantID, TurnID: "trusted-turn"}}
			l := admittedLease(t, issuerLeases(t, f.store, f, executionsvc.Ceiling{Participant: *p, Approval: f.approval}, tasks), authority.Read)
			observed := &observedLease{ExecutionAccessRepository: l, hook: func(calls int) {
				if calls == 2 {
					test.change(t, f, tasks)
				}
			}}
			n := &discoveryNative{Workspace: filesystem.New(f.home)}
			out, err := discoveryContract(t, f, observed, n).Catalogue(context.Background(), catalogueRequest(l))
			if len(n.reads) != 0 || len(n.inspections) != 0 || observed.calls != 2 {
				t.Fatal("empty catalogue used IO or skipped final gate")
			}
			if test.code == "" {
				if err != nil || out == nil || out.Workspaces == nil || len(out.Workspaces) != 0 {
					t.Fatal("explicit empty result lost")
				}
			} else {
				if out != nil {
					t.Fatal("stale empty collection published")
				}
				expectContextFailure(t, err, test.code)
			}
		})
	}
}
func TestNativeBootstrapAbsenceDoesNotHideOverallRevocation(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
	n := &discoveryNative{Workspace: filesystem.New(f.home)}
	n.hook = func(kind, _ string) {
		if kind == "read" && len(n.reads) == 2 {
			if err := f.store.RevokeApproval(context.Background(), status(t, f.store).Revision); err != nil {
				t.Fatal(err)
			}
		}
	}
	out, err := discoveryContract(t, f, l, n).Bootstrap(context.Background(), bootstrapRequest(l, "."))
	if out != nil || len(n.reads) != 2 || len(n.inspections) != 1 {
		t.Fatal("not_found bypassed final authority")
	}
	expectContextFailure(t, err, "COMPUTER_APPROVAL_NOT_FOUND")
}
func TestNativeBootstrapRootReplacementAndShortenedApprovalRefuseNextPhase(t *testing.T) {
	for _, kind := range []string{"root replacement", "approval expiry"} {
		t.Run(kind, func(t *testing.T) {
			f, ceiling, tasks := fixtureLeases(t)
			writeInstruction(t, f, "AGENTS.md", "rules")
			l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
			n := &discoveryNative{Workspace: filesystem.New(f.home)}
			n.hook = func(verb, _ string) {
				if verb == "read" && len(n.reads) == 1 {
					if kind == "root replacement" {
						if err := os.Rename(f.workspace, f.workspace+"-replaced"); err != nil {
							t.Fatal(err)
						}
						if err := os.Mkdir(f.workspace, 0700); err != nil {
							t.Fatal(err)
						}
					} else {
						a := f.approval.Clone()
						a.ExpiresAt = f.clock.Now().Add(time.Millisecond)
						if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, a); err != nil {
							t.Fatal(err)
						}
						f.clock.ms.Add(2)
					}
				}
			}
			out, err := discoveryContract(t, f, l, n).Bootstrap(context.Background(), bootstrapRequest(l, "."))
			if out != nil {
				t.Fatal("stale chain disclosed")
			}
			code := "WORKSPACE_ROOT_CHANGED"
			if kind == "approval expiry" {
				code = "AUTHORITY_EXPIRED"
			}
			expectContextFailure(t, err, code)
		})
	}
}
