package git

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	egressport "github.com/legrch/farol/modules/computer/app/port/egress"
	"github.com/legrch/farol/modules/computer/domain/egress"
)

func bounded(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	return ctx
}
func gateFixture(t *testing.T) (*Gate, *custody, *fakeStream, *fakePeer, egress.Intent, []byte) {
	t.Helper()
	in, known, objects := packFixture(t, "sha1")
	plan, err := egress.NewPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	wire := makePack(t, in.Format, objects)
	c := &custody{digest: IntentDigest(plan)}
	gate, err := NewGate(plan, c, known)
	if err != nil {
		t.Fatal(err)
	}
	client := newStream(update(in, wire))
	peer := &fakePeer{fakeStream: newStream(append(advertised(in, in.Old), report(in.Ref, true)...)), target: in.Target}
	return gate, c, client, peer, in, wire
}
func TestPublishAcceptedOnlyAfterValidationAndFence(t *testing.T) {
	g, c, client, peer, in, wire := gateFixture(t)
	c.onBegin = func() {
		if len(peer.Bytes()) != 0 {
			t.Fatal("sent before durable barrier")
		}
	}
	r, err := g.Run(bounded(t), client, peer)
	if err != nil {
		t.Fatal(err)
	}
	if r.RefOutcome != Accepted || !r.RemoteMayHaveEffects || !r.ReleaseFenced || !r.ClientNotified || r.ObjectCount != 3 || r.InputBytes != int64(len(wire)) || r.InputPackSHA256 != packDigest(wire) {
		t.Fatalf("%+v", r)
	}
	up := bytes.NewReader(peer.Bytes())
	prelude, flush, e := readPacket(up)
	if e != nil || flush || !bytes.HasPrefix(prelude, []byte(in.Old+" "+in.Head+" "+in.Ref+"\x00report-status")) {
		t.Fatal("unexpected remote prelude")
	}
	_, flush, e = readPacket(up)
	if e != nil || !flush {
		t.Fatal("prelude end")
	}
	payload := make([]byte, up.Len())
	_, _ = io.ReadFull(up, payload)
	if r.PackSHA256 != packDigest(payload) || r.PackBytes != int64(len(payload)) {
		t.Fatal("upload identity")
	}
	if _, e = readPack(context.Background(), bytes.NewReader(payload), g.plan, g.objects); e != nil {
		t.Fatal("canonical upload invalid", e)
	}
	if bytes.Contains(client.Bytes(), []byte("push-options")) || bytes.Contains(client.Bytes(), []byte("side-band")) || bytes.Contains(client.Bytes(), []byte("delete-refs")) {
		t.Fatal("broad features leaked")
	}
	if c.begins != 1 || client.Closed() != 1 || peer.Closed() != 1 {
		t.Fatal(c.begins, client.Closed(), peer.Closed())
	}
}
func TestPublishRefusesBeforeAnyUpdateByte(t *testing.T) {
	for _, name := range []string{"source changed", "revoked", "dirty via owner", "SSH destination changed", "remote created", "wrong ref", "wrong head", "wrong old", "multiple refs", "push options", "delete request", "shallow", "push certificate", "duplicate capability", "corrupt pack", "extra private object", "barrier failed", "cancel before release", "unbounded context"} {
		t.Run(name, func(t *testing.T) {
			g, c, client, peer, in, wire := gateFixture(t)
			ctx := bounded(t)
			switch name {
			case "source changed":
				c.denyAt = 3
			case "revoked":
				c.denyAt = 1
			case "dirty via owner":
				c.beforeErr = ErrScope
			case "SSH destination changed":
				peer.target.Repository = "attacker/repo.git"
			case "remote created":
				peer.reader = bytes.NewReader(advertised(in, in.Base))
			case "wrong ref":
				changed := in
				changed.Ref = "refs/heads/main"
				client.reader = bytes.NewReader(update(changed, wire))
			case "wrong head":
				changed := in
				changed.Head = in.Base
				client.reader = bytes.NewReader(update(changed, wire))
			case "wrong old":
				changed := in
				changed.Old = in.Base
				client.reader = bytes.NewReader(update(changed, wire))
			case "multiple refs":
				a := pkt(in.Old + " " + in.Head + " " + in.Ref + "\x00report-status\n")
				a = append(a, pkt(in.Old+" "+in.Head+" refs/heads/main\n")...)
				client.reader = bytes.NewReader(append(a, []byte("0000")...))
			case "push options":
				client.reader = bytes.NewReader(bytes.ReplaceAll(update(in, wire), []byte("report-status ofs-delta"), []byte("report-status push-options")))
			case "delete request":
				changed := in
				changed.Head = in.Old
				client.reader = bytes.NewReader(update(changed, wire))
			case "shallow":
				client.reader = bytes.NewReader(append(pkt("shallow "+in.Base+"\n"), update(in, wire)...))
			case "push certificate":
				client.reader = bytes.NewReader(pkt("push-cert\x00report-status\n"))
			case "duplicate capability":
				client.reader = bytes.NewReader(bytes.ReplaceAll(update(in, wire), []byte("report-status ofs-delta"), []byte("report-status report-status")))
			case "corrupt pack":
				wire[len(wire)-1] ^= 1
				client.reader = bytes.NewReader(update(in, wire))
			case "extra private object":
				_, _, objects := packFixture(t, "sha1")
				wire = makePack(t, "sha1", append(objects, &object{kind: "blob", data: []byte("private canary")}))
				client.reader = bytes.NewReader(update(in, wire))
			case "barrier failed":
				c.beforeErr = errInjected
			case "cancel before release":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				c.onBegin = cancel
			case "unbounded context":
				ctx = context.Background()
			}
			r, err := g.Run(ctx, client, peer)
			if err == nil {
				t.Fatal("accepted")
			}
			if len(peer.Bytes()) != 0 || r.RemoteMayHaveEffects || r.RefOutcome != NotAttempted {
				t.Fatalf("leaked before validation: %+v / %d", r, len(peer.Bytes()))
			}
		})
	}
}
func TestPublishOutcomesRemainDistinct(t *testing.T) {
	for _, name := range []string{"write failure", "write panic", "lost status", "wrong status ref", "rejected", "cleanup uncertain", "noop", "untrusted trailing data"} {
		t.Run(name, func(t *testing.T) {
			g, _, client, peer, in, wire := gateFixture(t)
			switch name {
			case "write failure":
				peer.writeErr = errInjected
			case "write panic":
				peer.panicWrite = true
			case "lost status":
				peer.reader = bytes.NewReader(advertised(in, in.Old))
			case "wrong status ref":
				peer.reader = bytes.NewReader(append(advertised(in, in.Old), report("refs/heads/main", true)...))
			case "rejected":
				peer.reader = bytes.NewReader(append(advertised(in, in.Old), report(in.Ref, false)...))
			case "cleanup uncertain":
				peer.closeErr = errInjected
			case "noop":
				client.reader = bytes.NewReader([]byte("0000"))
			case "untrusted trailing data":
				client.reader = bytes.NewReader(append(update(in, wire), []byte("PRIVATE_UNREACHABLE_TRAILER")...))
			}
			r, err := g.Run(bounded(t), client, peer)
			switch name {
			case "rejected":
				if err != nil || r.RefOutcome != Rejected || !r.RemoteMayHaveEffects {
					t.Fatal(r, err)
				}
			case "cleanup uncertain":
				if err == nil || r.RefOutcome != Accepted || !r.StreamCleanupUncertain {
					t.Fatal(r, err)
				}
			case "noop":
				if err != nil || r.RefOutcome != NoUpdate || r.RemoteMayHaveEffects || len(peer.Bytes()) != 0 {
					t.Fatal(r, err)
				}
			case "untrusted trailing data":
				if err != nil || bytes.Contains(peer.Bytes(), []byte("PRIVATE_UNREACHABLE_TRAILER")) || r.RefOutcome != Accepted {
					t.Fatal(r, err)
				}
			default:
				if err == nil || r.RefOutcome != Unknown || !r.RemoteMayHaveEffects || !r.ReleaseFenced {
					t.Fatal(r, err)
				}
			}
		})
	}
}
func TestReplayUsesSameOwnerAcrossGateInstances(t *testing.T) {
	g, c, client, peer, in, wire := gateFixture(t)
	if _, err := g.Run(bounded(t), client, peer); err != nil {
		t.Fatal(err)
	}
	a := newStream(update(in, wire))
	b := &fakePeer{newStream(append(advertised(in, in.Old), report(in.Ref, true)...)), in.Target}
	if _, err := g.Run(bounded(t), a, b); !errors.Is(err, ErrReplay) {
		t.Fatal(err)
	}
	if a.Closed() != 0 || b.Closed() != 0 {
		t.Fatal("replay touched unrelated streams")
	}
	fresh, _ := NewGate(g.plan, c, g.objects)
	r, err := fresh.Run(bounded(t), a, b)
	if !errors.Is(err, ErrReplay) || r.RemoteMayHaveEffects || len(b.Bytes()) != 0 {
		t.Fatal(r, err)
	}
}
func TestUnknownReadbackNeverBecomesAnAttributedSuccess(t *testing.T) {
	g, _, _, _, in, _ := gateFixture(t)
	r := Result{OperationID: in.Binding.OperationID, IntentDigest: IntentDigest(g.plan), RefOutcome: Unknown, RemoteMayHaveEffects: true}
	for _, oid := range []string{"", in.Head, in.Base, in.Old} {
		obs, err := Reconcile(g.plan, r, oid)
		if err != nil {
			t.Fatal(err)
		}
		if obs.Original != Unknown {
			t.Fatal("rewrote original")
		}
		if oid == in.Head && obs.State != TargetObserved {
			t.Fatal(obs)
		}
	}
	if _, err := Reconcile(g.plan, r, "short"); err == nil {
		t.Fatal("short oid")
	}
	r.OperationID = "other"
	if _, err := Reconcile(g.plan, r, in.Head); err == nil {
		t.Fatal("crossed operation")
	}
}

