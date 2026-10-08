package authority

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func refreshFixture() (Approval, Approval, ApprovalRefreshBinding, ApprovalRefreshWitness, time.Time) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	a := Approval{
		OwnerID: "owner-desktop", ComputerID: "computer", Generation: 40,
		FilePolicy: RootScopedFiles, Network: NoNetwork, Commands: NoCommands,
		ExpiresAt: now.Add(4 * time.Minute),
		Workspaces: []ApprovedWorkspace{{WorkspaceID: "brain", Root: "/approved/brain", Access: WriteAccess,
			RootIdentity: RootIdentity{"1", "2"}, GitMetadata: &GitMetadata{"/approved/brain/.git", "/approved/brain/.git"}}},
		ExcludedPaths: []Exclusion{{WorkspaceID: "brain", Path: "/approved/brain/private", RestrictionSource: OwnerRestrictionSource}},
		Capabilities:  []Capability{List, Read, Search, Write},
	}
	b := ApprovalRefreshBinding{"profile", "backend", "original-publication", 8, 22, 40, 6}
	w := ApprovalRefreshWitness{Binding: b, Approval: a.Clone(), ObservedAt: now, Current: true, Renewable: true}
	w.Approval.ExpiresAt = now.Add(TaskGrantLifetime)
	return a.Clone(), a.Clone(), b, w, now
}

func TestOwnerApprovalRefreshRequiresOwnerOnlyBinding(t *testing.T) {
	pin, old, binding, witness, now := refreshFixture()
	if plan, err := PlanOwnerApprovalRefresh(pin, old, binding, witness, now); err == nil || plan != nil {
		t.Fatal("owner-only planner accepted connector binding")
	}
	binding.ConnectorGeneration = 0
	witness.Binding = binding
	if plan, err := PlanApprovalRefresh(pin, old, binding, witness, now); err == nil || plan != nil {
		t.Fatal("connector planner accepted absent connector")
	}
	if plan, err := PlanOwnerApprovalRefresh(pin, old, binding, witness, now); err != nil || plan == nil || !plan.Publish {
		t.Fatal("current owner-only consent refused", err)
	}
	witness.Current = false
	if plan, err := PlanOwnerApprovalRefresh(pin, old, binding, witness, now); err == nil || plan != nil {
		t.Fatal("withdrawn owner-only consent renewed")
	}
}

func expectRefreshError(t *testing.T, plan *ApprovalRefreshPlan, err error, code string) {
	t.Helper()
	var f *Failure
	if plan != nil || !errors.As(err, &f) || f.Code != code || f.Retry != "never" {
		t.Fatalf("plan=%+v error=%v wanted code=%s, retry never", plan, err, code)
	}
}

func TestApprovalRefreshThresholdAndWake(t *testing.T) {
	for _, tc := range []struct {
		name    string
		left    time.Duration
		publish bool
	}{
		{"healthy twelve hours", 12 * time.Hour, false},
		{"just before margin", 5*time.Minute + time.Millisecond, false},
		{"exact margin", 5 * time.Minute, true},
		{"inside margin", time.Minute, true},
		{"exact old expiry", 0, true},
		{"one millisecond expired", -time.Millisecond, true},
		{"idle past twelve hours", -12 * time.Hour, true},
		{"wake after three days", -72 * time.Hour, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pin, old, binding, witness, now := refreshFixture()
			old.ExpiresAt = now.Add(tc.left)
			pin.ExpiresAt = old.ExpiresAt
			p, err := PlanApprovalRefresh(pin, old, binding, witness, now)
			if err != nil || p.Publish != tc.publish {
				t.Fatalf("%+v %v", p, err)
			}
			if !SameApprovalPolicy(p.Approval, pin) || p.ExpectedStoreRevision != binding.StoreRevision || !p.PreviousExpiresAt.Equal(old.ExpiresAt) {
				t.Fatal("changed seal or original CAS")
			}
			if tc.publish && !p.Approval.ExpiresAt.Equal(now.Add(TaskGrantLifetime)) {
				t.Fatal("wrong finite horizon")
			}
			if !tc.publish && !reflect.DeepEqual(p.Approval, old) {
				t.Fatal("no-op changed approval")
			}
		})
	}
}

