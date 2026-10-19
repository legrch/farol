package git

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	egressport "github.com/legrch/farol/modules/computer/app/port/egress"
	"github.com/legrch/farol/modules/computer/domain/egress"
)

// buildGate is gateFixture with a hook that edits the intent before sealing it.
func buildGate(t *testing.T, edit func(*egress.Intent, memoryObjects, *[]*object)) (*Gate, *custody, *fakeStream, *fakePeer, egress.Intent, []byte) {
	t.Helper()
	in, known, objects := packFixture(t, "sha1")
	if edit != nil {
		edit(&in, known, &objects)
	}
	plan := mustPlan(t, in)
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

type refusalCase struct {
	name      string
	edit      func(*egress.Intent, memoryObjects, *[]*object)
	setup     func(t *testing.T, c *custody, client *fakeStream, peer *fakePeer, in egress.Intent, wire []byte, ctx *context.Context)
	stage     string
	want      error
	attempted bool
	fenced    bool
}

// Every refusal before the first update byte leaves a precise, separate record:
// which boundary was last observed, the closed reason, whether the durable
// barrier was even attempted, and that the remote cannot have been affected.
func TestRunRefusalsAreStagedClassifiedAndNeverReachTheRemote(t *testing.T) {
	cases := []refusalCase{
		{name: "peer host differs", stage: "admission", want: ErrScope,
			setup: func(_ *testing.T, _ *custody, _ *fakeStream, p *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				p.target.Host = "elsewhere.invalid"
			}},
		{name: "peer port differs", stage: "admission", want: ErrScope,
			setup: func(_ *testing.T, _ *custody, _ *fakeStream, p *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				p.target.Port = 2222
			}},
		{name: "peer user differs", stage: "admission", want: ErrScope,
			setup: func(_ *testing.T, _ *custody, _ *fakeStream, p *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				p.target.User = "other"
			}},
		{name: "peer repository differs", stage: "admission", want: ErrScope,
			setup: func(_ *testing.T, _ *custody, _ *fakeStream, p *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				p.target.Repository = "owner/other.git"
			}},
		{name: "custody denies at admission", stage: "admission", want: ErrScope,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				c.denyAt = 1
			}},
		{name: "context already cancelled", stage: "admission", want: context.Canceled,
			setup: func(t *testing.T, _ *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, ctx *context.Context) {
				c, cancel := context.WithCancel(*ctx)
				cancel()
				*ctx = c
			}},
		{name: "context already expired", stage: "admission", want: context.DeadlineExceeded,
			setup: func(t *testing.T, _ *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, ctx *context.Context) {
				c, cancel := context.WithDeadline(context.Background(), time.Unix(1, 0))
				t.Cleanup(cancel)
				*ctx = c
			}},
		{name: "remote reports an error", stage: "advertisement", want: ErrRemote,
			setup: func(_ *testing.T, _ *custody, _ *fakeStream, p *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				p.reader = bytes.NewReader(pkt("ERR repository not found\n"))
			}},
		{name: "remote advertisement truncated", stage: "advertisement", want: ErrProtocol,
			setup: func(_ *testing.T, _ *custody, _ *fakeStream, p *fakePeer, in egress.Intent, _ []byte, _ *context.Context) {
				p.reader = bytes.NewReader(advertised(in, in.Old)[:20])
			}},
		{name: "custody denies after the advertisement", stage: "advertisement", want: ErrScope,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				c.denyAt = 2
			}},
		{name: "client sends nothing", stage: "client_update", want: ErrPort,
			setup: func(_ *testing.T, _ *custody, cl *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				cl.reader = bytes.NewReader(nil)
			}},
		{name: "client names another ref", stage: "client_update", want: ErrScope,
			setup: func(_ *testing.T, _ *custody, cl *fakeStream, _ *fakePeer, in egress.Intent, wire []byte, _ *context.Context) {
				in.Ref = "refs/heads/feature/other"
				cl.reader = bytes.NewReader(update(in, wire))
			}},
	}
	cases = append(cases,
		refusalCase{name: "client requests an unadvertised feature", stage: "client_update", want: ErrProtocol,
			setup: func(_ *testing.T, _ *custody, cl *fakeStream, _ *fakePeer, in egress.Intent, wire []byte, _ *context.Context) {
				cl.reader = bytes.NewReader(bytes.Replace(update(in, wire), []byte("report-status ofs-delta"), []byte("report-status side-band-64k"), 1))
			}},
		refusalCase{name: "pack trailer corrupt", stage: "pack_validation", want: ErrProtocol,
			setup: func(_ *testing.T, _ *custody, cl *fakeStream, _ *fakePeer, in egress.Intent, wire []byte, _ *context.Context) {
				bad := bytes.Clone(wire)
				bad[len(bad)-1] ^= 1
				cl.reader = bytes.NewReader(update(in, bad))
			}},
		refusalCase{name: "pack over its byte limit", stage: "pack_validation", want: ErrLimit,
			edit: func(in *egress.Intent, _ memoryObjects, _ *[]*object) { in.Limits.PackBytes = 64 }},
		refusalCase{name: "pack truncated", stage: "pack_validation", want: ErrProtocol,
			setup: func(_ *testing.T, _ *custody, cl *fakeStream, _ *fakePeer, in egress.Intent, wire []byte, _ *context.Context) {
				cl.reader = bytes.NewReader(update(in, wire[:len(wire)/2]))
			}},
		refusalCase{name: "pack carries an unapproved object", stage: "pack_validation", want: ErrSource,
			setup: func(t *testing.T, _ *custody, cl *fakeStream, _ *fakePeer, in egress.Intent, _ []byte, _ *context.Context) {
				_, _, objects := packFixture(t, "sha1")
				cl.reader = bytes.NewReader(update(in, makePack(t, "sha1", append(objects, &object{kind: "blob", data: []byte("private canary")}))))
			}},
		refusalCase{name: "custody denies after validation", stage: "pack_validation", want: ErrScope,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				c.denyAt = 3
			}},
		refusalCase{name: "durable barrier refuses", stage: "release_fence", want: ErrScope, attempted: true,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				c.beforeErr = ErrScope
			}},
		refusalCase{name: "durable barrier unavailable", stage: "release_fence", want: ErrPort, attempted: true,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				c.beforeErr = errInjected
			}},
		refusalCase{name: "cancelled while recording the barrier", stage: "release_fence", want: context.Canceled, attempted: true,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, ctx *context.Context) {
				c2, cancel := context.WithCancel(*ctx)
				*ctx = c2
				c.onBegin = cancel
			}},
		refusalCase{name: "custody denies right after the barrier", stage: "release_fence", want: ErrScope, attempted: true, fenced: true,
			setup: func(_ *testing.T, c *custody, _ *fakeStream, _ *fakePeer, _ egress.Intent, _ []byte, _ *context.Context) {
				c.denyAt = 4
			}},
	)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, c, client, peer, in, wire := buildGate(t, tc.edit)
			ctx := bounded(t)
			if tc.setup != nil {
				tc.setup(t, c, client, peer, in, wire, &ctx)
			}
			r, err := g.Run(ctx, client, peer)
			if err == nil {
				t.Fatal("accepted")
			}
			if tc.want == ErrPort {
				wantCode(t, err, ErrPort)
			} else {
				wantIs(t, err, tc.want)
			}
			if r == nil {
				t.Fatal("no observation returned")
			}
			if r.Stage != tc.stage || r.RefOutcome != NotAttempted || r.RemoteMayHaveEffects {
				t.Fatalf("%+v", r)
			}
			if r.ReleaseFenceAttempted != tc.attempted || r.ReleaseFenced != tc.fenced {
				t.Fatalf("fence attempted=%v fenced=%v; want %v %v", r.ReleaseFenceAttempted, r.ReleaseFenced, tc.attempted, tc.fenced)
			}
			if wantBegins := map[bool]int{true: 1, false: 0}[tc.attempted]; c.begins != wantBegins {
				t.Fatalf("barrier invoked %d times", c.begins)
			}
			if len(peer.Bytes()) != 0 || r.CommandBytes != 0 || r.PackBytes != 0 {
				t.Fatal("bytes reached the remote", len(peer.Bytes()))
			}
			if r.OperationID != in.Binding.OperationID || r.IntentDigest != IntentDigest(g.plan) {
				t.Fatalf("identity %+v", r)
			}
			if client.Closed() != 1 || peer.Closed() != 1 {
				t.Fatal("streams not closed exactly once", client.Closed(), peer.Closed())
			}
			if r.ClientNotified {
				t.Fatal("client was told of an outcome")
			}
		})
	}
}

