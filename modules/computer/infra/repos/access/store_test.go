package access

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	"golang.org/x/sys/unix"
)

// These fixtures use real, disposable native state/filesystem/processes. The
// clock and the post-publication fsync error are controlled; no installed
// settings, owner consent, provider conversation or shipping route is proved.
type stateClock struct{ ms atomic.Int64 }

func (c *stateClock) Now() time.Time { return time.UnixMilli(c.ms.Load()) }
func newClock() *stateClock          { c := &stateClock{}; c.ms.Store(1700000000000); return c }

var testBinding = Binding{ProfileID: "disposable-profile", OwnerID: "owner", ComputerID: "computer"}

type stateFixture struct {
	store                 *Store
	clock                 *stateClock
	root, workspace, home string
	approval              authority.Approval
	admission             authority.Admission
	participant           authority.ParticipantAdmission
}

func fixtureState(t *testing.T) stateFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := stateFixture{clock: newClock(), root: filepath.Join(base, "state"), workspace: filepath.Join(base, "workspace"), home: filepath.Join(base, "home")}
	for _, dir := range []string{f.root, f.workspace, f.home} {
		if err = os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.WriteFile(filepath.Join(f.workspace, "README.md"), []byte("disposable Brain/code read\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	if err = unix.Stat(f.workspace, &st); err != nil {
		t.Fatal(err)
	}
	f.approval = authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: f.workspace, Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: fmt.Sprint(st.Dev), Inode: fmt.Sprint(st.Ino)}}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: f.clock.Now().Add(time.Hour)}
	f.admission = authority.Admission{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7}, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 3, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: f.workspace, Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: f.clock.Now().Add(time.Minute)}}
	f.participant = authority.ParticipantAdmission{ParticipantID: "main", Role: authority.Main, MutationOwnership: authority.NoOwnership}
	f.store, err = Create(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	return f
}
func status(t *testing.T, s *Store) Status {
	t.Helper()
	v, err := s.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func approve(t *testing.T, f stateFixture) {
	t.Helper()
	if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, f.approval); err != nil {
		t.Fatal(err)
	}
}
func admit(t *testing.T, f stateFixture) *authority.Participant {
	t.Helper()
	p, err := f.store.Admit(context.Background(), status(t, f.store).Revision, f.admission, f.participant)
	if err != nil || p == nil {
		t.Fatalf("admit: %v", err)
	}
	return p
}
func failCode(t *testing.T, err error, code string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != code || f.Retry != "never" {
		t.Fatalf("want %s/never, got %v", code, err)
	}
}
func snapshot(t *testing.T, s *Store, id string) port.AccessSnapshot {
	t.Helper()
	var out port.AccessSnapshot
	err := s.WithSnapshot(context.Background(), id, func(v port.AccessSnapshot) error { out = v; return nil })
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func restored(t *testing.T, f stateFixture) *Store {
	t.Helper()
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestPrivateStoreStartsEmptyAndRestoresExactBoundIdentity(t *testing.T) {
	f := fixtureState(t)
	if v := status(t, f.store); v.Revision != 0 || v.Generation != 0 || v.ApprovalPresent {
		t.Fatalf("fabricated default: %#v", v)
	}
	if v := snapshot(t, f.store, "main"); v.Participant != nil || v.Approval != nil {
		t.Fatal("empty state fabricated authority")
	}
	_, err := f.store.Admit(context.Background(), 0, f.admission, f.participant)
	failCode(t, err, "COMPUTER_APPROVAL_NOT_FOUND")
	approve(t, f)
	p := admit(t, f)
	if _, err = Open(f.root, testBinding, f.clock); err == nil {
		t.Fatal("second backend acquired native ownership")
	}
	s := restored(t, f)
	if v := status(t, s); v.Revision != 2 || v.Generation != 3 || !v.ApprovalPresent {
		t.Fatalf("lost durable state: %#v", v)
	}
	v := snapshot(t, s, "main")
	if v.Participant == nil || v.Participant.Grant.AuthorityID != p.Grant.AuthorityID || v.Approval == nil {
		t.Fatal("restore lost participant/approval")
	}
	s.Close()
	for _, b := range []Binding{{"other-profile", "owner", "computer"}, {"disposable-profile", "other-owner", "computer"}, {"disposable-profile", "owner", "other-computer"}} {
		if _, err = Open(f.root, b, f.clock); err == nil {
			t.Fatal("restored crossed profile/owner/computer binding")
		}
	}
	if _, err = Create(f.root, testBinding, f.clock); err == nil {
		t.Fatal("Create replaced existing authority")
	}
	if _, err = Open(filepath.Join(f.home, "missing"), testBinding, f.clock); err == nil {
		t.Fatal("missing store became default consent")
	}
}
func TestApprovalGenerationAndRevocationDefeatCachedReissueAcrossRestart(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	admit(t, f)
	stale := approval(f.approval)
	stale.Generation--
	failCode(t, f.store.UpdateApproval(context.Background(), 2, stale), "AUTHORITY_COMPUTER_MISMATCH")
	widened := approval(f.approval)
	widened.Capabilities = append(widened.Capabilities, authority.Shell)
	failCode(t, f.store.UpdateApproval(context.Background(), 2, widened), "AUTHORITY_COMPUTER_MISMATCH")
	renewed := approval(f.approval)
	renewed.ExpiresAt = renewed.ExpiresAt.Add(time.Hour)
	if err := f.store.UpdateApproval(context.Background(), 2, renewed); err != nil {
		t.Fatal(err)
	}
	if v := snapshot(t, f.store, "main"); !v.Participant.Grant.ExpiresAt.Equal(f.admission.ExpiresAt) {
		t.Fatal("approval renewal extended admitted grant")
	}
	if err := f.store.RevokeApproval(context.Background(), 3); err != nil {
		t.Fatal(err)
	}
	s := restored(t, f)
	if v := snapshot(t, s, "main"); v.Participant == nil || v.Approval != nil {
		t.Fatal("revocation disappeared across restart")
	}
	failCode(t, s.UpdateApproval(context.Background(), 4, renewed), "AUTHORITY_COMPUTER_MISMATCH")
	renewed.Generation = 4
	if err := s.UpdateApproval(context.Background(), 4, renewed); err != nil {
		t.Fatal(err)
	}
	// The old grant is still present, but the current approval generation wins.
	v := snapshot(t, s, "main")
	action := authority.Action{Identity: f.admission.Identity, Operation: authority.Operation{Kind: authority.Read, WorkspaceID: "work", Path: f.workspace + "/README.md"}}
	failCode(t, authority.AuthorizeComputer(*v.Participant, *v.Approval, action, f.clock.Now()), "AUTHORITY_COMPUTER_MISMATCH")
}
func TestTrustedAdmissionCannotBroadenOwnerPolicyOrRebindParticipant(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	for _, change := range []func(*authority.Admission){func(v *authority.Admission) { v.Capabilities = append(v.Capabilities, authority.Shell) }, func(v *authority.Admission) { v.Workspaces[0].Root = f.home }, func(v *authority.Admission) { v.ExpiresAt = f.approval.ExpiresAt.Add(time.Millisecond) }, func(v *authority.Admission) { v.Network = authority.ApprovedNetwork }} {
		a := f.admission
		a.Policy = f.admission.Policy
		a.Workspaces = append([]authority.Scope(nil), f.admission.Workspaces...)
		a.Capabilities = append([]authority.Capability(nil), f.admission.Capabilities...)
		change(&a)
		p, err := f.store.Admit(context.Background(), 1, a, f.participant)
		if p != nil {
			t.Fatal("returned inflated participant")
		}
		failCode(t, err, "AUTHORITY_INFLATION_DENIED")
	}
	p := admit(t, f)
	p.Grant.Workspaces[0].Root = f.home
	p.Grant.Capabilities[0] = authority.Shell
	v := snapshot(t, f.store, "main")
	if v.Participant.Grant.Workspaces[0].Root != f.workspace || v.Participant.Grant.Capabilities[0] != authority.Read {
		t.Fatal("return value aliased owner state")
	}
	s := restored(t, f)
	// Exact repeated admission observes the existing immutable participant. It
	// performs no persistence and does not change revision or expiry.
	p, err := s.Admit(context.Background(), 2, f.admission, f.participant)
	if err != nil || p == nil || status(t, s).Revision != 2 {
		t.Fatalf("duplicate not observational: %v", err)
	}
	changed := f.participant
	changed.Role = authority.Agent
	_, err = s.Admit(context.Background(), 2, f.admission, changed)
	failCode(t, err, "AUTHORITY_TASK_MISMATCH")
}
func TestDelegationAndParticipantRevocationPersistWithoutResurrection(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	admit(t, f)
	child := authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: "child", Role: authority.Critic, MutationOwnership: authority.NoOwnership}, Narrowing: &authority.Narrowing{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: f.workspace, Mode: authority.Exact, Paths: []string{f.workspace + "/README.md"}, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands}}
	p, err := f.store.Delegate(context.Background(), 2, "main", child)
	if err != nil || p.ParentParticipantID != "main" {
		t.Fatalf("delegate: %v", err)
	}
	child.ParticipantID = "inflated"
	child.Narrowing.Capabilities = []authority.Capability{authority.Write}
	_, err = f.store.Delegate(context.Background(), 3, "main", child)
	failCode(t, err, "AUTHORITY_INFLATION_DENIED")
	if err = f.store.RevokeParticipant(context.Background(), 3, "main"); err != nil {
		t.Fatal(err)
	}
	s := restored(t, f)
	for _, id := range []string{"main", "child"} {
		if v := snapshot(t, s, id); v.Participant != nil {
			t.Fatal("revoked lineage restored as active")
		}
	}
	_, err = s.Admit(context.Background(), 4, f.admission, f.participant)
	failCode(t, err, "AUTHORITY_TASK_MISMATCH")
	_, err = s.Delegate(context.Background(), 4, "main", child)
	failCode(t, err, "COMPUTER_PARTICIPANT_NOT_FOUND")
}
func TestEveryMutationSerializesWithDisclosureSnapshot(t *testing.T) {
	for _, kind := range []string{"approval", "approval-revoke", "participant", "participant-revoke", "delegate"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			admit(t, f)
			started, done := make(chan struct{}), make(chan error, 1)
			err := f.store.WithSnapshot(context.Background(), "main", func(v port.AccessSnapshot) error {
				go func() {
					close(started)
					var err error
					switch kind {
					case "approval":
						a := approval(f.approval)
						a.ExpiresAt = a.ExpiresAt.Add(time.Hour)
						err = f.store.UpdateApproval(context.Background(), 2, a)
					case "approval-revoke":
						err = f.store.RevokeApproval(context.Background(), 2)
					case "participant":
						id := f.participant
						id.ParticipantID = "next"
						_, err = f.store.Admit(context.Background(), 2, f.admission, id)
					case "participant-revoke":
						err = f.store.RevokeParticipant(context.Background(), 2, "main")
					case "delegate":
						_, err = f.store.Delegate(context.Background(), 2, "main", authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: "child", Role: authority.Critic, MutationOwnership: authority.NoOwnership}})
					}
					done <- err
				}()
				<-started
				select {
				case err := <-done:
					t.Fatalf("mutation crossed disclosure callback: %v", err)
				case <-time.After(10 * time.Millisecond):
				}
				v.Participant.Grant.Capabilities[0] = authority.Shell
				v.Approval.Workspaces[0].Root = f.home
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("mutation never completed")
			}
			if status(t, f.store).Revision != 3 {
				t.Fatal("mutation did not publish one revision")
			}
			v := snapshot(t, f.store, "next")
			if kind == "participant" && (v.Participant == nil || v.Participant.Grant.Capabilities[0] != authority.Read || v.Approval.Workspaces[0].Root != f.workspace) {
				t.Fatal("callback changed owner state")
			}
		})
	}
}
func TestConcurrentStaleRevisionCannotLoseRevocation(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	admit(t, f)
	start, done := make(chan struct{}), make(chan error, 2)
	for range 2 {
		go func() { <-start; done <- f.store.RevokeApproval(context.Background(), 2) }()
	}
	close(start)
	good, bad := 0, 0
	for range 2 {
		err := <-done
		if err == nil {
			good++
		} else {
			failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			bad++
		}
	}
	if good != 1 || bad != 1 || status(t, f.store).ApprovalPresent {
		t.Fatal("lost or repeated authority mutation")
	}
}
func TestPublishedUpdateErrorNeedsQualifiedRestoreAndDoesNotReplay(t *testing.T) {
	for _, kind := range []string{"approval", "participant", "revocation"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			if kind == "revocation" {
				admit(t, f)
			}
			revision := status(t, f.store).Revision
			published := 0
			f.store.disk.syncDirectory = func(int) error { published++; return unix.EIO }
			var err error
			switch kind {
			case "approval":
				a := approval(f.approval)
				a.Generation++
				err = f.store.UpdateApproval(context.Background(), revision, a)
			case "participant":
				var p *authority.Participant
				p, err = f.store.Admit(context.Background(), revision, f.admission, f.participant)
				if p != nil {
					t.Fatal("unknown commit returned admitted authority")
				}
			case "revocation":
				err = f.store.RevokeApproval(context.Background(), revision)
			}
			if !OutcomeUnknown(err) || published != 1 {
				t.Fatalf("lost possible publication: %v", err)
			}
			failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			called := 0
			failCode(t, f.store.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { called++; return nil }), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			if called != 0 {
				t.Fatal("poisoned owner disclosed cached authority")
			}
			s := restored(t, f)
			v := status(t, s)
			if v.Revision != revision+1 {
				t.Fatal("published update was lost or replayed")
			}
			if kind == "approval" && v.Generation != 4 || kind == "participant" && snapshot(t, s, "main").Participant == nil || kind == "revocation" && v.ApprovalPresent {
				t.Fatal("restart did not observe published state")
			}
			entries, err := os.ReadDir(f.root)
			if err != nil || len(entries) != 2 {
				t.Fatalf("temporary state leaked: %v", err)
			}
		})
	}
}
func TestPrivateNativeStateRefusesUnsafeFilesAndExternalChanges(t *testing.T) {
	cases := []string{"mode", "symlink", "hardlink", "fifo", "directory", "missing", "corrupt", "truncated", "oversized", "valid-replacement", "root-replaced", "lock-replaced"}
	for _, kind := range cases {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			admit(t, f)
			file := filepath.Join(f.root, stateName)
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "mode":
				err = os.Chmod(file, 0644)
			case "symlink":
				err = os.Rename(file, filepath.Join(f.home, "original"))
				if err == nil {
					err = os.Symlink(filepath.Join(f.home, "original"), file)
				}
			case "hardlink":
				err = os.Link(file, filepath.Join(f.home, "alias"))
			case "fifo":
				err = os.Remove(file)
				if err == nil {
					err = unix.Mkfifo(file, 0600)
				}
			case "directory":
				err = os.Remove(file)
				if err == nil {
					err = os.Mkdir(file, 0700)
				}
			case "missing":
				err = os.Remove(file)
			case "corrupt":
				err = os.WriteFile(file, []byte("{broken"), 0600)
			case "truncated":
				err = os.WriteFile(file, raw[:len(raw)/2], 0600)
			case "oversized":
				err = os.WriteFile(file, make([]byte, maxStateBytes+1), 0600)
			case "valid-replacement":
				n := f.store.current
				n.Revision++
				var changed []byte
				changed, err = encodeState(testBinding, n)
				if err == nil {
					err = os.WriteFile(filepath.Join(f.root, "replacement"), changed, 0600)
				}
				if err == nil {
					err = os.Rename(filepath.Join(f.root, "replacement"), file)
				}
			case "root-replaced":
				err = os.Rename(f.root, f.root+"-old")
				if err == nil {
					err = os.Mkdir(f.root, 0700)
				}
			case "lock-replaced":
				err = os.Remove(filepath.Join(f.root, lockName))
				if err == nil {
					err = os.WriteFile(filepath.Join(f.root, lockName), nil, 0600)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			called := 0
			err = f.store.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { called++; return nil })
			failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			if called != 0 || OutcomeUnknown(err) {
				t.Fatal("unsafe source became missing authority or disclosed state")
			}
		})
	}
}
func TestRestoreRejectsClosedSchemaCorruptionAndPreservesLosslessCounters(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	admit(t, f)
	raw, err := encodeState(testBinding, f.store.current)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(string(raw), `"schema":1`, `"schema":2`, 1),
		strings.Replace(string(raw), `"schema":1`, `"schema":1,"unknown":true`, 1),
		strings.Replace(string(raw), `"schema":1`, `"schema":1,"schema":1`, 1),
		strings.Replace(string(raw), `"schema":1`, `"Schema":1`, 1),
		strings.Replace(string(raw), `"taskEpoch":"7"`, `"taskEpoch":"07"`, 1),
		strings.Replace(string(raw), `"mode":"subtree"`, `"mode":"anything"`, 1),
		strings.Replace(string(raw), `"role":"main"`, `"role":"root"`, 1),
		string(raw) + "{}",
	} {
		if _, err = decodeState(testBinding, []byte(bad)); err == nil {
			t.Fatal("invalid document became trusted authority")
		}
		if err = os.WriteFile(filepath.Join(f.root, stateName), []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = Open(f.root, testBinding, f.clock); err == nil {
			t.Fatal("native restore trusted corrupt document")
		}
	}
	n := f.store.current
	n.Revision = uint64(1)<<63 + 1
	n.Generation = uint64(1)<<63 + 2
	a := approval(*n.Approval)
	a.Generation = n.Generation
	n.Approval = &a
	p := n.Participants["main"]
	p.Value = participant(p.Value)
	p.Value.Grant.TaskEpoch = uint64(1)<<63 + 3
	p.Value.Grant.ComputerGeneration = n.Generation
	n.Participants = map[string]retainedParticipant{"main": p}
	raw, err = encodeState(testBinding, n)
	if err != nil {
		t.Fatal(err)
	}
	out, err := decodeState(testBinding, raw)
	if err != nil || out.Revision != n.Revision || out.Generation != n.Generation || out.Participants["main"].Value.Grant.TaskEpoch != p.Value.Grant.TaskEpoch {
		t.Fatalf("lossy counter: %v", err)
	}
}

