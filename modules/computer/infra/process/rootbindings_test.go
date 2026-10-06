package process

import (
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure synthetic policy/seal/launch construction. No filesystem or dispatch.
func TestRootBindingsRefuseConflictingEffectiveOverlaps(t *testing.T) {
	for _, ownerRead := range []bool{false, true} {
		for _, reverse := range []bool{false, true} {
			for _, secondary := range []string{"/approved/work/project/toolchain", "/APPROVED/WORK/PROJECT/toolchain", "/approved/wórk/project/toolchain", "/approved/work", "/approved/work/project"} {
				s, c := rootScopedFixture(t)
				c.Write = true
				c.Environment = seatbeltEnvironment(s, true)
				addRootScope(&s, "secondary", secondary, authority.WriteAccess)
				if ownerRead {
					s.Snapshot.Approval.Workspaces[1].Access = authority.ReadAccess
				} else {
					s.Snapshot.Participant.Grant.Workspaces[1].Access = authority.ReadAccess
				}
				if reverse {
					w := s.Snapshot.Participant.Grant.Workspaces
					w[0], w[1] = w[1], w[0]
				}
				plan, err := compileSeatbelt(s, c)
				var failure *processsvc.NativeFailure
				if plan != nil || !errors.As(err, &failure) || failure.Unknown {
					t.Fatalf("conflict accepted: %s ownerRead=%v reverse=%v: %v", secondary, ownerRead, reverse, err)
				}
				// Sensitivity control: narrowing every scope to read makes it coherent.
				c.Write = false
				c.Environment = seatbeltEnvironment(s, false)
				if _, err := compileSeatbelt(s, c); err != nil {
					t.Fatal("globally read-only overlap refused", err)
				}
			}
		}
	}
	// Ordinary same-access overlap and segment siblings retain their grants.
	for _, path := range []string{"/approved/work/project/toolchain", "/approved/work/projects"} {
		s, c := rootScopedFixture(t)
		c.Write = true
		c.Environment = seatbeltEnvironment(s, true)
		addRootScope(&s, "secondary", path, authority.WriteAccess)
		if path == "/approved/work/projects" {
			s.Snapshot.Approval.Workspaces[1].Access = authority.ReadAccess
		}
		if _, err := compileSeatbelt(s, c); err != nil {
			t.Fatal("nonconflicting roots refused", err)
		}
	}
}

func TestRootBindingsEverySecondaryIdentityAndAncestorAreSealed(t *testing.T) {
	s, c := rootScopedFixture(t)
	addRootScope(&s, "git-common", "/approved/git", authority.WriteAccess)
	addRootScope(&s, "toolchain", "/approved/tools", authority.ReadAccess)
	s.Snapshot.Participant.Grant.Workspaces[1].Root += "/common"
	s.Snapshot.Participant.Grant.Workspaces[2].Root += "/bin"
	evidence := &confinementEvidenceDouble{}
	selected, err := NewSeatbelt(s, evidence)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := New(c, selected, &testClock{})
	if err != nil {
		t.Fatal(err)
	}
	launch, err := selectedLaunch(selected, prepared.command)
	if err != nil {
		t.Fatal(err)
	}
	expected := []rootScopeBinding{
		{"work", c.Root, "/approved/work/project", c.RootIdentity, authority.ReadAccess},
		{"git-common", "/approved/git", "/approved/git/common", authority.RootIdentity{Device: "1", Inode: "29"}, authority.ReadAccess},
		{"toolchain", "/approved/tools", "/approved/tools/bin", authority.RootIdentity{Device: "1", Inode: "29"}, authority.ReadAccess},
	}
	if !reflect.DeepEqual(launch.roots, expected) {
		t.Fatalf("lost physical or effective bindings: %+v", launch.roots)
	}
	if !prepared.MatchesPolicy(s.Snapshot) {
		t.Fatal("identical policy refused")
	}
	for _, index := range []int{1, 2} {
		for _, field := range []string{"device", "inode", "ancestor"} {
			p, a := s.Snapshot.Participant.Clone(), s.Snapshot.Approval.Clone()
			snapshot := port.AccessSnapshot{Participant: &p, Approval: &a}
			switch field {
			case "device":
				a.Workspaces[index].RootIdentity.Device = "7"
			case "inode":
				a.Workspaces[index].RootIdentity.Inode = "31"
			case "ancestor":
				a.Workspaces[index].Root = "/approved"
			}
			nextSelection := s
			nextSelection.Snapshot = snapshot
			next, err := NewSeatbelt(nextSelection, evidence)
			if err != nil {
				t.Fatal(err)
			}
			nextPrepared, err := New(c, next, &testClock{})
			if err != nil || nextPrepared.Seal().Digest == prepared.Seal().Digest {
				t.Fatalf("secondary %d %s not sealed: %v", index, field, err)
			}
			if prepared.MatchesPolicy(snapshot) {
				t.Fatalf("late secondary %d %s change accepted", index, field)
			}
			if _, err := selectedLaunch(next, prepared.command); err == nil {
				t.Fatal("old sealed command rebound to changed secondary root")
			}
		}
	}
	// Constructor and launch own value copies, not caller-mutable bindings.
	s.Snapshot.Approval.Workspaces[1].RootIdentity.Inode = "mutated"
	s.Snapshot.Participant.Grant.Workspaces[2].Root = "/wider"
	launch.roots[1].RootIdentity.Inode = "mutated-launch"
	again, err := selectedLaunch(selected, prepared.command)
	if err != nil || !reflect.DeepEqual(again.roots, expected) || evidence.calls != 0 || prepared.attempted {
		t.Fatal("binding alias or construction effects", err)
	}
}
