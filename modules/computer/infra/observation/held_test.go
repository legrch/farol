package observation

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

// The native graph retains nodes via descriptors even after a named path is
// replaced. Mount identities here are SYNTHETIC, never APFS qualification.
type retainedFake struct {
	*fakeOperations
	mountID    mountInstance
	mountCalls int
	failMount  int
	mountHook  func(*retainedFake)
}

func newRetainedFake() *retainedFake {
	return &retainedFake{
		fakeOperations: newFake(),
		mountID: mountInstance{
			FSID: [2]int32{14, 17}, Filesystem: "apfs",
			MountedOn: "/System/Volumes/Data", MountedFrom: "/dev/disk3s1", Flags: 1,
		},
	}
}
func (o *retainedFake) mount(fd int) (mountInstance, error) {
	o.mountCalls++
	if o.fds[fd] == nil {
		panic("mount queried after descriptor close")
	}
	if o.failMount == o.mountCalls {
		return mountInstance{}, errors.New("native mount refusal")
	}
	if o.mountHook != nil {
		o.mountHook(o)
	}
	return o.mountID, nil
}
func retained(t *testing.T, o *retainedFake) *heldObservation {
	t.Helper()
	h, err := hold(context.Background(), "/approved/work", o)
	if err != nil {
		t.Fatal(err)
	}
	l, ok := h.(*heldObservation)
	if !ok {
		t.Fatal("unexpected handle type")
	}
	return l
}
func TestHeldCandidateRetainsOneOriginalChainAndCopiesSnapshot(t *testing.T) {
	o := newRetainedFake()
	h := retained(t, o)
	if len(h.held) != 3 || len(o.fds) != 3 || h.held[0].fd == h.held[1].fd || h.held[1].fd == h.held[2].fd {
		t.Fatalf("original descriptor chain not retained: %d %d", len(h.held), len(o.fds))
	}
	original, err := h.Snapshot()
	if err != nil || !original.Valid() || original.Binding.Inode != "3" {
		t.Fatalf("snapshot: %+v %v", original, err)
	}
	copy := original
	copy.Binding.Path = "/wrong"
	copy.Evidence.FileID = "999"
	again, err := h.Snapshot()
	if err != nil || again != original {
		t.Fatal("Snapshot leaked mutable state")
	}
	opened := o.opens
	o.target().children["new-content"] = &node{}
	for i := 0; i < 3; i++ {
		if err := h.Requalify(context.Background()); err != nil {
			t.Fatalf("content churn/recheck %d: %v", i, err)
		}
		if len(o.fds) != 3 || h.initial != original {
			t.Fatal("original descriptors replaced during requalification")
		}
	}
	if o.opens <= opened {
		t.Fatal("missing ephemeral named-path verification")
	}
	if err := h.Close(); err != nil || len(o.fds) != 0 || o.closes != o.next {
		t.Fatalf("close failed: %v, fds %d, open %d, closes %d", err, len(o.fds), o.next, o.closes)
	}
	before := o.closes
	if err := h.Close(); err != nil || o.closes != before {
		t.Fatal("idempotent Close repeated a native effect")
	}
	if _, err := h.Snapshot(); code(err) != "WORKSPACE_IDENTITY_CLOSED" {
		t.Fatalf("snapshot use-after-close: %v", err)
	}
	if err := h.Requalify(context.Background()); code(err) != "WORKSPACE_IDENTITY_CLOSED" {
		t.Fatalf("requalify use-after-close: %v", err)
	}
}
func TestHeldCandidateDetectsReplacementWithoutRevivingStaleHandle(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*retainedFake)
	}{
		{"same-path replacement", func(o *retainedFake) {
			old := o.target()
			n := *old
			n.identity.Inode = 99
			o.root.children["approved"].children["work"] = &n
		}},
		{"symlink replacement", func(o *retainedFake) {
			n := *o.target()
			n.symlink = true
			o.root.children["approved"].children["work"] = &n
		}},
		{"ancestor replacement", func(o *retainedFake) {
			n := *o.root.children["approved"]
			n.identity.Inode = 99
			o.root.children["approved"] = &n
		}},
		{"held target inode changed", func(o *retainedFake) { o.target().identity.Inode = 99 }},
		{"held target device changed", func(o *retainedFake) { o.target().identity.Device = 25 }},
		{"ownership changed", func(o *retainedFake) { o.target().identity.UID = 42 }},
		{"permission changed", func(o *retainedFake) { o.target().identity.Mode |= 0022 }},
		{"birth time changed", func(o *retainedFake) { o.target().identity.BirthSeconds++ }},
		{"volume UUID changed", func(o *retainedFake) { o.volume = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }},
		{"mount instance changed at same device and inode", func(o *retainedFake) { o.mountID.FSID[0]++ }},
		{"mount source changed", func(o *retainedFake) { o.mountID.MountedFrom = "/dev/disk-clone" }},
		{"mount flags changed", func(o *retainedFake) { o.mountID.Flags++ }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := newRetainedFake()
			h := retained(t, o)
			orig := o.target()
			ancestor := o.root.children["approved"]
			originalVolume, originalMount := o.volume, o.mountID
			oldAttrs, oldAnc := orig.identity, ancestor.identity
			tc.mutate(o)
			if code(h.Requalify(context.Background())) != "WORKSPACE_RACE_DETECTED" {
				t.Fatal("stale candidate accepted")
			}
			// Recovery at the same name after a detected race may NOT revive a
			// previously rejected holder; a future operation needs a new Hold.
			o.root.children["approved"] = ancestor
			ancestor.identity = oldAnc
			ancestor.children["work"] = orig
			orig.identity = oldAttrs
			o.volume, o.mountID = originalVolume, originalMount
			before := o.opens
			if code(h.Requalify(context.Background())) != "WORKSPACE_RACE_DETECTED" || o.opens != before {
				t.Fatal("poisoned requalification unexpectedly performed native I/O")
			}
			if got, err := h.Snapshot(); code(err) != "WORKSPACE_RACE_DETECTED" || got != (identity.Observation{}) {
				t.Fatalf("stale snapshot accepted: %v %v", got, err)
			}
			if err := h.Close(); err != nil || len(o.fds) != 0 {
				t.Fatalf("stale handle cleanup %v: %d", err, len(o.fds))
			}
		})
	}
}
func TestHeldCandidateRefusesCancellationBeforeEffectsAndCloseFailure(t *testing.T) {
	o := newRetainedFake()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if h, err := hold(ctx, "/approved/work", o); h != nil || code(err) != "WORKSPACE_REQUEST_CANCELLED" || o.opens != 0 {
		t.Fatalf("cancelled Hold performed effects: %v %v", h, err)
	}
	if h, err := hold(nil, "/approved/work", o); h != nil || code(err) != "WORKSPACE_REQUEST_CANCELLED" || o.opens != 0 {
		t.Fatalf("nil context accepted: %v %v", h, err)
	}
	for _, path := range []string{"/", "../work", "/approved//work", "/approved/../work", "/approved/work/"} {
		if h, err := hold(context.Background(), path, o); h != nil || code(err) != "WORKSPACE_PATH_REFUSED" || o.opens != 0 {
			t.Fatalf("path %s reached native effect: %v %v", path, h, err)
		}
	}
	h := retained(t, o)
	if err := h.Requalify(ctx); code(err) != "WORKSPACE_REQUEST_CANCELLED" {
		t.Fatalf("cancelled requalify: %v", err)
	}
	// A pre-IO cancellation does not poison an otherwise qualified handle.
	if err := h.Requalify(context.Background()); err != nil {
		t.Fatalf("cancelled without I/O poisoned handle: %v", err)
	}
	o.closeFail = true
	if code(h.Close()) != "WORKSPACE_IDENTITY_UNAVAILABLE" {
		t.Fatal("unconfirmed close was not reported")
	}
	closes := o.closes
	if code(h.Close()) != "WORKSPACE_IDENTITY_UNAVAILABLE" || o.closes != closes || len(o.fds) != 0 {
		t.Fatal("unconfirmed close replayed or leaked")
	}
	if _, err := h.Snapshot(); code(err) != "WORKSPACE_IDENTITY_CLOSED" {
		t.Fatal("failed close allowed Snapshot")
	}
}
func TestHeldCandidateEveryAcquisitionFaultCleansOnce(t *testing.T) {
	for _, kind := range []string{"open", "stat", "mount", "facts", "invalid-evidence", "cancel", "close"} {
		for i := 1; i <= 6; i++ {
			t.Run(fmt.Sprintf("%s-%d", kind, i), func(t *testing.T) {
				o := newRetainedFake()
				switch kind {
				case "open":
					o.failOpen = i
				case "stat":
					o.failStat = i
				case "mount":
					o.failMount = i
				case "facts":
					o.failFacts = fail("WORKSPACE_IDENTITY_UNAVAILABLE")
				case "invalid-evidence":
					o.evidenceEdit = func(e *identity.Evidence) { e.VolumeUUID = "" }
				case "cancel":
					ctx, stop := context.WithCancel(context.Background())
					defer stop()
					o.cancel = stop
					_, err := hold(ctx, "/approved/work", o)
					if code(err) != "WORKSPACE_REQUEST_CANCELLED" || len(o.fds) != 0 {
						t.Fatalf("%v fds=%d", err, len(o.fds))
					}
					return
				case "close":
					o.closeFail = true
				}
				got, err := hold(context.Background(), "/approved/work", o)
				if got != nil {
					if kind == "open" || kind == "stat" || kind == "mount" {
						// Fault point may lie after all calls in a successful Hold.
						if err := got.Close(); err != nil {
							t.Fatal(err)
						}
					} else {
						t.Fatalf("accepted %s fault", kind)
					}
				} else if err == nil {
					t.Fatal("nil handle without error")
				}
				if len(o.fds) != 0 || o.closes > o.next {
					t.Fatalf("fault %s/%d leaked or retried close: %d fds, %d closes, %d opened", kind, i, len(o.fds), o.closes, o.next)
				}
			})
		}
	}
}
func TestHeldCandidateMountErrorAndEmptyMountAreSticky(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*retainedFake)
	}{
		{"native failure", func(o *retainedFake) { o.failMount = o.mountCalls + 1 }},
		{"missing FSID", func(o *retainedFake) { o.mountID.FSID = [2]int32{} }},
		{"missing mounted-on path", func(o *retainedFake) { o.mountID.MountedOn = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := newRetainedFake()
			h := retained(t, o)
			tc.mutate(o)
			if code(h.Requalify(context.Background())) != "WORKSPACE_IDENTITY_UNAVAILABLE" {
				t.Fatal("mount failure did not close future read eligibility")
			}
			before := o.mountCalls
			if code(h.Requalify(context.Background())) != "WORKSPACE_IDENTITY_UNAVAILABLE" || o.mountCalls != before {
				t.Fatal("mount failure retried")
			}
			if err := h.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestHeldCandidateConcurrentAccessAndCloseAreSerialized(t *testing.T) {
	o := newRetainedFake()
	h := retained(t, o)
	var wg sync.WaitGroup
	for j := 0; j < 8; j++ {
		wg.Add(1)
		go func(j int) {
			defer wg.Done()
			for k := 0; k < 20; k++ {
				if j%2 == 0 {
					_, err := h.Snapshot()
					if err != nil && code(err) != "WORKSPACE_IDENTITY_CLOSED" {
						t.Errorf("snapshot: %v", err)
					}
				} else {
					err := h.Requalify(context.Background())
					if err != nil && code(err) != "WORKSPACE_IDENTITY_CLOSED" {
						t.Errorf("requalify: %v", err)
					}
				}
			}
		}(j)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	}()
	wg.Wait()
	if len(o.fds) != 0 || o.closes != o.next {
		t.Fatalf("concurrent close leak: %d fds, opens %d, closes %d", len(o.fds), o.next, o.closes)
	}
}

func TestHeldCandidateObservedRacePoisonsEvenIfContextAlsoCancels(t *testing.T) {
	o := newRetainedFake()
	h := retained(t, o)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o.failFacts = fail("WORKSPACE_RACE_DETECTED")
	o.cancel = cancel
	if code(h.Requalify(ctx)) != "WORKSPACE_RACE_DETECTED" {
		t.Fatal("injected read-only race not reported")
	}
	o.failFacts = nil
	o.cancel = nil
	before := o.opens
	if code(h.Requalify(context.Background())) != "WORKSPACE_RACE_DETECTED" || o.opens != before {
		t.Fatal("cancellation revived a stale holder")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
}
func TestHeldCandidatePartialCleanupFailureIsClassified(t *testing.T) {
	o := newRetainedFake()
	o.failStat = 2
	o.closeFail = true
	h, err := hold(context.Background(), "/approved/work", o)
	if h != nil || code(err) != "WORKSPACE_IDENTITY_UNAVAILABLE" || len(o.fds) != 0 || o.closes != 2 {
		t.Fatalf("partial cleanup result %v %v, fds=%d closes=%d", h, err, len(o.fds), o.closes)
	}
}