func TestApprovalRefreshRequiresExactLiveWitness(t *testing.T) {
	cases := []struct {
		name   string
		change func(*ApprovalRefreshBinding, *ApprovalRefreshWitness)
	}{
		{"owner revoked", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Current = false }},
		{"bounded nonrenewable consent", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Renewable = false }},
		{"different profile", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.ProfileID = "other" }},
		{"different backend", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.BackendGeneration = "other" }},
		{"different original publication", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.PublicationOperationID = "other" }},
		{"withdrawal fence advanced", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.Fence++ }},
		{"store changed", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.StoreRevision++ }},
		{"computer changed", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.ComputerGeneration++ }},
		{"connector changed", func(_ *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { w.Binding.ConnectorGeneration++ }},
		{"no profile", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { b.ProfileID = ""; w.Binding = *b }},
		{"no backend", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { b.BackendGeneration = ""; w.Binding = *b }},
		{"no publication", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) {
			b.PublicationOperationID = ""
			w.Binding = *b
		}},
		{"zero fence", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { b.Fence = 0; w.Binding = *b }},
		{"zero revision", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { b.StoreRevision = 0; w.Binding = *b }},
		{"revision cannot increment", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) {
			b.StoreRevision = ^uint64(0)
			w.Binding = *b
		}},
		{"zero computer generation", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { b.ComputerGeneration = 0; w.Binding = *b }},
		{"zero connector generation", func(b *ApprovalRefreshBinding, w *ApprovalRefreshWitness) { b.ConnectorGeneration = 0; w.Binding = *b }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, o, b, w, n := refreshFixture()
			tc.change(&b, &w)
			v, e := PlanApprovalRefresh(p, o, b, w, n)
			expectRefreshError(t, v, e, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
		})
	}
}

func TestApprovalRefreshPolicyCannotChange(t *testing.T) {
	changes := []struct {
		name   string
		change func(*Approval)
	}{
		{"owner", func(a *Approval) { a.OwnerID = "other" }},
		{"computer", func(a *Approval) { a.ComputerID = "other" }},
		{"generation", func(a *Approval) { a.Generation++ }},
		{"file policy", func(a *Approval) { a.FilePolicy = LegacyProtectedFiles }},
		{"network", func(a *Approval) { a.Network = ApprovedNetwork }},
		{"commands", func(a *Approval) { a.Commands = WorkspaceCommands }},
		{"capabilities added", func(a *Approval) { a.Capabilities = append(a.Capabilities, Shell) }},
		{"capabilities narrowed", func(a *Approval) { a.Capabilities = a.Capabilities[:1] }},
		{"capabilities reordered", func(a *Approval) { a.Capabilities[0], a.Capabilities[1] = a.Capabilities[1], a.Capabilities[0] }},
		{"workspace removed", func(a *Approval) { a.Workspaces = nil }},
		{"workspace id", func(a *Approval) { a.Workspaces[0].WorkspaceID = "other" }},
		{"root", func(a *Approval) { a.Workspaces[0].Root = "/" }},
		{"read-write mode", func(a *Approval) { a.Workspaces[0].Access = ReadAccess }},
		{"root device", func(a *Approval) { a.Workspaces[0].RootIdentity.Device = "8" }},
		{"root inode", func(a *Approval) { a.Workspaces[0].RootIdentity.Inode = "9" }},
		{"git common dir", func(a *Approval) { a.Workspaces[0].GitMetadata.CommonDirectory = "/other/.git" }},
		{"git history", func(a *Approval) { a.Workspaces[0].GitHistoryApproved = true }},
		{"shell verified", func(a *Approval) { a.Workspaces[0].ShellVerified = true }},
		{"excluded path", func(a *Approval) { a.ExcludedPaths[0].Path = "/approved/brain/elsewhere" }},
		{"restriction provenance", func(a *Approval) { a.ExcludedPaths[0].RestrictionSource = TaskGrantSource }},
	}
	for _, tc := range changes {
		for _, side := range []string{"stored", "fresh"} {
			t.Run(tc.name+"/"+side, func(t *testing.T) {
				p, o, b, w, n := refreshFixture()
				if side == "stored" {
					tc.change(&o)
				} else {
					tc.change(&w.Approval)
				}
				v, e := PlanApprovalRefresh(p, o, b, w, n)
				expectRefreshError(t, v, e, "AUTHORITY_COMPUTER_MISMATCH")
			})
		}
	}
}

