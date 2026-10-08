package connector_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// These use the same pure owner/journal fixtures as verification_test.go. A time
// advance and a known time-only journal update model the root join; they do not
// qualify trusted settings, Store IO, timers, wake hooks or a native connector.
func verificationRenew(f verificationFixture, elapsed time.Duration) {
	f.clock.advance(elapsed)
	f.journal.change(func(j *journal) { j.approval.ExpiresAt = f.clock.Now().Add(authority.TaskGrantLifetime) })
}

func TestConnectorVerificationUsesCurrentApprovalBeyondOriginalLaunch(t *testing.T) {
	for _, elapsed := range []time.Duration{time.Second, time.Hour, 12 * time.Hour, 24 * time.Hour, 72 * time.Hour} {
		for _, retained := range []bool{false, true} {
			t.Run(elapsed.String()+"/"+map[bool]string{false: "new", true: "retained"}[retained], func(t *testing.T) {
				f := verificationActive(t)
				v := f.observation()
				if retained {
					verificationBegin(t, f)
					if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
						t.Fatal(err)
					}
				}
				ceiling, err := f.owner.ExecutionCeiling(ctx)
				if err != nil {
					t.Fatal(err)
				}
				verificationRenew(f, elapsed)
				if err := f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest); err != nil {
					t.Fatal("current same-policy approval refused", err)
				}
				if !retained {
					verificationAbsent(t, f.owner)
					verificationBegin(t, f)
					if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
						t.Fatal(err)
					}
				}
				for i := 0; i < 2; i++ {
					out, err := f.owner.CurrentVerification(ctx)
					if err != nil || out == nil || *out != v {
						t.Fatal("original proof changed", out, err)
					}
					refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, "new-call"))
					if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
						t.Fatal("original duplicate refused", err)
					}
				}
				after, err := f.owner.ExecutionCeiling(ctx)
				if err != nil || !reflect.DeepEqual(after, ceiling) {
					t.Fatal("immutable launch ceiling changed", after, err)
				}
				if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
					t.Fatal("renewal republished owner")
				}
			})
		}
	}
}

func TestConnectorVerificationCannotUseExpiredOrChangedCurrentAuthority(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*journal, time.Time)
	}{
		{"revoked", func(j *journal, _ time.Time) { j.revoked = true }},
		{"participant absent", func(j *journal, _ time.Time) { j.p = nil }},
		{"owner", func(j *journal, _ time.Time) { j.approval.OwnerID += "-other" }},
		{"computer", func(j *journal, _ time.Time) { j.approval.ComputerID += "-other" }},
		{"generation", func(j *journal, _ time.Time) { j.approval.Generation++ }},
		{"root", func(j *journal, _ time.Time) { j.approval.Workspaces[0].Root = "/elsewhere" }},
		{"physical root", func(j *journal, _ time.Time) { j.approval.Workspaces[0].RootIdentity.Inode = "9" }},
		{"root device", func(j *journal, _ time.Time) { j.approval.Workspaces[0].RootIdentity.Device = "9" }},
		{"git metadata", func(j *journal, _ time.Time) {
			j.approval.Workspaces[0].GitMetadata = &authority.GitMetadata{GitDirectory: "/work/.git", CommonDirectory: "/work/.git"}
		}},
		{"git history", func(j *journal, _ time.Time) { j.approval.Workspaces[0].GitHistoryApproved = true }},
		{"shell verified", func(j *journal, _ time.Time) { j.approval.Workspaces[0].ShellVerified = true }},
		{"write mode", func(j *journal, _ time.Time) { j.approval.Workspaces[0].Access = authority.ReadAccess }},
		{"capability", func(j *journal, _ time.Time) { j.approval.Capabilities = j.approval.Capabilities[:1] }},
		{"exclusion", func(j *journal, _ time.Time) {
			j.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/README.md"}}
		}},
		{"network", func(j *journal, _ time.Time) { j.approval.Network = authority.ApprovedNetwork }},
		{"commands", func(j *journal, _ time.Time) { j.approval.Commands = authority.NoCommands }},
		{"file policy", func(j *journal, _ time.Time) { j.approval.FilePolicy = authority.RootScopedFiles }},
		{"participant identity", func(j *journal, _ time.Time) { j.p.Grant.TaskEpoch++ }},
		{"participant scope", func(j *journal, _ time.Time) { j.p.Grant.Workspaces[0].Paths = []string{"elsewhere"} }},
		{"participant capability", func(j *journal, _ time.Time) { j.p.Grant.Capabilities = j.p.Grant.Capabilities[:1] }},
		{"participant role", func(j *journal, _ time.Time) { j.p.Role = authority.Agent }},
		{"participant ownership", func(j *journal, _ time.Time) { j.p.MutationOwnership = authority.NoOwnership }},
		{"participant parent", func(j *journal, _ time.Time) { j.p.ParentParticipantID = "different-parent" }},
		{"current exact expiry", func(j *journal, now time.Time) { j.approval.ExpiresAt = now }},
		{"current past expiry", func(j *journal, now time.Time) { j.approval.ExpiresAt = now.Add(-time.Millisecond) }},
		{"current expiry invalid", func(j *journal, _ time.Time) { j.approval.ExpiresAt = time.UnixMilli(9007199254740992) }},
		{"current expiry fractional", func(j *journal, now time.Time) { j.approval.ExpiresAt = now.Add(time.Hour + time.Nanosecond) }},
	} {
		for _, retained := range []bool{false, true} {
			t.Run(test.name+"/"+map[bool]string{false: "new", true: "retained"}[retained], func(t *testing.T) {
				f := verificationActive(t)
				v := f.observation()
				if retained {
					verificationBegin(t, f)
					if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
						t.Fatal(err)
					}
				}
				// Keep launch time still valid: only the independent current journal
				// can detect this refusal, not a launch-clock check or cached policy.
				f.journal.change(func(j *journal) { test.edit(j, f.clock.Now()) })
				refused(t, f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest))
				refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
				refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
				verificationRefused(t, f.owner, ctx)
				if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
					t.Fatal("refusal replayed publication")
				}
			})
		}
	}
}