func TestRunWithoutAnUpdateTouchesNeitherBarrierNorRemote(t *testing.T) {
	g, c, client, peer, in, _ := buildGate(t, nil)
	client.reader = bytes.NewReader(flushPkt)
	r, err := g.Run(bounded(t), client, peer)
	if err != nil || r.RefOutcome != NoUpdate || r.Stage != "client_update" || r.ReleaseFenceAttempted || c.begins != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	// The client still saw the (filtered) advertisement, never anything more.
	want := join(pkt(strings.Repeat("0", 40)+" capabilities^{}\x00report-status ofs-delta atomic object-format=sha1\n"), flushPkt)
	if !bytes.Equal(client.Bytes(), want) || len(peer.Bytes()) != 0 {
		t.Fatalf("%q", client.Bytes())
	}
	_ = in
}

func TestCustodyDenialAfterAdvertisementDoesNotForwardIt(t *testing.T) {
	g, c, client, peer, _, _ := buildGate(t, nil)
	c.denyAt = 2
	if _, err := g.Run(bounded(t), client, peer); err == nil {
		t.Fatal("accepted")
	}
	if len(client.Bytes()) != 0 {
		t.Fatalf("advertisement forwarded after revocation: %q", client.Bytes())
	}
}

// The complete wire exchange of one accepted publication, byte for byte.
func TestAcceptedPublicationWireExchangeIsExact(t *testing.T) {
	g, c, client, peer, in, wire := buildGate(t, nil)
	r, err := g.Run(bounded(t), client, peer)
	if err != nil {
		t.Fatal(err)
	}
	prelude := join(pkt(in.Old+" "+in.Head+" "+in.Ref+"\x00report-status atomic object-format=sha1\n"), flushPkt)
	if !bytes.HasPrefix(peer.Bytes(), prelude) || r.CommandBytes != int64(len(prelude)) {
		t.Fatalf("upstream command %q (%d)", peer.Bytes()[:len(prelude)], r.CommandBytes)
	}
	upload := peer.Bytes()[len(prelude):]
	if r.PackBytes != int64(len(upload)) || r.PackSHA256 != packDigest(upload) || r.InputPackSHA256 != packDigest(wire) || r.InputBytes != int64(len(wire)) {
		t.Fatalf("%+v", r)
	}
	wantClient := join(pkt(strings.Repeat("0", 40)+" capabilities^{}\x00report-status ofs-delta atomic object-format=sha1\n"), flushPkt,
		pkt("unpack ok\n"), pkt("ok "+in.Ref+"\n"), flushPkt)
	if !bytes.Equal(client.Bytes(), wantClient) {
		t.Fatalf("client received %q", client.Bytes())
	}
	if r.Stage != "client_report" || r.RefOutcome != Accepted || !r.ClientNotified || r.StreamCleanupUncertain || !r.ReleaseFenceAttempted || !r.ReleaseFenced || !r.RemoteMayHaveEffects {
		t.Fatalf("%+v", r)
	}
	if c.checks != 6 || c.begins != 1 {
		t.Fatal("custody observed", c.checks, c.begins)
	}
}

