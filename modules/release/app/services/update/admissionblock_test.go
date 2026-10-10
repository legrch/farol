package update

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

// Policy-port evidence only: no package, helper, filesystem or installed effects.
func TestReadyBlockCannotRedispatchBeforeExplicitRecheck(t *testing.T) {
	s, r, _ := fixture()
	r.apply = func(context.Context, port.Archive) (*port.Handoff, error) {
		return &port.Handoff{Decision: port.Blocked, Code: "UPDATE_WORK_PENDING"}, nil
	}
	initialize(t, s)
	check(t, s, false)
	s.Apply(context.Background(), ApplyRequest{})
	s.Apply(context.Background(), ApplyRequest{})
	if r.count("apply") != 1 {
		t.Fatalf("blocked Ready replayed Apply without recheck: %v", r.trace())
	}
}

func TestManualCheckPreservesNonRecheckableReadyBlock(t *testing.T) {
	for _, code := range []string{"UPDATE_BROWSER_STATE_UNKNOWN", "UPDATE_BROWSER_RELEASE_UNCONFIRMED", "UPDATE_STATE_UNREADABLE", "UPDATE_NEW_UNCLASSIFIED_BLOCK"} {
		t.Run(code, func(t *testing.T) {
			s, r, _ := fixture()
			r.apply = func(context.Context, port.Archive) (*port.Handoff, error) {
				return &port.Handoff{Decision: port.Blocked, Code: code}, nil
			}
			initialize(t, s)
			check(t, s, false)
			s.Apply(context.Background(), ApplyRequest{})
			check(t, s, false)
			s.Apply(context.Background(), ApplyRequest{})
			if v := snapshot(t, s); v.BlockedBy != code || r.count("apply") != 1 {
				t.Fatalf("automatic Check or direct Apply cleared block: %+v %v", v, r.trace())
			}
			check(t, s, true)
			if v := snapshot(t, s); v.Phase != "ready" || v.BlockedBy != code {
				t.Fatalf("manual Check cleared nonrecheckable block: %+v", v)
			}
			s.Apply(context.Background(), ApplyRequest{})
			if r.count("apply") != 1 || r.count("download") != 1 {
				t.Fatalf("repeated blocked effect or download: %v", r.trace())
			}
		})
	}
}

func TestExplicitKnownAdmissionRecheckPreservesArchiveAndAllowsOneIntention(t *testing.T) {
	for _, code := range []string{"UPDATE_CONNECTOR_ACTIVE", "UPDATE_TASK_ROUTE_NEEDS_DRAIN", "UPDATE_BROWSER_OPEN", "UPDATE_BROWSER_BUSY", "UPDATE_BROWSER_DRAFT", "UPDATE_WORK_PENDING"} {
		t.Run(code, func(t *testing.T) {
			s, r, _ := fixture()
			r.apply = func(context.Context, port.Archive) (*port.Handoff, error) {
				return &port.Handoff{Decision: port.Blocked, Code: code}, nil
			}
			initialize(t, s)
			check(t, s, false)
			s.Apply(context.Background(), ApplyRequest{})
			check(t, s, false)
			s.Later(LaterRequest{})
			s.Apply(context.Background(), ApplyRequest{})
			if v := snapshot(t, s); v.BlockedBy != code || r.count("apply") != 1 {
				t.Fatalf("automatic Check, Later or direct Apply bypassed block: %+v %v", v, r.trace())
			}
			check(t, s, true)
			if v := snapshot(t, s); v.Phase != "ready" || v.BlockedBy != "" || !v.Deferred {
				t.Fatalf("known recheck view: %+v", v)
			}
			r.apply = nil
			s.Apply(context.Background(), ApplyRequest{})
			if r.count("apply") != 2 || r.count("download") != 1 || snapshot(t, s).Phase != "applying" {
				t.Fatalf("explicit recheck failed: %v", r.trace())
			}
		})
	}
}

func TestUnknownHandoffNeverBecomesRecheckableAdmissionBlock(t *testing.T) {
	s, r, _ := fixture()
	r.apply = func(context.Context, port.Archive) (*port.Handoff, error) {
		return &port.Handoff{Decision: port.Unknown, Code: "UPDATE_HANDOFF_UNKNOWN"}, nil
	}
	initialize(t, s)
	check(t, s, false)
	s.Apply(context.Background(), ApplyRequest{})
	for range 3 {
		check(t, s, true)
		check(t, s, false)
		s.Later(LaterRequest{})
		s.Apply(context.Background(), ApplyRequest{})
	}
	if v := snapshot(t, s); v.Phase != "failed" || !v.RecoveryRequired || v.Code != "UPDATE_HANDOFF_UNKNOWN" {
		t.Fatalf("unknown handoff escaped fence: %+v", v)
	}
	if r.count("apply") != 1 || r.count("download") != 1 || r.count("discover") != 1 {
		t.Fatalf("unknown handoff replayed: %v", r.trace())
	}
}