func TestConnectorVerificationUnknownSurvivesRenewal(t *testing.T) {
	f := verificationActive(t)
	v := f.observation()
	verificationBegin(t, f) // Reserved; outcome remains unknown forever.
	for _, elapsed := range []time.Duration{time.Second, 12 * time.Hour, 24 * time.Hour, 72 * time.Hour} {
		verificationRenew(f, elapsed)
		verificationRefused(t, f.owner, ctx)
		if err := f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest); err != nil {
			t.Fatal(err)
		}
		for _, next := range []struct{ workspace, call string }{{v.WorkspaceID, v.CallID}, {"other", v.CallID}, {v.WorkspaceID, "new-call"}} {
			refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, next.workspace, next.call))
		}
	}
	if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
		t.Fatal("unknown replayed")
	}
}

func TestConnectorVerificationRenewalKeepsOriginalExecutionDeadline(t *testing.T) {
	for _, kind := range []authority.Capability{authority.List, authority.Verify} {
		t.Run(string(kind), func(t *testing.T) {
			f := verificationActive(t)
			// Verify is a root-selected composite capability in this pure fixture.
			if kind == authority.Verify {
				f = newVerificationFixture(t)
				f.launch.Approval.Capabilities = append(f.launch.Approval.Capabilities, authority.Verify)
				f.launch.Admission.Capabilities = append(f.launch.Admission.Capabilities, authority.Verify)
				f.journal.approval = f.launch.Approval.Clone()
				var err error
				f.owner, err = connector.New(f.gate, f.io, f.guard, f.clock, f.launch)
				if err != nil {
					t.Fatal(err)
				}
				f.root.owner = f.owner
				if err = f.owner.Publish(ctx); err != nil {
					t.Fatal(err)
				}
			}
			verificationBegin(t, f)
			f.root.compose(t)
			l, err := f.root.issuer.Admit(ctx, kind)
			if err != nil {
				t.Fatal(err)
			}
			deadline, participant := l.Deadline(), l.Participant()
			budget := authority.OrdinaryExecutionLifetime
			if kind == authority.Verify {
				budget = authority.VerificationExecutionLifetime
			}
			if !deadline.Equal(f.clock.Now().Add(budget)) {
				t.Fatal("wrong fixed execution budget", deadline, budget)
			}
			verificationRenew(f, deadline.Sub(f.clock.Now())-time.Millisecond)
			if err := observe(l); err != nil {
				t.Fatal("lease cut short", err)
			}
			f.clock.advance(time.Millisecond)
			if err := f.owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge); err != nil {
				t.Fatal("new observation refused", err)
			}
			refused(t, observe(l)) // Root must use this exact final disclosure lease.
			if !l.Deadline().Equal(deadline) || !reflect.DeepEqual(l.Participant(), participant) {
				t.Fatal("old lease extended")
			}
			verificationRefused(t, f.owner, ctx)
			refused(t, f.owner.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "new-call"))
			next, err := f.root.issuer.Admit(ctx, kind)
			if err != nil || !next.Deadline().After(deadline) {
				t.Fatal("new operation did not use current approval", err)
			}
		})
	}
}

// A deliberately broken journal tests callback enforcement without Store IO.
// Production journal remains the existing Store adapter.
type verificationJournalFunc struct {
	port.ConnectorJournal
	read func(context.Context, string, func(port.AccessSnapshot) error) error
}

func (j verificationJournalFunc) WithSnapshot(c context.Context, id string, cb func(port.AccessSnapshot) error) error {
	return j.read(c, id, cb)
}

