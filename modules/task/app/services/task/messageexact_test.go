package task

import (
	"errors"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func TestMessageExactRefusesStaleDispatchBeforeProviderOrPublication(t *testing.T) {
	for _, dispatch := range []string{"", "bad\x00dispatch", "foreign", "stale"} {
		t.Run(dispatch, func(t *testing.T) {
			_, j, a, f, d := setup(task.Codex)
			p := &exactParentCountingProvider{fakeProvider: f}
			s := newService(j, a, map[task.Provider]port.Provider{task.Codex: p}, d)
			create(t, s, task.Codex)
			before, _ := j.Read(ctx, "task-1")
			supports := p.supports
			_, err := s.MessageExact(ctx, MessageExactRequest{"steer", "task-1", "adjust", dispatch})
			want := task.ErrIdentity
			if !task.ID(dispatch) {
				want = task.ErrInvalid
			}
			after, _ := j.Read(ctx, "task-1")
			op, _ := j.Lookup(ctx, "steer")
			if !errors.Is(err, want) || *after != *before || op != nil || p.supports != supports || f.calls != 1 || f.reads != 0 {
				t.Fatal("stale dispatch reached effect or changed journal", err, op)
			}
		})
	}
}

func TestMessageExactBindsDispatchInKnownUnknownAndRefusedReplay(t *testing.T) {
	for _, mode := range []string{"known", "unknown", "refused"} {
		t.Run(mode, func(t *testing.T) {
			s, j, _, f, _ := setup(task.Codex)
			create(t, s, task.Codex)
			want := task.Known
			if mode == "unknown" {
				f.dispatchErr = errors.New("controlled lost steer ACK")
				want = task.Uncertain
			} else if mode == "refused" {
				f.receipt = task.Receipt{State: task.Rejected, Code: "PROVIDER_REFUSED"}
				want = task.Rejected
			}
			req := MessageExactRequest{"steer", "task-1", "adjust", "create-1"}
			out, err := s.MessageExact(ctx, req)
			if err != nil || out.Receipt.State != want {
				t.Fatal(out, err)
			}
			if replay, err := s.MessageExact(ctx, req); err != nil || *replay != *out {
				t.Fatal("receipt replay changed", replay, err)
			}
			changed := req
			changed.ExpectedDispatchID = "steer"
			if _, err := s.MessageExact(ctx, changed); !errors.Is(err, task.ErrConflict) {
				t.Fatal("changed dispatch bypassed fingerprint", err)
			}
			if _, err := s.Control(ctx, MutationRequest{req.OperationID, req.TaskID, req.Message, task.Message}); !errors.Is(err, task.ErrConflict) {
				t.Fatal("legacy replay bypassed exact fingerprint", err)
			}
			snapshot, _ := j.Read(ctx, "task-1")
			op, _ := j.Lookup(ctx, "steer")
			if f.calls != 2 || f.reads != 0 || op.Intent.Action != task.Message || op.Intent.Expected != reference(task.Codex, "turn-1") || snapshot.Task.DispatchID != "create-1" || snapshot.Task.Reference != reference(task.Codex, "turn-1") || snapshot.Task.Lifecycle != task.Running {
				t.Fatal("message replaced running dispatch or repeated effect", op, snapshot)
			}
			if mode == "unknown" && (snapshot.Pending != "steer" || op.Settled) {
				t.Fatal("UNKNOWN was settled", snapshot, op)
			}
		})
	}
}

func TestMessageExactSnapshotCASBlocksCompletionAndNewDispatchWhileWaiting(t *testing.T) {
	winner, j, a, f, d := setup(task.Codex)
	create(t, winner, task.Codex)
	blocked := &exactParentBarrierProvider{fakeProvider: &fakeProvider{caps: f.caps, receipt: f.receipt}, entered: make(chan struct{}), release: make(chan struct{})}
	loser := newService(j, a, map[task.Provider]port.Provider{task.Codex: blocked}, d)
	done := make(chan error, 1)
	go func() {
		_, err := loser.MessageExact(ctx, MessageExactRequest{"stale-steer", "task-1", "adjust", "create-1"})
		done <- err
	}()
	await(t, blocked.entered)
	complete(t, winner)
	f.receipt.Reference = reference(task.Codex, "turn-2")
	if _, err := winner.ContinueExact(ctx, ContinueExactRequest{"follow-up", "task-1", "next", "create-1"}); err != nil {
		t.Fatal(err)
	}
	before, _ := j.Read(ctx, "task-1")
	close(blocked.release)
	if err := awaitError(t, done); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("stale snapshot was admitted", err)
	}
	after, _ := j.Read(ctx, "task-1")
	op, _ := j.Lookup(ctx, "stale-steer")
	if blocked.calls != 0 || op != nil || *before != *after || after.Task.DispatchID != "follow-up" {
		t.Fatal("steer substituted newly active turn", op, after)
	}
}
