package authority

import (
	"slices"
	"testing"
	"time"
)

func TestReissueUsesCurrentApprovalAndChangesOnlyTime(t *testing.T) {
	a, ceiling, p := fixtures(t)
	at := ceiling.ExpiresAt.Add(time.Millisecond)
	if _, err := Derive(a, ceiling, at); err == nil {
		t.Fatal("expired template unexpectedly admitted")
	}
	g, err := Reissue(a, ceiling, at, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !g.ExpiresAt.Equal(at.Add(time.Minute)) {
		t.Fatal("wrong renewed expiry")
	}
	reissued, err := Create(*g, ParticipantAdmission{ParticipantID: p.ParticipantID, Role: p.Role, MutationOwnership: p.MutationOwnership})
	if err != nil || !SameParticipantCeiling(p, *reissued) {
		t.Fatalf("ceiling changed: %v", err)
	}
	if !ceiling.ExpiresAt.Equal(now.Add(time.Minute)) {
		t.Fatal("input changed")
	}
	g.Workspaces[0].Root = "/other"
	g.Capabilities[0] = Write
	if ceiling.Workspaces[0].Root != "/work" || ceiling.Capabilities[0] != Read {
		t.Fatal("input aliases")
	}
}
func TestReissueDoesNotImportNewPermission(t *testing.T) {
	a, ceiling, _ := fixtures(t)
	ceiling.Capabilities = []Capability{Read}
	ceiling.Workspaces[0].Access = ReadAccess
	ceiling.Network, ceiling.Commands = NoNetwork, NoCommands
	a.Workspaces = append(a.Workspaces, ApprovedWorkspace{WorkspaceID: "other", Root: "/other", Access: WriteAccess})
	g, err := Reissue(a, ceiling, now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Workspaces) != 1 || !slices.Equal(g.Capabilities, []Capability{Read}) || g.Network != NoNetwork || g.Commands != NoCommands || g.Workspaces[0].Access != ReadAccess {
		t.Fatal("permission widened")
	}
}
func TestReissueRefusesRevokedPolicyAndInvalidTime(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*Approval, *Admission, *time.Time, *time.Duration)
	}{
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { a.Generation++ }},
		{"owner", "AUTHORITY_OWNER_MISMATCH", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { a.OwnerID = "foreign" }},
		{"approval expiry", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { a.ExpiresAt = *at }},
		{"capability", "AUTHORITY_INFLATION_DENIED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { a.Capabilities = nil }},
		{"root", "AUTHORITY_INFLATION_DENIED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { a.Workspaces = nil }},
		{"zero clock", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { *at = time.UnixMilli(0) }},
		{"negative clock", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { *at = time.UnixMilli(-1) }},
		{"oversized clock", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) {
			*at = time.UnixMilli(9007199254740992)
		}},
		{"sum overflow", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) {
			*at = time.UnixMilli(9007199254740991)
		}},
		{"zero budget", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { *d = 0 }},
		{"negative budget", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) { *d = -time.Second }},
		{"fractional budget", "AUTHORITY_EXPIRED", func(a *Approval, n *Admission, at *time.Time, d *time.Duration) {
			*d = time.Millisecond + time.Nanosecond
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, n, _ := fixtures(t)
			at, d := now, time.Minute
			test.change(&a, &n, &at, &d)
			g, err := Reissue(a, n, at, d)
			if g != nil {
				t.Fatal("issued refused grant")
			}
			f, ok := err.(*Failure)
			if !ok || f.Code != test.code || f.Retry != "never" {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func TestExecutionDeadlineIsIndependentAndExclusive(t *testing.T) {
	a, _, p := fixtures(t)
	p.Grant.ExpiresAt = now.Add(time.Millisecond)
	l, err := Lease(p, a, now, OrdinaryExecutionLifetime)
	if err != nil {
		t.Fatal(err)
	}
	if !l.Deadline().Equal(now.Add(15 * time.Second)) {
		t.Fatal("outer expiry leaked into execution")
	}
	if err = l.Check(p.Grant.ExpiresAt.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	failure(t, l.Check(l.Deadline()), "AUTHORITY_EXPIRED", "task-grant")
	failure(t, l.Check(l.Deadline().Add(time.Nanosecond)), "AUTHORITY_EXPIRED", "task-grant")
	if err = l.Check(l.Deadline().Add(-time.Nanosecond)); err != nil {
		t.Fatal(err)
	}
	copy := l.Participant()
	copy.Grant.Workspaces[0].Root = "/other"
	copy.Grant.Capabilities[0] = Write
	p.Grant.Workspaces[0].Root = "/changed"
	a.Workspaces[0].Root = "/changed"
	if l.Participant().Grant.Workspaces[0].Root != "/work" || l.Participant().Grant.Capabilities[0] != Read {
		t.Fatal("mutable lease snapshot")
	}
	p.Grant.ExpiresAt = now.Add(-time.Second)
	if l, err := Lease(p, a, now, OrdinaryExecutionLifetime); l != nil || err == nil {
		t.Fatal("expired outer admitted")
	}
}
func TestLeaseCapsDeadlineAtCurrentOwnerExpiry(t *testing.T) {
	a, _, p := fixtures(t)
	a.ExpiresAt = now.Add(2 * time.Second)
	l, err := Lease(p, a, now, VerificationExecutionLifetime)
	if err != nil || !l.Deadline().Equal(a.ExpiresAt) {
		t.Fatalf("owner expiry not retained: %v", err)
	}
	failure(t, l.Check(a.ExpiresAt), "AUTHORITY_EXPIRED", "task-grant")
}
func TestSealedPolicyComparisonsCloneAllNestedValues(t *testing.T) {
	a, _, p := fixtures(t)
	a.Workspaces[0].GitMetadata = &GitMetadata{GitDirectory: "/work/.git", CommonDirectory: "/work/.git"}
	b := a.Clone()
	b.ExpiresAt = b.ExpiresAt.Add(time.Hour)
	if !SameApprovalPolicy(a, b) {
		t.Fatal("time-only policy rejected")
	}
	b.Workspaces[0].GitMetadata.CommonDirectory = "/other"
	if SameApprovalPolicy(a, b) || a.Workspaces[0].GitMetadata.CommonDirectory != "/work/.git" {
		t.Fatal("metadata alias or missed policy change")
	}
	child, err := Narrow(p.Grant, Narrowing{Workspaces: []Scope{{WorkspaceID: "work", Root: "/work", Mode: Exact, Paths: []string{"/work/a"}, Access: ReadAccess}}, Capabilities: []Capability{Read}, Network: NoNetwork, Commands: NoCommands})
	if err != nil {
		t.Fatal(err)
	}
	p.Grant = *child
	q := p.Clone()
	q.Grant.ExpiresAt = now
	if !SameParticipantCeiling(p, q) {
		t.Fatal("expiry became ceiling")
	}
	q.Grant.Workspaces[0].Paths[0] = "/work/b"
	if SameParticipantCeiling(p, q) || p.Grant.Workspaces[0].Paths[0] != "/work/a" {
		t.Fatal("exact path alias/missed change")
	}
	q = p.Clone()
	q.ParentParticipantID = "foreign"
	if SameParticipantCeiling(p, q) {
		t.Fatal("lineage ignored")
	}
}