func TestConnectorVerificationCurrentJournalFailures(t *testing.T) {
	for _, kind := range []string{"silent", "double", "swallowed", "error after callback", "unclassified error", "approval absent"} {
		t.Run(kind, func(t *testing.T) {
			f := newVerificationFixture(t)
			j := verificationJournalFunc{ConnectorJournal: f.io, read: func(c context.Context, id string, cb func(port.AccessSnapshot) error) error {
				switch kind {
				case "silent":
					return nil
				case "double":
					return f.io.WithSnapshot(c, id, func(v port.AccessSnapshot) error { _ = cb(v); _ = cb(v); return nil })
				case "swallowed":
					_ = cb(port.AccessSnapshot{})
					return nil
				case "error after callback":
					_ = f.io.WithSnapshot(c, id, cb)
					return errors.New("fixture lost read outcome")
				case "unclassified error":
					return errors.New("fixture unavailable")
				default:
					return f.io.WithSnapshot(c, id, func(v port.AccessSnapshot) error { v.Approval = nil; return cb(v) })
				}
			}}
			owner, err := connector.New(f.gate, j, f.guard, f.clock, f.launch)
			if err != nil {
				t.Fatal(err)
			}
			if err = owner.Publish(ctx); err != nil {
				t.Fatal(err)
			}
			refused(t, owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge))
			refused(t, owner.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "call"))
			verificationRefused(t, owner, ctx)
			refused(t, owner.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()))
		})
	}
}

func TestConnectorVerificationConcurrentBeginRemainsOneShot(t *testing.T) {
	f := newFixture(t)
	f.launch.VerificationChallenge = [32]byte{1, 9}
	var err error
	f.owner, err = connector.New(&sync.Mutex{}, f.journal, f.guard, f.clock, f.launch)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(72 * time.Hour)
	f.journal.change(func(j *journal) { j.approval.ExpiresAt = f.clock.Now().Add(authority.TaskGrantLifetime) })
	f.guard.change(func(g *guard) {
		g.check = func() {
			if !f.journal.inSnapshot.Load() {
				t.Error("verification guard entered before access snapshot")
			}
		}
	})
	start := make(chan struct{})
	var wg sync.WaitGroup
	var reserved atomic.Int64
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if f.owner.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "call") == nil {
				reserved.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if reserved.Load() != 1 {
		t.Fatal("attempt reservation duplicated", reserved.Load())
	}
	verificationRefused(t, f.owner, ctx)
}

func TestConnectorVerificationFenceWinsAfterJournalEntry(t *testing.T) {
	for _, kind := range []string{"host revoked", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			f := newVerificationFixture(t)
			c, cancel := context.WithCancel(ctx)
			defer cancel()
			fence := false
			j := verificationJournalFunc{ConnectorJournal: f.io, read: func(c context.Context, id string, cb func(port.AccessSnapshot) error) error {
				return f.io.WithSnapshot(c, id, func(v port.AccessSnapshot) error {
					if fence {
						if kind == "host revoked" {
							f.guard.change(func(g *guard) { g.current = false })
						} else {
							cancel()
						}
					}
					return cb(v)
				})
			}}
			owner, err := connector.New(f.gate, j, f.guard, f.clock, f.launch)
			if err != nil {
				t.Fatal(err)
			}
			if err = owner.Publish(ctx); err != nil {
				t.Fatal(err)
			}
			v := f.observation()
			if err = owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID); err != nil {
				t.Fatal(err)
			}
			if err = owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
				t.Fatal(err)
			}
			fence = true
			verificationRefused(t, owner, c)
			if kind == "host revoked" {
				f.guard.change(func(g *guard) { g.current = true })
				fence = false
				verificationRefused(t, owner, ctx) // Same owner never recovers positive liveness.
			}
		})
	}
}

func TestConnectorVerificationUnknownSnapshotOutcomeKeepsAttempt(t *testing.T) {
	f := newVerificationFixture(t)
	lost := false
	j := verificationJournalFunc{ConnectorJournal: f.io, read: func(c context.Context, id string, cb func(port.AccessSnapshot) error) error {
		err := f.io.WithSnapshot(c, id, cb)
		if lost {
			return errors.New("fixture unknown read outcome after reservation")
		}
		return err
	}}
	owner, err := connector.New(f.gate, j, f.guard, f.clock, f.launch)
	if err != nil {
		t.Fatal(err)
	}
	if err = owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	v := f.observation()
	lost = true
	refused(t, owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
	lost = false // Only the observation channel recovers, never the attempt.
	verificationRenew(f, 72*time.Hour)
	if err = owner.CheckVerificationChallenge(ctx, v.ChallengeDigest); err != nil {
		t.Fatal(err)
	}
	verificationRefused(t, owner, ctx)
	refused(t, owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
	refused(t, owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, "new-call"))
	if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
		t.Fatal("unknown outcome replayed authority effect")
	}
}

func TestConnectorVerificationInvalidCurrentClockDoesNotConsumeAttempt(t *testing.T) {
	for _, millis := range []int64{-1, 0, 9007199254740992} {
		f := verificationActive(t)
		original := f.clock.Now().UnixMilli()
		f.clock.ms.Store(millis)
		refused(t, f.owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge))
		refused(t, f.owner.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "call"))
		verificationRefused(t, f.owner, ctx)
		f.clock.ms.Store(original)
		verificationAbsent(t, f.owner)
		verificationBegin(t, f)
		verificationRefused(t, f.owner, ctx)
	}
}
