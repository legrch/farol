package access

import (
	"context"
	"errors"
	"testing"

	leaseport "github.com/legrch/farol/modules/computer/app/port/lease"
	observationport "github.com/legrch/farol/modules/computer/app/port/observation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	lease "github.com/legrch/farol/modules/computer/domain/lease"
	obs "github.com/legrch/farol/modules/computer/domain/observation"
)

// All C5 qualifier tests are synthetic in-memory ports, NOT Darwin/system
// native, compatible-reader or actual recovery witnesses.
type qualifiedReader struct {
	proof CurrentReaderProof
	err   error
	calls int
}

func (r *qualifiedReader) ReadQualified(context.Context, journal.Entry, authority.Approval) (CurrentReaderProof, error) {
	r.calls++
	return r.proof, r.err
}

type candidateNative struct {
	acquired, held, released, requalified int
	device, inode                         uint64
	observed                              obs.Observation
	stale, closeFault, refuseHold         bool
}
type anchorNative struct {
	n      *candidateNative
	closed bool
}
type heldNative struct {
	n      *candidateNative
	closed bool
}

func (n *candidateNative) Acquire(context.Context) (leaseport.Anchor, error) {
	n.acquired++
	return &anchorNative{n: n}, nil
}
func (n *candidateNative) Hold(context.Context, string) (observationport.HeldObservation, error) {
	if n.refuseHold {
		return nil, errors.New("held descriptor refused")
	}
	n.held++
	return &heldNative{n: n}, nil
}
func (a *anchorNative) Requalify(context.Context) error {
	a.n.requalified++
	if a.closed || a.n.stale {
		return errors.New("stale startup anchor")
	}
	return nil
}
func (a *anchorNative) Check(_ context.Context, root string) (lease.Candidate, error) {
	return lease.Candidate{Path: root, Device: a.n.device, Inode: a.n.inode, Kind: "current-data-candidate", Authority: "not-established"}, nil
}
func (a *anchorNative) Close() error {
	if a.closed {
		return errors.New("double anchor close")
	}
	a.closed = true
	a.n.released++
	if a.n.closeFault {
		return errors.New("anchor close unknown")
	}
	return nil
}
func (c *heldNative) Snapshot() (obs.Observation, error) {
	if c.closed {
		return obs.Observation{}, errors.New("closed")
	}
	return c.n.observed, nil
}
func (c *heldNative) Requalify(context.Context) error {
	c.n.requalified++
	if c.closed || c.n.stale {
		return errors.New("stale candidate chain")
	}
	return nil
}
func (c *heldNative) Close() error {
	if c.closed {
		return errors.New("double candidate close")
	}
	c.closed = true
	c.n.released++
	if c.n.closeFault {
		return errors.New("candidate close unknown")
	}
	return nil
}