type pipePeer struct {
	net.Conn
	target egress.Target
}

func (p pipePeer) Binding() egress.Target { return p.target }
func TestContextClosesOriginalBlockedStreams(t *testing.T) {
	g, _, _, _, in, _ := gateFixture(t)
	local, otherLocal := net.Pipe()
	remote, otherRemote := net.Pipe()
	defer otherLocal.Close()
	defer otherRemote.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		r, err := g.Run(ctx, local, pipePeer{remote, in.Target})
		if err == nil || r.RemoteMayHaveEffects {
			t.Errorf("%+v %v", r, err)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked read ignored original deadline")
	}
}
func TestAdvertisementAndStatusRejections(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	for _, name := range []string{"empty", "duplicate ref", "missing report", "wrong format", "zero ref", "unsupported v2"} {
		t.Run(name, func(t *testing.T) {
			ad := advertised(in, in.Old)
			switch name {
			case "empty":
				ad = []byte("0000")
			case "duplicate ref":
				ad = append(pkt(in.Base+" refs/heads/main\x00report-status\n"), pkt(in.Base+" refs/heads/main\n")...)
				ad = append(ad, []byte("0000")...)
			case "missing report":
				ad = append(pkt(in.Old+" capabilities^{}\x00ofs-delta\n"), []byte("0000")...)
			case "wrong format":
				ad = append(pkt(in.Old+" capabilities^{}\x00report-status object-format=sha256\n"), []byte("0000")...)
			case "zero ref":
				ad = append(pkt(in.Old+" refs/heads/main\x00report-status\n"), []byte("0000")...)
			case "unsupported v2":
				ad = append(pkt("version 2\n"), ad...)
			}
			if _, err := readAdvertisement(bytes.NewReader(ad), in); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	for _, bad := range [][]byte{[]byte("0000"), report("refs/heads/other", true), append(append(pkt("unpack fail\n"), pkt("ok "+in.Ref+"\n")...), []byte("0000")...), append(report(in.Ref, true)[:len(report(in.Ref, true))-4], pkt("ok other\n")...)} {
		if _, _, err := readStatus(bytes.NewReader(bad), in.Ref); err == nil {
			t.Fatal("accepted bad status")
		}
	}
	ad, err := readAdvertisement(bytes.NewReader(advertised(in, in.Old)), in)
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := ad.writeTo(&b); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(b.String(), "push-options") {
		t.Fatal("options")
	}
}
func TestNoDefaultPermission(t *testing.T) {
	g, _, _, _, _, _ := gateFixture(t)
	if _, err := NewGate(nil, g.custody, nil); err == nil {
		t.Fatal("nil plan")
	}
	if _, err := NewGate(g.plan, nil, nil); err == nil {
		t.Fatal("nil owner")
	}
}

var _ io.ReadWriteCloser = (*fakeStream)(nil)

func TestInvalidCallStillClosesItsProvidedOriginalStreams(t *testing.T) {
	for _, name := range []string{"nil context", "unbounded", "nil client", "nil peer"} {
		t.Run(name, func(t *testing.T) {
			g, _, client, peer, _, _ := gateFixture(t)
			ctx := bounded(t)
			var c io.ReadWriteCloser = client
			var p egressport.Peer = peer
			switch name {
			case "nil context":
				ctx = nil
			case "unbounded":
				ctx = context.Background()
			case "nil client":
				c = nil
			case "nil peer":
				p = nil
			}
			r, err := g.Run(ctx, c, p)
			if err == nil || r.RemoteMayHaveEffects {
				t.Fatal(r, err)
			}
			if c != nil && client.Closed() != 1 {
				t.Fatal("client leak")
			}
			if p != nil && peer.Closed() != 1 {
				t.Fatal("peer leak")
			}
		})
	}
}

func TestFailureDoesNotRenderPrivatePortCause(t *testing.T) {
	g, _, client, peer, _, _ := gateFixture(t)
	private := errors.New("private-token-and-original-cause")
	peer.writeErr = private
	r, err := g.Run(bounded(t), client, peer)
	if err == nil || strings.Contains(err.Error(), private.Error()) || !errors.Is(err, private) || r.RefOutcome != Unknown {
		t.Fatal(r, err)
	}
	var f *Failure
	if !errors.As(err, &f) || f.Code() != ErrPort.Error() {
		t.Fatal("classification missing", err)
	}
}

func TestRevocationDuringUploadNeverReturnsAccepted(t *testing.T) {
	for _, check := range []int{4, 5, 6} {
		g, c, client, peer, _, _ := gateFixture(t)
		c.denyAt = check
		r, err := g.Run(bounded(t), client, peer)
		if err == nil {
			t.Fatal("revocation ignored", check)
		}
		if check == 4 && (r.RemoteMayHaveEffects || r.RefOutcome != NotAttempted) {
			t.Fatal(r)
		}
		if check == 5 && (!r.RemoteMayHaveEffects || r.RefOutcome != Unknown) {
			t.Fatal(r)
		}
		// Check 6 follows the actual status; retaining that observation is not
		// client disclosure or renewed permission.
		if check == 6 && (r.ClientNotified || r.RefOutcome != Accepted) {
			t.Fatal(r)
		}
	}
}

// A zero Plan is not an admitted publication. Empty result fields must not
// manufacture a matching original operation during post-disconnect readback.
func TestReconcileRejectsUnboundPlan(t *testing.T) {
	for _, test := range []struct {
		name string
		plan *egress.Plan
	}{{"nil", nil}, {"zero", &egress.Plan{}}} {
		t.Run(test.name, func(t *testing.T) {
			if got, err := Reconcile(test.plan, Result{}, ""); !errors.Is(err, ErrScope) || got != (Readback{}) {
				t.Fatalf("unbound readback accepted: %+v, %v", got, err)
			}
		})
	}
}

func TestIntentDigestBindsImmutableCanonicalPlan(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	plan, err := egress.NewPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	original := plan.Canonical()
	hash := sha256.Sum256([]byte(original))
	want := hex.EncodeToString(hash[:])
	in.Head = in.Base
	in.Objects[0].Digest = strings.Repeat("0", 64)
	copy := plan.Intent()
	copy.Binding.SourceSeal = strings.Repeat("c", 64)
	copy.Known[0].Kind = "blob"
	if IntentDigest(plan) != want || plan.Canonical() != original {
		t.Fatal("caller mutation changed immutable publication binding")
	}
	if IntentDigest(nil) != "" || IntentDigest(&egress.Plan{}) != "" {
		t.Fatal("invalid plan acquired a seal")
	}
}
