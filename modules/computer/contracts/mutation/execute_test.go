package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Contract fixtures are injected and in-process, not wire/native/live evidence.
type contractClock struct{ now time.Time }

func (c contractClock) Now() time.Time { return c.now }

type contractLease struct {
	b        port.TaskBinding
	p        authority.Participant
	a        authority.Approval
	deadline time.Time
	fail     bool
}

func (l *contractLease) Binding() port.TaskBinding { return l.b }
func (l *contractLease) Deadline() time.Time       { return l.deadline }
func (l *contractLease) WithSnapshot(_ context.Context, _ string, f func(port.AccessSnapshot) error) error {
	if l.fail {
		return errors.New("private native diagnostic")
	}
	p, a := l.p.Clone(), l.a.Clone()
	return f(port.AccessSnapshot{Participant: &p, Approval: &a})
}

type contractStore struct {
	record            *domain.State
	admit, save, load int
}

func (j *contractStore) Admit(_ context.Context, r *domain.State) (port.MutationAdmission, error) {
	j.admit++
	if j.record != nil {
		copy := j.record.Clone()
		return port.MutationAdmission{Status: port.MutationExisting, Record: &copy}, nil
	}
	copy := r.Clone()
	j.record = &copy
	out := copy.Clone()
	return port.MutationAdmission{Status: port.MutationAdmitted, Record: &out}, nil
}
func (j *contractStore) Save(_ context.Context, r *domain.State) error {
	j.save++
	copy := r.Clone()
	j.record = &copy
	return nil
}
func (j *contractStore) Load(_ context.Context, _ domain.Identity) (*domain.State, error) {
	j.load++
	if j.record == nil {
		return nil, nil
	}
	copy := j.record.Clone()
	return &copy, nil
}

type contractDigest struct{}

func (contractDigest) Digest(port.MutationDigestInput) (string, error) {
	return strings.Repeat("a", 64), nil
}

type contractNative struct {
	calls   int
	receipt *port.MutationReceipt
	err     error
}

func (n *contractNative) Mutate(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
	n.calls++
	if err := r.BeforePublish(ctx); err != nil {
		return nil, err
	}
	return n.receipt, n.err
}
func contractFixture(t *testing.T) (*Contract, *contractLease, *contractStore, *contractNative, ExecuteRequest) {
	t.Helper()
	now := time.Unix(1700000000, 0)
	b := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"}
	lease := &contractLease{b: b, deadline: now.Add(15 * time.Second), p: authority.Participant{ParticipantID: "participant", MutationOwnership: authority.TaskOwnership, Grant: authority.Grant{Identity: b.Identity, ComputerID: "computer", ComputerGeneration: 7, Policy: authority.Policy{ExpiresAt: now.Add(15 * time.Second), Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: []authority.Capability{authority.Write}}}}, a: authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7, ExpiresAt: now.Add(time.Hour), Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "7", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Write}}}
	journal := &contractStore{}
	hash := strings.Repeat("b", 64)
	native := &contractNative{receipt: &port.MutationReceipt{Operation: "edit", RelativePath: "note.md", Bytes: 3, Replacements: 1, BeforeSHA256: &hash, AfterSHA256: strings.Repeat("c", 64)}}
	service, err := app.NewForExecution("op", lease, journal, native, contractDigest{}, &sync.Mutex{}, contractClock{now: now})
	if err != nil {
		t.Fatal(err)
	}
	r := ExecuteRequest{OperationID: "op", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", Generation: 90, CallID: "call", WorkspaceID: "work", Operation: Edit{RelativePath: "note.md", ExpectedSHA256: hash, Edits: []TextEdit{{OldText: "old", NewText: "new"}}}}
	return New(service), lease, journal, native, r
}
func TestMutationContractDelegationAndCopyIsolation(t *testing.T) {
	c, _, store, native, r := contractFixture(t)
	out, err := c.Execute(context.Background(), r)
	if err != nil || out.Phase != "completed" || out.Receipt.Replacements != 1 || out.Generation != 90 || out.CallID != "call" {
		t.Fatalf("%#v %v", out, err)
	}
	*out.Receipt.BeforeSHA256 = "changed"
	native.receipt.AfterSHA256 = "changed"
	r.CallID = "next"
	out, err = c.Execute(context.Background(), r)
	if err != nil || *out.Receipt.BeforeSHA256 != strings.Repeat("b", 64) || out.Receipt.AfterSHA256 != strings.Repeat("c", 64) || out.CallID != "next" || native.calls != 1 || store.save != 1 {
		t.Fatalf("copy/replay %#v %v", out, err)
	}
}
func TestMutationContractUnknownClosedFailureAndNil(t *testing.T) {
	c, lease, _, native, r := contractFixture(t)
	native.err = errors.New("private raw failure")
	native.receipt = nil
	out, err := c.Execute(context.Background(), r)
	if err != nil || out.Phase != "outcome_unknown" || out.Failure.Retry != "never" || out.Failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		t.Fatalf("%#v %v", out, err)
	}
	lease.fail = true
	out, err = c.Execute(context.Background(), r)
	var failure *Failure
	if out != nil || !errors.As(err, &failure) || failure.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || failure.Retry != "never" {
		t.Fatal(err)
	}
	err = boundary(authority.Fail("PRIVATE_ERROR", "private-source"))
	if !errors.As(err, &failure) || failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		t.Fatal("unclassified diagnostics exposed")
	}
	var absent *Contract
	out, err = absent.Execute(context.Background(), r)
	if out != nil || err == nil {
		t.Fatal("nil contract accepted")
	}
}