// A hook or server can write anything. The client sees a closed phrase only.
func TestRejectedPublicationNeverEchoesRemoteText(t *testing.T) {
	g, _, client, peer, in, _ := buildGate(t, nil)
	peer.reader = bytes.NewReader(append(advertised(in, in.Old),
		join(pkt("unpack ok\n"), pkt("ng "+in.Ref+" hook said token=SECRET\x1b]0;x\x07\n"), flushPkt)...))
	r, err := g.Run(bounded(t), client, peer)
	if err != nil || r.RefOutcome != Rejected || !r.RemoteMayHaveEffects || !r.ClientNotified || r.Stage != "client_report" {
		t.Fatalf("%+v %v", r, err)
	}
	if bytes.Contains(client.Bytes(), []byte("SECRET")) || bytes.Contains(client.Bytes(), []byte("\x1b")) {
		t.Fatalf("remote text reached the client: %q", client.Bytes())
	}
	if !bytes.HasSuffix(client.Bytes(), join(pkt("unpack ok\n"), pkt("ng "+in.Ref+" remote rejection\n"), flushPkt)) {
		t.Fatalf("%q", client.Bytes())
	}
}

// Only a fully parsed report may name a ref outcome. Everything else after the
// first update byte stays Unknown, and the remote may have been affected.
func TestEveryPostBarrierFailureStaysUnknown(t *testing.T) {
	ok := func(in egress.Intent) []byte { return report(in.Ref, true) }
	cases := []struct {
		name   string
		status func(in egress.Intent) []byte
		want   error
	}{
		{"nothing received", func(egress.Intent) []byte { return nil }, ErrPort},
		{"report cut after unpack", func(in egress.Intent) []byte { return pkt("unpack ok\n") }, ErrPort},
		{"report without its flush", func(in egress.Intent) []byte { return ok(in)[:len(ok(in))-4] }, ErrPort},
		{"report for another ref", func(egress.Intent) []byte { return report("refs/heads/feature/other", true) }, ErrProtocol},
		{"unknown verb", func(in egress.Intent) []byte { return join(pkt("unpack ok\n"), pkt("maybe "+in.Ref+"\n"), flushPkt) }, ErrProtocol},
		{"success contradicting unpack", func(in egress.Intent) []byte {
			return join(pkt("unpack failed\n"), pkt("ok "+in.Ref+"\n"), flushPkt)
		}, ErrProtocol},
		{"two ref reports", func(in egress.Intent) []byte {
			return join(pkt("unpack ok\n"), pkt("ok "+in.Ref+"\n"), pkt("ok refs/heads/main\n"), flushPkt)
		}, ErrProtocol},
		{"sideband framing", func(in egress.Intent) []byte {
			return join(pkt("\x01"+"000eunpack ok\n"), flushPkt)
		}, ErrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, c, client, peer, in, _ := buildGate(t, nil)
			peer.reader = bytes.NewReader(append(advertised(in, in.Old), tc.status(in)...))
			r, err := g.Run(bounded(t), client, peer)
			if tc.want == ErrPort {
				wantCode(t, err, ErrPort)
			} else {
				wantIs(t, err, tc.want)
			}
			if r.RefOutcome != Unknown || !r.RemoteMayHaveEffects || !r.ReleaseFenced || r.ClientNotified || r.Stage != "remote_report" || c.begins != 1 {
				t.Fatalf("%+v", r)
			}
			if r.CommandBytes == 0 || r.PackBytes != int64(len(peer.Bytes()))-r.CommandBytes {
				t.Fatal("upload accounting", r.CommandBytes, r.PackBytes)
			}
			if bytes.Contains(client.Bytes(), []byte("unpack")) {
				t.Fatal("unparsed report relayed to the client")
			}
		})
	}
}

