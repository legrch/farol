package observation

import (
	"context"
	"errors"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
	"testing"
)

type probeFunc func(context.Context, string) (identity.Observation, error)

func (f probeFunc) Observe(c context.Context, p string) (identity.Observation, error) { return f(c, p) }
func request() Request {
	e := identity.Evidence{Schema: identity.EvidenceSchema, Filesystem: "apfs", VolumeUUID: "11111111-2222-3333-4444-555555555555", FileID: "2", BirthSeconds: "3", BirthNanoseconds: "0"}
	return Request{identity.Saved{Binding: identity.Binding{Path: "/approved/work", Device: "1", Inode: "2"}, Evidence: &e}, identity.Settled}
}
func TestPreflightNeverMeasuresUnknownLegacyOrMalformed(t *testing.T) {
	for _, name := range []string{"unknown", "legacy", "invalid"} {
		t.Run(name, func(t *testing.T) {
			r := request()
			want := identity.Unresolved
			switch name {
			case "unknown":
				r.Settlement = "unknown"
			case "legacy":
				r.Saved.Evidence = nil
				want = identity.ReconfirmationRequired
			case "invalid":
				r.Saved.Evidence.FileID = "9"
				want = identity.InvalidEvidence
			}
			svc := New(probeFunc(func(context.Context, string) (identity.Observation, error) {
				t.Fatal("unauthorized measurement")
				return identity.Observation{}, nil
			}))
			got, err := svc.Assess(context.Background(), r)
			if err != nil || got != want {
				t.Fatalf("%v %v", got, err)
			}
		})
	}
}
func TestOneReadNoRetryAndCopiedSavedEvidence(t *testing.T) {
	r := request()
	current := identity.Observation{Binding: r.Saved.Binding, Evidence: *r.Saved.Evidence}
	current.Binding.Device = "7"
	n := 0
	svc := New(probeFunc(func(_ context.Context, p string) (identity.Observation, error) {
		n++
		if p != "/approved/work" {
			t.Fatal(p)
		}
		r.Saved.Evidence.VolumeUUID = "changed during dependency"
		return current, nil
	}))
	got, err := svc.Assess(context.Background(), r)
	if err != nil || got != identity.RemountCandidate || n != 1 {
		t.Fatalf("%v %v calls=%d", got, err, n)
	}
	r = request()
	n = 0
	boom := errors.New("unknown observation")
	svc = New(probeFunc(func(context.Context, string) (identity.Observation, error) { n++; return identity.Observation{}, boom }))
	if _, err = svc.Assess(context.Background(), r); !errors.Is(err, boom) || n != 1 {
		t.Fatal("retry or error swallowed")
	}
}
func TestCancellationAndMissingPortFailClosed(t *testing.T) {
	r := request()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []context.Context{nil, ctx} {
		if _, err := New(nil).Assess(c, r); err == nil {
			t.Fatal("missing cancellation")
		}
	}
	if _, err := New(nil).Assess(context.Background(), r); err == nil {
		t.Fatal("missing dependency")
	}
	ctx, cancel = context.WithCancel(context.Background())
	svc := New(probeFunc(func(context.Context, string) (identity.Observation, error) {
		cancel()
		return identity.Observation{Binding: r.Saved.Binding, Evidence: *r.Saved.Evidence}, nil
	}))
	if _, err := svc.Assess(ctx, r); err == nil {
		t.Fatal("accepted after cancellation")
	}
}