type observedWorkspace struct {
	port.Workspace
	after func()
}

func (w observedWorkspace) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	v, err := w.Workspace.Read(ctx, r)
	if err == nil && w.after != nil {
		w.after()
	}
	return v, err
}
func TestRealFilesystemReadRechecksDurableOwnerBeforeDisclosureAndRestart(t *testing.T) {
	for _, kind := range []string{"unchanged", "approval-revoke", "participant-revoke", "generation", "expired", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			admit(t, f)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			native := observedWorkspace{Workspace: filesystem.New(f.home), after: func() {
				var err error
				switch kind {
				case "approval-revoke":
					err = f.store.RevokeApproval(context.Background(), 2)
				case "participant-revoke":
					err = f.store.RevokeParticipant(context.Background(), 2, "main")
				case "generation":
					a := approval(f.approval)
					a.Generation++
					err = f.store.UpdateApproval(context.Background(), 2, a)
				case "expired":
					f.clock.ms.Add(int64(2 * time.Minute / time.Millisecond))
				case "cancelled":
					cancel()
				}
				if err != nil {
					t.Fatal(err)
				}
			}}
			svc := workspacesvc.New(f.store, native, f.clock)
			request := workspacesvc.ReadRequest{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "main", TurnID: "turn", Generation: 55, CallID: "call", WorkspaceID: "work", RelativePath: "README.md"}
			response, err := svc.Read(ctx, request)
			if kind == "unchanged" {
				if err != nil || response == nil || response.Text != "disposable Brain/code read\n" {
					t.Fatalf("real read: %v", err)
				}
				return
			}
			if response != nil {
				t.Fatal("revoked/expired/cancelled native bytes disclosed")
			}
			want := map[string]string{"approval-revoke": "COMPUTER_APPROVAL_NOT_FOUND", "participant-revoke": "COMPUTER_PARTICIPANT_NOT_FOUND", "generation": "AUTHORITY_COMPUTER_MISMATCH", "expired": "AUTHORITY_EXPIRED", "cancelled": "WORKSPACE_REQUEST_CANCELLED"}[kind]
			failCode(t, err, want)
			s := restored(t, f)
			if kind != "cancelled" {
				response, err = workspacesvc.New(s, filesystem.New(f.home), f.clock).Read(context.Background(), request)
				if response != nil {
					t.Fatal("restart resurrected authority")
				}
				failCode(t, err, want)
			}
		})
	}
}
func TestNativeOwnerLockAcrossProcesses(t *testing.T) {
	if root := os.Getenv("FAROL_ACCESS_CHILD_ROOT"); root != "" {
		s, err := Open(root, testBinding, newClock())
		if err != nil {
			t.Fatal(err)
		}
		fmt.Println("owned")
		if _, err = bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			t.Fatal(err)
		}
		if err = s.Close(); err != nil {
			t.Fatal(err)
		}
		return
	}
	f := fixtureState(t)
	approve(t, f)
	admit(t, f)
	f.store.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeOwnerLockAcrossProcesses$")
	command.Env = []string{"FAROL_ACCESS_CHILD_ROOT=" + f.root, "PATH=/usr/bin:/bin"}
	out, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		if !waited {
			command.Process.Kill()
			command.Wait()
		}
	})
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || line != "owned\n" {
		t.Fatalf("child ownership not witnessed: %v", err)
	}
	if _, err = Open(f.root, testBinding, f.clock); err == nil {
		t.Fatal("another backend bypassed native lifetime ownership")
	}
	if _, err = input.Write([]byte("close\n")); err != nil {
		t.Fatal(err)
	}
	input.Close()
	err = command.Wait()
	waited = true
	if err != nil || command.ProcessState.ExitCode() != 0 {
		t.Fatalf("owned child not terminal: %v", err)
	}
	s, err := Open(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
}