// failAfter lets the first n writes through, then fails every later write.
type failAfter struct {
	*fakeStream
	n, seen int
}

func (f *failAfter) Write(b []byte) (int, error) {
	if f.seen >= f.n {
		return 0, errInjected
	}
	f.seen++
	return f.fakeStream.Write(b)
}

func TestClientReportFailureKeepsTheRemoteOutcome(t *testing.T) {
	g, _, client, peer, _, _ := buildGate(t, nil)
	flaky := &failAfter{fakeStream: client, n: 2} // the advertisement row and flush pass
	r, err := g.Run(bounded(t), flaky, peer)
	if err == nil || r.RefOutcome != Accepted || r.ClientNotified || r.Stage != "client_report" || !r.RemoteMayHaveEffects {
		t.Fatalf("%+v %v", r, err)
	}
	wantCode(t, err, ErrPort)
}

func TestClientAdvertisementWriteFailureStopsBeforeAnyUpdate(t *testing.T) {
	g, c, client, peer, _, _ := buildGate(t, nil)
	client.writeErr = errInjected
	r, err := g.Run(bounded(t), client, peer)
	if err == nil || r.Stage != "advertisement" || r.RefOutcome != NotAttempted || r.RemoteMayHaveEffects || c.begins != 0 || len(peer.Bytes()) != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

// ---- chunked upload ----------------------------------------------------

func noise(n int) []byte {
	out := make([]byte, 0, n)
	seed := sha256.Sum256([]byte("farol-negative-noise"))
	for len(out) < n {
		out = append(out, seed[:]...)
		seed = sha256.Sum256(seed[:])
	}
	return out[:n]
}

func bigGate(t *testing.T) (*Gate, *custody, *fakeStream, *recPeer, egress.Intent) {
	t.Helper()
	g, c, client, peer, in, _ := buildGate(t, func(in *egress.Intent, _ memoryObjects, objects *[]*object) {
		blob := &object{kind: "blob", data: noise(100 << 10)}
		tr := tree(in.Format, blob)
		head := commit(in.Format, objID(in.Format, tr), in.Base)
		*objects = []*object{head, tr, blob}
		*in = setObjects(*in, in.Format, head, *objects)
	})
	return g, c, client, &recPeer{fakePeer: peer}, in
}

type recPeer struct {
	*fakePeer
	sizes []int
}

func (p *recPeer) Write(b []byte) (int, error) {
	p.sizes = append(p.sizes, len(b))
	return p.fakePeer.Write(b)
}

var _ egressport.Peer = (*recPeer)(nil)

func TestUploadIsChunkedAndRecheckedBetweenChunks(t *testing.T) {
	g, c, client, peer, _ := bigGate(t)
	r, err := g.Run(bounded(t), client, peer)
	if err != nil || r.RefOutcome != Accepted {
		t.Fatal(r, err)
	}
	chunks := int((r.PackBytes + 32<<10 - 1) / (32 << 10))
	if chunks < 4 {
		t.Fatalf("fixture too small to chunk: %d bytes", r.PackBytes)
	}
	// The rebuilt upload must itself be a valid pack: a 100 KiB object needs
	// a multi-byte size header, which a plain accepted/rejected report cannot
	// vouch for.
	upload := peer.fakePeer.Bytes()[r.CommandBytes:]
	back, err := readPack(context.Background(), bytes.NewReader(upload), g.plan, g.objects)
	if err != nil || len(back.objects) != 3 || !bytes.Equal(back.bytes, upload) {
		t.Fatal("canonical upload does not round-trip:", err)
	}
	if len(peer.sizes) != 1+chunks {
		t.Fatalf("writes %v", peer.sizes)
	}
	for _, n := range peer.sizes[1:] {
		if n > 32<<10 {
			t.Fatalf("unbounded write of %d bytes", n)
		}
	}
	// admission, advertisement, validation, barrier, one per chunk, report.
	if c.checks != 5+chunks {
		t.Fatalf("custody observed %d times for %d chunks", c.checks, chunks)
	}
}

func TestRevocationBetweenChunksStopsTheUpload(t *testing.T) {
	g0, _, client0, peer0, _ := bigGate(t)
	r0, err := g0.Run(bounded(t), client0, peer0)
	if err != nil {
		t.Fatal(err)
	}
	chunks := int((r0.PackBytes + 32<<10 - 1) / (32 << 10))
	for _, k := range []int{2, 3, chunks} {
		g, c, client, peer, _ := bigGate(t)
		c.denyAt = 4 + k // the k-th chunk is refused before it is written
		r, err := g.Run(bounded(t), client, peer)
		wantIs(t, err, ErrScope)
		wantBytes := int64(k-1) * (32 << 10)
		if r.PackBytes != wantBytes || r.RefOutcome != Unknown || !r.RemoteMayHaveEffects || r.Stage != "upload" {
			t.Fatalf("chunk %d: %+v", k, r)
		}
		if int64(len(peer.Bytes())) != r.CommandBytes+wantBytes {
			t.Fatal("bytes sent after revocation", k, len(peer.Bytes()))
		}
	}
}

// budgetPeer accepts a fixed number of bytes and then fails mid-write.
type budgetPeer struct {
	*fakePeer
	budget int
}

func (p *budgetPeer) Write(b []byte) (int, error) {
	if len(b) <= p.budget {
		p.budget -= len(b)
		return p.fakePeer.Write(b)
	}
	n := p.budget
	p.budget = 0
	if n > 0 {
		_, _ = p.fakePeer.Write(b[:n])
	}
	return n, errInjected
}

func TestPartialUploadWriteIsAccountedAndStaysUnknown(t *testing.T) {
	g, _, client, peer, _, _ := buildGate(t, nil)
	in := g.plan.Intent()
	prelude := len(join(pkt(in.Old+" "+in.Head+" "+in.Ref+"\x00report-status atomic object-format=sha1\n"), flushPkt))
	short := &budgetPeer{fakePeer: peer, budget: prelude + 37}
	r, err := g.Run(bounded(t), client, short)
	wantCode(t, err, ErrPort)
	if r.RefOutcome != Unknown || !r.RemoteMayHaveEffects || r.CommandBytes != int64(prelude) || r.PackBytes != 37 || r.Stage != "upload" {
		t.Fatalf("%+v", r)
	}
	// A failed command write is also charged byte for byte.
	g2, _, client2, peer2, _, _ := buildGate(t, nil)
	r, err = g2.Run(bounded(t), client2, &budgetPeer{fakePeer: peer2, budget: 5})
	wantCode(t, err, ErrPort)
	if r.CommandBytes != 5 || r.PackBytes != 0 || r.RefOutcome != Unknown || !r.RemoteMayHaveEffects {
		t.Fatalf("%+v", r)
	}
}

// failFirstWrite fails only the first write, then would accept everything.
type failFirstWrite struct {
	*fakePeer
	calls int
}

func (p *failFirstWrite) Write(b []byte) (int, error) {
	p.calls++
	if p.calls == 1 {
		return 0, errInjected
	}
	return p.fakePeer.Write(b)
}

// Once the command write fails, the pack must never follow it.
func TestFailedCommandWriteIsNeverFollowedByPackBytes(t *testing.T) {
	g, _, client, peer, _, _ := buildGate(t, nil)
	flaky := &failFirstWrite{fakePeer: peer}
	r, err := g.Run(bounded(t), client, flaky)
	wantCode(t, err, ErrPort)
	if flaky.calls != 1 || len(peer.Bytes()) != 0 || r.PackBytes != 0 || r.RefOutcome != Unknown || r.Stage != "upload" {
		t.Fatalf("writes=%d bytes=%d %+v", flaky.calls, len(peer.Bytes()), r)
	}
}

func TestInvalidCallsAreRefusedAtAdmissionAndStillCloseWhatTheyWereGiven(t *testing.T) {
	for _, name := range []string{"nil context", "unbounded context", "nil client", "nil peer"} {
		t.Run(name, func(t *testing.T) {
			g, c, client, peer, _, _ := buildGate(t, nil)
			ctx := bounded(t)
			var cl io.ReadWriteCloser = client
			var p egressport.Peer = peer
			switch name {
			case "nil context":
				ctx = nil
			case "unbounded context":
				ctx = context.Background()
			case "nil client":
				cl = nil
			case "nil peer":
				p = nil
			}
			r, err := g.Run(ctx, cl, p)
			want := ErrScope // an unbounded or absent context grants no bounded authority
			if name == "nil client" || name == "nil peer" {
				want = ErrPort // the owner supplied no stream
			}
			wantCode(t, err, want)
			if r.Stage != "admission" || r.RefOutcome != NotAttempted || r.RemoteMayHaveEffects || c.checks != 0 || c.begins != 0 {
				t.Fatalf("%+v checks=%d", r, c.checks)
			}
			if cl != nil && client.Closed() != 1 || p != nil && peer.Closed() != 1 {
				t.Fatal("a provided stream was not closed exactly once")
			}
			if len(peer.Bytes()) != 0 || len(client.Bytes()) != 0 {
				t.Fatal("bytes moved on a refused call")
			}
		})
	}
}

// ---- one-shot authority ------------------------------------------------

func TestGateIsConsumedByEvenARefusedFirstCall(t *testing.T) {
	g, c, client, peer, _, _ := buildGate(t, nil)
	// First call refused at admission: unbounded context.
	if _, err := g.Run(context.Background(), client, peer); err == nil {
		t.Fatal("accepted")
	}
	second := newStream(nil)
	peer2 := &fakePeer{fakeStream: newStream(nil), target: g.plan.Intent().Target}
	r, err := g.Run(bounded(t), second, peer2)
	if !errors.Is(err, ErrReplay) || r != nil || c.begins != 0 || c.checks != 0 {
		t.Fatalf("retry after a refusal: %+v %v", r, err)
	}
	if second.Closed() != 0 || peer2.Closed() != 0 {
		t.Fatal("replay touched the new streams")
	}
}

func TestOnlyOneConcurrentRunProceeds(t *testing.T) {
	g, c, _, _, in, wire := buildGate(t, nil)
	const callers = 8
	var wg sync.WaitGroup
	results := make([]error, callers)
	peers := make([]*fakePeer, callers)
	for i := range callers {
		client := newStream(update(in, wire))
		peers[i] = &fakePeer{fakeStream: newStream(append(advertised(in, in.Old), report(in.Ref, true)...)), target: in.Target}
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, results[i] = g.Run(bounded(t), client, peers[i])
		}()
	}
	wg.Wait()
	replays, ran := 0, 0
	for i, err := range results {
		if errors.Is(err, ErrReplay) {
			replays++
			if peers[i].Closed() != 0 || len(peers[i].Bytes()) != 0 {
				t.Fatal("a losing caller touched its streams")
			}
		} else if err == nil {
			ran++
		}
	}
	if replays != callers-1 || ran != 1 || c.begins != 1 {
		t.Fatal(replays, ran, c.begins)
	}
}

