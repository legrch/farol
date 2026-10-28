package process

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Compiler evidence only. Native Seatbelt and retained directory checks are separate.
func TestProtectedStateCompilerAndSeal(t *testing.T) {
	s, c := rootScopedFixture(t)
	root := "/Users/owner"
	s.Home = root
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	c.Root, c.Cwd, c.Write = root, root, true
	c.Environment = seatbeltEnvironment(s, true)
	state := &ProtectedBundle{Path: root + "/Library/Application Support/Farol/computer", Identity: authority.RootIdentity{Device: "1", Inode: "42"}}
	s.ProtectedState = state
	plan, err := compileSeatbelt(s, c)
	if err != nil {
		t.Fatal(err)
	}
	for _, alias := range mountDenialAliases(state.Path) {
		if !hasParameterRule(plan, "deny file-read* file-write* process-exec", "subpath", alias) || !hasParameterRule(plan, "deny file-write-unlink", "literal", alias) {
			t.Fatalf("state deny missing for %s", alias)
		}
	}
	if !hasParameterRule(plan, "allow file-write*", "subpath", root) || !hasParameterRule(plan, "deny file-write-unlink", "literal", root) {
		t.Fatal("ordinary root or ancestor protection missing")
	}
	seatbelt, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	state.Identity.Inode = "43"
	changed, err := compileSeatbelt(s, c)
	if err != nil || changed.digest == plan.digest {
		t.Fatal("identity not bound to seal", err)
	}
	if seatbelt.selection.ProtectedState.Identity.Inode != "42" {
		t.Fatal("selection not frozen")
	}
	c.Cwd = state.Path
	if _, err := compileSeatbelt(s, c); err == nil {
		t.Fatal("protected cwd admitted")
	}
}

func TestProtectedStatePlatformBindsAndRefusesIdentityDrift(t *testing.T) {
	baseline := platformFixtureCPU(t)
	baseSelection := baseline.selectCommand(t)
	f := platformFixtureCPU(t)
	state := &ProtectedBundle{Path: "/Users/owner/Library/Application Support/Farol/computer", Identity: authority.RootIdentity{Device: "1", Inode: "42"}}
	f.policy.ProtectedState = state
	f.facts.directories[state.Path] = platformDirectoryFacts{state.Path, "apfs", dataVolumePath, state.Identity, true, false, ""}
	f.original.Confinement = nil
	bound, err := (&Seatbelt{selection: f.policy}).bind(f.original)
	if err != nil {
		t.Fatal(err)
	}
	f.original = bound
	selection, q, deadline := f.qualify(t)
	if selection.Binding().SupportSHA256 != baseSelection.Binding().SupportSHA256 || selection.Binding().SelectionSHA256 == baseSelection.Binding().SelectionSHA256 {
		t.Fatal("wrong support or selection binding")
	}
	if err := q.ValidateBound(context.Background(), f.original, selection.WrappedCommand(), deadline); err != nil {
		t.Fatal(err)
	}
	facts := f.facts.directories[state.Path]
	facts.identity.Inode = "43"
	f.facts.directories[state.Path] = facts
	if q.ValidateBound(context.Background(), f.original, selection.WrappedCommand(), deadline) == nil {
		t.Fatal("state identity drift accepted")
	}
}