func TestCreateRefusesUnsafePrivateDirectoryAndLock(t *testing.T) {
	for _, kind := range []string{"directory-mode", "root-symlink", "lock-mode", "lock-symlink", "lock-hardlink"} {
		t.Run(kind, func(t *testing.T) {
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(base, "state")
			if err = os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			candidate := root
			switch kind {
			case "directory-mode":
				err = os.Chmod(root, 0755)
			case "root-symlink":
				candidate = filepath.Join(base, "alias")
				err = os.Symlink(root, candidate)
			case "lock-mode":
				err = os.WriteFile(filepath.Join(root, lockName), nil, 0644)
			case "lock-symlink":
				target := filepath.Join(base, "target")
				err = os.WriteFile(target, nil, 0600)
				if err == nil {
					err = os.Symlink(target, filepath.Join(root, lockName))
				}
			case "lock-hardlink":
				target := filepath.Join(base, "target")
				err = os.WriteFile(target, nil, 0600)
				if err == nil {
					err = os.Link(target, filepath.Join(root, lockName))
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			s, err := Create(candidate, testBinding, newClock())
			if s != nil {
				s.Close()
				t.Fatal("unsafe authority owner acquired")
			}
			failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			if _, err = os.Lstat(filepath.Join(root, stateName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("unsafe source created authority state")
			}
		})
	}
}
func TestRestoreRejectsInflatedOrBrokenDelegation(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	admit(t, f)
	_, err := f.store.Delegate(context.Background(), 2, "main", authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: "child", Role: authority.Critic, MutationOwnership: authority.NoOwnership}, Narrowing: &authority.Narrowing{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: f.workspace, Mode: authority.Exact, Paths: []string{f.workspace + "/README.md"}, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands}})
	if err != nil {
		t.Fatal(err)
	}
	f.store.Close()
	for _, kind := range []string{"scope", "capability", "expiry", "generation", "missing-parent", "cycle", "revoked-parent", "exclusion"} {
		t.Run(kind, func(t *testing.T) {
			n := f.store.current
			n.Participants = map[string]retainedParticipant{}
			for id, v := range f.store.current.Participants {
				n.Participants[id] = retainedParticipant{Value: participant(v.Value), Revoked: v.Revoked}
			}
			child := n.Participants["child"]
			switch kind {
			case "scope":
				child.Value.Grant.Workspaces[0].Root = f.home
				child.Value.Grant.Workspaces[0].Paths = []string{f.home + "/README.md"}
			case "capability":
				child.Value.Grant.Capabilities = append(child.Value.Grant.Capabilities, authority.Shell)
			case "expiry":
				child.Value.Grant.ExpiresAt = child.Value.Grant.ExpiresAt.Add(time.Hour)
			case "generation":
				child.Value.Grant.ComputerGeneration++
			case "missing-parent":
				child.Value.ParentParticipantID = "absent"
			case "cycle":
				parent := n.Participants["main"]
				parent.Value.ParentParticipantID = "child"
				n.Participants["main"] = parent
			case "revoked-parent":
				parent := n.Participants["main"]
				parent.Revoked = true
				n.Participants["main"] = parent
			case "exclusion":
				parent := n.Participants["main"]
				parent.Value.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: f.workspace + "/README.md", RestrictionSource: authority.TaskGrantSource}}
				n.Participants["main"] = parent
			}
			n.Participants["child"] = child
			raw, err := encodeState(testBinding, n)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(f.root, stateName), raw, 0600); err != nil {
				t.Fatal(err)
			}
			s, err := Open(f.root, testBinding, f.clock)
			if s != nil {
				s.Close()
				t.Fatal("restore widened delegated authority")
			}
			failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
		})
	}
}
func TestInvalidClockAndCancelledAdmissionDoNotPublish(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := f.store.Admit(ctx, 1, f.admission, f.participant)
	failCode(t, err, "WORKSPACE_REQUEST_CANCELLED")
	f.clock.ms.Store(-1)
	_, err = f.store.Admit(context.Background(), 1, f.admission, f.participant)
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	if v := status(t, f.store); v.Revision != 1 || snapshot(t, f.store, "main").Participant != nil {
		t.Fatal("invalid admission published effects")
	}
}