func TestNilAndZeroGatesRefuseWithoutTouchingStreams(t *testing.T) {
	client, peer := newStream(nil), &fakePeer{fakeStream: newStream(nil)}
	var nilGate *Gate
	if r, err := nilGate.Run(bounded(t), client, peer); r != nil || !errors.Is(err, ErrReplay) {
		t.Fatal(r, err)
	}
	if r, err := (&Gate{}).Run(bounded(t), client, peer); r != nil || !errors.Is(err, ErrReplay) {
		t.Fatal(r, err)
	}
	if client.Closed() != 0 || peer.Closed() != 0 {
		t.Fatal("streams touched")
	}
}

func TestNewGateRefusesAnUnsealablePlan(t *testing.T) {
	g, _, _, _, _, _ := buildGate(t, nil)
	if _, err := NewGate(&egress.Plan{}, g.custody, g.objects); !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
	if _, err := NewGate(nil, g.custody, g.objects); !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
	if _, err := NewGate(g.plan, nil, g.objects); !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
}

func TestGateWithoutAnObjectSourceCannotAuthenticateTheBaseline(t *testing.T) {
	g, c, client, peer, _, _ := buildGate(t, nil)
	g.objects = nil
	r, err := g.Run(bounded(t), client, peer)
	wantCode(t, err, ErrPort) // a missing owner reader is the owner's fault, not the source's
	if r.Stage != "pack_validation" || c.begins != 0 || len(peer.Bytes()) != 0 || r.RemoteMayHaveEffects {
		t.Fatalf("%+v", r)
	}
}