func TestApprovalRefreshRejectsInvalidClockOrFreshness(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Approval, *Approval, *ApprovalRefreshWitness, *time.Time)
	}{
		{"stale observation", func(_, _ *Approval, w *ApprovalRefreshWitness, n *time.Time) {
			w.ObservedAt = n.Add(-ApprovalRefreshObservationAge - time.Nanosecond)
		}},
		{"future observation or clock rollback", func(_, _ *Approval, w *ApprovalRefreshWitness, n *time.Time) { w.ObservedAt = n.Add(time.Nanosecond) }},
		{"zero now", func(_, _ *Approval, _ *ApprovalRefreshWitness, n *time.Time) { *n = time.UnixMilli(0) }},
		{"negative now", func(_, _ *Approval, _ *ApprovalRefreshWitness, n *time.Time) { *n = time.UnixMilli(-1) }},
		{"now outside wire integer", func(_, _ *Approval, w *ApprovalRefreshWitness, n *time.Time) {
			*n = time.UnixMilli(9007199254740992)
			w.ObservedAt = *n
		}},
		{"zero observation", func(_, _ *Approval, w *ApprovalRefreshWitness, _ *time.Time) { w.ObservedAt = time.UnixMilli(0) }},
		{"zero pinned expiry", func(p, _ *Approval, _ *ApprovalRefreshWitness, _ *time.Time) { p.ExpiresAt = time.UnixMilli(0) }},
		{"zero stored expiry", func(_, o *Approval, _ *ApprovalRefreshWitness, _ *time.Time) { o.ExpiresAt = time.UnixMilli(0) }},
		{"zero fresh expiry", func(_, _ *Approval, w *ApprovalRefreshWitness, _ *time.Time) {
			w.Approval.ExpiresAt = time.UnixMilli(0)
		}},
		{"fresh expiry outside wire integer", func(_, _ *Approval, w *ApprovalRefreshWitness, _ *time.Time) {
			w.Approval.ExpiresAt = time.UnixMilli(9007199254740992)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, o, b, w, n := refreshFixture()
			tc.change(&p, &o, &w, &n)
			v, e := PlanApprovalRefresh(p, o, b, w, n)
			expectRefreshError(t, v, e, "AUTHORITY_EXPIRED")
		})
	}
}

func TestApprovalRefreshMaximumFreshnessAndFiniteBounds(t *testing.T) {
	t.Run("exact observation age accepted", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		w.ObservedAt = n.Add(-ApprovalRefreshObservationAge)
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		if e != nil || !v.Publish {
			t.Fatal(v, e)
		}
	})
	t.Run("owner fresh ceiling limits proposed lease", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		w.Approval.ExpiresAt = n.Add(6 * time.Minute)
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		if e != nil || !v.Approval.ExpiresAt.Equal(w.Approval.ExpiresAt) {
			t.Fatal(v, e)
		}
	})
	t.Run("long owner ceiling does not remove twelve-hour lease", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		w.Approval.ExpiresAt = n.Add(365 * 24 * time.Hour)
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		if e != nil || !v.Approval.ExpiresAt.Equal(n.Add(TaskGrantLifetime)) {
			t.Fatal(v, e)
		}
	})
	t.Run("shortening uses normal transition", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		w.Approval.ExpiresAt = o.ExpiresAt.Add(-time.Second)
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		expectRefreshError(t, v, e, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	})
	t.Run("unadvanced near-expiry proof does not pretend renewal", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		w.Approval.ExpiresAt = o.ExpiresAt
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		expectRefreshError(t, v, e, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	})
	t.Run("expired fresh proof", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		p.ExpiresAt = n.Add(-time.Hour)
		o.ExpiresAt = p.ExpiresAt
		w.Approval.ExpiresAt = n
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		expectRefreshError(t, v, e, "AUTHORITY_EXPIRED")
	})
	t.Run("horizon integer overflow", func(t *testing.T) {
		p, o, b, w, n := refreshFixture()
		n = time.UnixMilli(9007199254740991 - 1000)
		p.ExpiresAt = n.Add(-time.Hour)
		o.ExpiresAt = p.ExpiresAt
		w.ObservedAt = n
		w.Approval.ExpiresAt = time.UnixMilli(9007199254740991)
		v, e := PlanApprovalRefresh(p, o, b, w, n)
		expectRefreshError(t, v, e, "AUTHORITY_EXPIRED")
	})
}