func TestRestoreBarrierFailureDoesNotEnableUnknownPublishedAuthority(t *testing.T) {
	for _, kind := range []string{"file-sync", "directory-sync", "post-sync-race"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			f.store.disk.syncDirectory = func(int) error { return unix.EIO }
			p, original := f.store.Admit(context.Background(), 1, f.admission, f.participant)
			if p != nil || !OutcomeUnknown(original) {
				t.Fatal("publication was not retained as unknown")
			}
			f.store.Close()
			file := filepath.Join(f.root, stateName)
			before, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			fileSyncs, dirSyncs := 0, 0
			factory := func(root string) (*disk, error) {
				d, err := openDisk(root)
				if err != nil {
					return nil, err
				}
				d.syncSnapshot = func(fd int) error {
					fileSyncs++
					if kind == "file-sync" {
						return unix.EIO
					}
					return unix.Fsync(fd)
				}
				d.syncDirectory = func(fd int) error {
					dirSyncs++
					if kind == "directory-sync" {
						return unix.EIO
					}
					if err := unix.Fsync(fd); err != nil {
						return err
					}
					if kind == "post-sync-race" {
						return os.WriteFile(file, []byte("{corrupt-after-sync"), 0600)
					}
					return nil
				}
				return d, nil
			}
			owner, err := openWithDisk(f.root, testBinding, f.clock, false, factory)
			if owner != nil {
				owner.Close()
				t.Fatal("failed restore barrier enabled authority")
			}
			failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			if !OutcomeUnknown(original) || fileSyncs != 1 || (kind == "file-sync" && dirSyncs != 0) || (kind != "file-sync" && dirSyncs != 1) {
				t.Fatal("restore bypassed durability guard or changed original outcome")
			}
			after, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if kind != "post-sync-race" && string(after) != string(before) {
				t.Fatal("failed reconciliation replayed or rewrote the admission")
			}
			entries, err := os.ReadDir(f.root)
			if err != nil || len(entries) != 2 {
				t.Fatal("restore created a second journal or publication")
			}
		})
	}
}
func TestRestoreMustSyncExactObservedFileAndDirectoryBeforeUse(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	_, original := f.store.Admit(context.Background(), 1, f.admission, f.participant)
	if !OutcomeUnknown(original) {
		t.Fatal("expected publication unknown")
	}
	f.store.Close()
	raw, err := os.ReadFile(filepath.Join(f.root, stateName))
	if err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	factory := func(root string) (*disk, error) {
		d, err := openDisk(root)
		if err != nil {
			return nil, err
		}
		d.syncSnapshot = func(fd int) error { calls = append(calls, "file"); return unix.Fsync(fd) }
		d.syncDirectory = func(fd int) error { calls = append(calls, "directory"); return unix.Fsync(fd) }
		return d, nil
	}
	owner, err := openWithDisk(f.root, testBinding, f.clock, false, factory)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if strings.Join(calls, ",") != "file,directory" {
		t.Fatal("visible bytes promoted before native durability barrier")
	}
	if status(t, owner).Revision != 2 || snapshot(t, owner, "main").Participant == nil || !OutcomeUnknown(original) {
		t.Fatal("restore replayed admission or rewrote its original unknown result")
	}
	after, err := os.ReadFile(filepath.Join(f.root, stateName))
	if err != nil || string(after) != string(raw) {
		t.Fatal("restore did not observe the exact original publication")
	}
}