// A canonical rebuild that no longer fits the budget is a pre-barrier refusal
// even though the untrusted input pack itself fitted.
func TestCanonicalOverflowIsRefusedBeforeTheBarrier(t *testing.T) {
	text := []byte(strings.Repeat("the quick brown fox jumps over the lazy dog 0123456789\n", 300))
	build := func(t *testing.T) (in egress.Intent, known memoryObjects, objects []*object) {
		in, known, objects = packFixture(t, "sha1")
		blob := &object{kind: "blob", data: text}
		tr := tree(in.Format, blob)
		head := commit(in.Format, objID(in.Format, tr), in.Base)
		objects = []*object{head, tr, blob}
		return setObjects(in, in.Format, head, objects), known, objects
	}
	in, known, objects := build(t)
	tight := encodedPack(t, in.Format, objects, 9, 2) // best compression
	probe, err := readWire(t, in, known, tight)
	if err != nil {
		t.Fatal(err)
	}
	canon, _, err := probe.canonical()
	if err != nil {
		t.Fatal(err)
	}
	if len(tight) >= len(canon) {
		t.Fatalf("fixture does not make the canonical form larger (%d vs %d)", len(tight), len(canon))
	}
	in.Limits.PackBytes = int64(len(tight))
	plan := mustPlan(t, in)
	c := &custody{digest: IntentDigest(plan)}
	g, _ := NewGate(plan, c, known)
	peer := &fakePeer{fakeStream: newStream(append(advertised(in, in.Old), report(in.Ref, true)...)), target: in.Target}
	r, err := g.Run(bounded(t), newStream(update(in, tight)), peer)
	wantIs(t, err, ErrLimit)
	if r.Stage != "pack_validation" || r.InputBytes != int64(len(tight)) || r.PackSHA256 != "" || r.ObjectCount != 0 || c.begins != 0 || len(peer.Bytes()) != 0 {
		t.Fatalf("%+v", r)
	}
}