func TestApprovalRefreshCloneDoesNotMutateAuthority(t *testing.T) {
	p, o, b, w, n := refreshFixture()
	beforeP, beforeO, beforeW := p.Clone(), o.Clone(), w.Approval.Clone()
	v, e := PlanApprovalRefresh(p, o, b, w, n)
	if e != nil {
		t.Fatal(e)
	}
	v.Approval.Workspaces[0].Root = "/elsewhere"
	v.Approval.Workspaces[0].GitMetadata.CommonDirectory = "/other"
	v.Approval.Capabilities[0] = Shell
	v.Approval.ExcludedPaths[0].Path = "/else"
	if !reflect.DeepEqual(p, beforeP) || !reflect.DeepEqual(o, beforeO) || !reflect.DeepEqual(w.Approval, beforeW) {
		t.Fatal("proposal mutated source policy")
	}
}

func TestCurrentLifetimeDeadlineReproducesTheTwelveHourCeiling(t *testing.T) {
	_, a, _, _, issued := refreshFixture()
	a.ExpiresAt = issued.Add(TaskGrantLifetime)
	for _, elapsed := range []time.Duration{0, 11 * time.Hour, TaskGrantLifetime - time.Millisecond, TaskGrantLifetime, TaskGrantLifetime + time.Millisecond, 24 * time.Hour} {
		t.Run(elapsed.String(), func(t *testing.T) {
			at := issued.Add(elapsed)
			d, e := lifetimeDeadline(a, at, TaskGrantLifetime)
			if elapsed < TaskGrantLifetime {
				if e != nil || !d.Equal(a.ExpiresAt) {
					t.Fatal(d, e)
				}
			} else {
				var f *Failure
				if !errors.As(e, &f) || f.Code != "AUTHORITY_EXPIRED" || f.Source != "task-admission" {
					t.Fatal(d, e)
				}
			}
		})
	}
}

func TestRenewingApprovalDoesNotRenewOriginalExecution(t *testing.T) {
	for _, budget := range []time.Duration{OrdinaryExecutionLifetime, VerificationExecutionLifetime} {
		t.Run(budget.String(), func(t *testing.T) {
			pin, old, b, w, now := refreshFixture()
			participant := Participant{ParticipantID: "original", Grant: Grant{Identity: Identity{"owner-desktop", "session", "task", 1}, AuthorityID: "admission", ComputerID: old.ComputerID, ComputerGeneration: old.Generation, Policy: Policy{FilePolicy: old.FilePolicy, ExpiresAt: old.ExpiresAt}}}
			lease, e := Lease(participant, old, now, budget)
			if e != nil {
				t.Fatal(e)
			}
			deadline := lease.Deadline()
			before := lease.Participant()
			plan, e := PlanApprovalRefresh(pin, old, b, w, now)
			if e != nil || !plan.Publish {
				t.Fatal(plan, e)
			}
			if !lease.Deadline().Equal(deadline) || !reflect.DeepEqual(lease.Participant(), before) {
				t.Fatal("old operation renewed")
			}
			if lease.Check(deadline.Add(-time.Nanosecond)) != nil {
				t.Fatal("lease cut short")
			}
			var f *Failure
			if !errors.As(lease.Check(deadline), &f) || f.Code != "AUTHORITY_EXPIRED" {
				t.Fatal("original lease must expire")
			}
		})
	}
}

// A fake-clock scheduling model only; not a host/store/MCP integration witness.
func TestSeventyTwoHourFakeClockPlanWithMissedHeartbeat(t *testing.T) {
	pin, stored, b, w, now := refreshFixture()
	stored.ExpiresAt = now.Add(TaskGrantLifetime)
	pin.ExpiresAt = stored.ExpiresAt
	start := now
	publications := 0
	for hour := 0; hour <= 72; hour++ {
		if hour > 17 && hour < 40 {
			continue
		} // sleeping host: no background timer can run
		now = start.Add(time.Duration(hour) * time.Hour)
		w.ObservedAt = now
		w.Approval.ExpiresAt = now.Add(TaskGrantLifetime)
		w.Binding = b
		plan, err := PlanApprovalRefresh(pin, stored, b, w, now)
		if err != nil {
			t.Fatal(hour, err)
		}
		if plan.Publish {
			stored = plan.Approval
			b.StoreRevision++
			publications++
		}
		if !now.Before(stored.ExpiresAt) || !SameApprovalPolicy(pin, stored) {
			t.Fatal("new admission has stale time or inflated policy")
		}
	}
	if publications != 4 {
		t.Fatalf("unexpected refresh count %d", publications)
	}
}