func nativeCurrentFixture() (journal.Entry, authority.Approval, *qualifiedReader, *candidateNative) {
	const root = "/Users/test"
	old := obs.Saved{Binding: obs.Binding{Path: root, Device: "16", Inode: "50"}, Evidence: &obs.Evidence{
		Schema: obs.EvidenceSchema, Filesystem: "apfs", VolumeUUID: "11111111-2222-3333-4444-555555555555", FileID: "50", BirthSeconds: "10", BirthNanoseconds: "7",
	}}
	current := obs.Observation{Binding: obs.Binding{Path: root, Device: "17", Inode: "50"}, Evidence: *old.Evidence}
	entry := journal.Entry{Request: journal.Request{OperationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", WorkspaceID: "work", Root: root, ConsentDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, Phase: journal.Committed, Certificate: &journal.Certificate{Kind: journal.Committed}}
	approval := authority.Approval{Generation: 4, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: root, RootIdentity: authority.RootIdentity{Device: "17", Inode: "50"}, ShellVerified: false}}}
	reader := &qualifiedReader{proof: CurrentReaderProof{Saved: old, ConsentDigest: entry.Request.ConsentDigest, SettingsRevision: 7, ComputerGeneration: 4}}
	native := &candidateNative{device: 17, inode: 50, observed: current}
	return entry, approval, reader, native
}
func TestNativeCurrentQualifierRequiresTrustedReaderAndHeldDataChain(t *testing.T) {
	entry, approval, reader, native := nativeCurrentFixture()
	ctx := context.Background()
	if _, err := NewHeldCurrentQualifier(nil, native, native).PrepareCurrent(ctx, entry, approval); err == nil || native.acquired != 0 {
		t.Fatal("missing reader acquired native chain")
	}
	qualifier := NewHeldCurrentQualifier(reader, native, native)
	w, err := qualifier.PrepareCurrent(ctx, entry, approval)
	if err != nil || w == nil || native.acquired != 1 || native.held != 1 || native.requalified != 2 || reader.calls != 1 {
		t.Fatal("first bounded native qualification", err)
	}
	if err := w.RequalifyCurrent(ctx); err != nil {
		t.Fatal("valid original chain rejected", err)
	}
	native.stale = true
	if err := w.RequalifyCurrent(ctx); err == nil {
		t.Fatal("replaced chain accepted")
	}
	if err := w.Close(); err != nil || native.released != 2 {
		t.Fatal("owned native handles not released once", err)
	}
	if err := w.Close(); err == nil || native.released != 2 {
		t.Fatal("numeric fd Close repeated")
	}
}
func TestNativeCurrentQualifierRejectsCloneMissingProofWrongScopeAndBrokenCleanup(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		mutate func(*journal.Entry, *authority.Approval, *qualifiedReader, *candidateNative)
	}{
		{"different volume", func(_ *journal.Entry, _ *authority.Approval, _ *qualifiedReader, n *candidateNative) {
			n.observed.Evidence.VolumeUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
		}},
		{"different inode", func(_ *journal.Entry, _ *authority.Approval, _ *qualifiedReader, n *candidateNative) {
			n.observed.Binding.Inode = "51"
			n.observed.Evidence.FileID = "51"
			n.inode = 51
		}},
		{"other current Data mount", func(_ *journal.Entry, _ *authority.Approval, _ *qualifiedReader, n *candidateNative) { n.device = 19 }},
		{"missing persisted evidence", func(_ *journal.Entry, _ *authority.Approval, r *qualifiedReader, _ *candidateNative) {
			r.proof.Saved.Evidence = nil
		}},
		{"wrong stable consent digest", func(_ *journal.Entry, _ *authority.Approval, r *qualifiedReader, _ *candidateNative) {
			r.proof.ConsentDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		}},
		{"stale Settings generation", func(_ *journal.Entry, _ *authority.Approval, r *qualifiedReader, _ *candidateNative) {
			r.proof.ComputerGeneration = 3
		}},
		{"workspace policy scope changed", func(_ *journal.Entry, a *authority.Approval, _ *qualifiedReader, _ *candidateNative) {
			a.Workspaces[0].Root = "/Users/other"
		}},
		{"shell carried over", func(_ *journal.Entry, a *authority.Approval, _ *qualifiedReader, _ *candidateNative) {
			a.Workspaces[0].ShellVerified = true
		}},
		{"lost compatible reader", func(_ *journal.Entry, _ *authority.Approval, r *qualifiedReader, _ *candidateNative) {
			r.err = errors.New("old reader cannot parse continuity")
		}},
		{"held candidate refused", func(_ *journal.Entry, _ *authority.Approval, _ *qualifiedReader, n *candidateNative) {
			n.refuseHold = true
		}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			entry, a, r, n := nativeCurrentFixture()
			tt.mutate(&entry, &a, r, n)
			w, err := NewHeldCurrentQualifier(r, n, n).PrepareCurrent(ctx, entry, a)
			if err == nil || w != nil {
				t.Fatalf("unqualified native candidate passed: %v", err)
			}
			if n.released != n.acquired+n.held {
				t.Fatalf("resource leak: released=%d acquired=%d held=%d", n.released, n.acquired, n.held)
			}
		})
	}
	entry, a, r, n := nativeCurrentFixture()
	n.closeFault = true
	n.refuseHold = true
	if w, err := NewHeldCurrentQualifier(r, n, n).PrepareCurrent(ctx, entry, a); err == nil || w != nil || n.released != 1 {
		t.Fatal("failed close did not refuse exactly once", err)
	}
}