// ---- stream ownership ---------------------------------------------------

type panicClosePeer struct {
	*fakePeer
}

func (p panicClosePeer) Close() error {
	_ = p.fakePeer.Close()
	panic("private close detail")
}

type panicCloseClient struct{ *fakeStream }

func (c panicCloseClient) Close() error {
	_ = c.fakeStream.Close()
	panic("private close detail")
}

func TestPanickingCloseIsContainedAndBothStreamsAreStillClosed(t *testing.T) {
	g, _, client, peer, _, _ := buildGate(t, nil)
	r, err := g.Run(bounded(t), client, panicClosePeer{peer})
	if err == nil || !r.StreamCleanupUncertain || r.RefOutcome != Accepted || !r.ClientNotified {
		t.Fatalf("%+v %v", r, err)
	}
	wantCode(t, err, ErrPort)
	if strings.Contains(err.Error(), "private close detail") {
		t.Fatal("panic text rendered")
	}
	if client.Closed() != 1 || peer.Closed() != 1 {
		t.Fatal(client.Closed(), peer.Closed())
	}

	g, _, client, peer, _, _ = buildGate(t, nil)
	r, err = g.Run(bounded(t), panicCloseClient{client}, peer)
	if err == nil || !r.StreamCleanupUncertain {
		t.Fatalf("%+v %v", r, err)
	}
	if client.Closed() != 1 || peer.Closed() != 1 {
		t.Fatal("the peer was left open after the client close panicked", client.Closed(), peer.Closed())
	}
}

func TestClientCloseFailureMarksCleanupUncertainWithoutRewritingTheOutcome(t *testing.T) {
	g, _, client, peer, _, _ := buildGate(t, nil)
	client.closeErr = errInjected
	r, err := g.Run(bounded(t), client, peer)
	if err == nil || !r.StreamCleanupUncertain || r.RefOutcome != Accepted || !r.ClientNotified {
		t.Fatalf("%+v %v", r, err)
	}
	if peer.Closed() != 1 {
		t.Fatal("peer left open")
	}
}

// blockingPeer blocks every write until the gate closes it.
type blockingPeer struct {
	target   egress.Target
	script   *bytes.Reader
	once     sync.Once
	closed   chan struct{}
	onWrite  func()
	writeHit chan struct{}
}

func (p *blockingPeer) Read(b []byte) (int, error) { return p.script.Read(b) }
func (p *blockingPeer) Write([]byte) (int, error) {
	p.onWrite()
	<-p.closed
	return 0, io.ErrClosedPipe
}
func (p *blockingPeer) Close() error           { p.once.Do(func() { close(p.closed) }); return nil }
func (p *blockingPeer) Binding() egress.Target { return p.target }

func TestContextEndClosesAStreamBlockedInAWrite(t *testing.T) {
	g, _, client, _, in, _ := buildGate(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	peer := &blockingPeer{target: in.Target, script: bytes.NewReader(advertised(in, in.Old)), closed: make(chan struct{}), onWrite: cancel}
	done := make(chan struct{})
	var r *Result
	var err error
	go func() { defer close(done); r, err = g.Run(ctx, client, peer) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("a blocked write ignored the original context")
	}
	if err == nil || r.RefOutcome != Unknown || !r.RemoteMayHaveEffects || r.Stage != "upload" {
		t.Fatalf("%+v %v", r, err)
	}
	// The interrupted write's own error must not hide that the context ended.
	var f *Failure
	if !errors.As(err, &f) || f.Code() != "GIT_TRANSPORT_CANCELLED" {
		t.Fatalf("cancellation reported as %v", err)
	}
}

func TestStreamErrorsWrappingSentinelsArePortFailures(t *testing.T) {
	g, _, client, peer, _, _ := buildGate(t, nil)
	client.writeErr = errors.Join(errInjected, ErrScope) // looks like a refusal, is a stream fault
	r, err := g.Run(bounded(t), client, peer)
	wantCode(t, err, ErrPort)
	if !errors.Is(err, errInjected) || r.RemoteMayHaveEffects {
		t.Fatalf("%+v %v", r, err)
	}
}

// Overwriting the caller's plan after NewGate must not change what the gate
// enforces: custody saw the digest of the admitted plan only.
func TestGateEnforcesItsAdmittedPlanSnapshot(t *testing.T) {
	g, _, _, _, in, _ := buildGate(t, nil)
	admitted := g.plan
	other := in
	other.Ref = "refs/heads/feature/other"
	replacement, err := egress.NewPlan(other)
	if err != nil {
		t.Fatal(err)
	}
	caller := *admitted
	gate, err := NewGate(&caller, g.custody, g.objects)
	if err != nil {
		t.Fatal(err)
	}
	caller = *replacement // a legal whole-value overwrite of the caller's copy
	if gate.plan.Intent().Ref != in.Ref || gate.digest != IntentDigest(admitted) {
		t.Fatalf("gate follows the caller's overwritten plan: %s", gate.plan.Intent().Ref)
	}
}
