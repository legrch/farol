package git

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

const adCaps = "report-status ofs-delta"

func adFirst(oid, ref, caps string) []byte { return pkt(oid + " " + ref + "\x00" + caps + "\n") }
func adRow(oid, ref string) []byte         { return pkt(oid + " " + ref + "\n") }

var flushPkt = []byte("0000")

func TestReadAdvertisementRefusesWithSpecificReason(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	zero := strings.Repeat("0", 40)
	cases := []struct {
		name   string
		mutate func(*egress.Intent)
		wire   []byte
		want   error
	}{
		{"version line repeated", nil, join(pkt("version 1\n"), pkt("version 1\n"), adFirst(zero, "capabilities^{}", adCaps), flushPkt), ErrProtocol},
		{"remote error packet first", nil, pkt("ERR access denied\n"), ErrRemote},
		{"remote error packet after refs", nil, join(adFirst(in.Base, "refs/heads/main", adCaps), pkt("ERR boom\n")), ErrRemote},
		{"first row without capabilities", nil, join(pkt(in.Base+" refs/heads/main\n"), flushPkt), ErrProtocol},
		{"first row with two NUL sections", nil, join(pkt(in.Base+" refs/heads/main\x00report-status\x00more\n"), flushPkt), ErrProtocol},
		{"later row carries capabilities", nil, join(adFirst(in.Base, "refs/heads/main", adCaps), pkt(in.Base+" refs/heads/x\x00report-status\n"), flushPkt), ErrProtocol},
		{"duplicate capability", nil, join(adFirst(zero, "capabilities^{}", "report-status report-status"), flushPkt), ErrProtocol},
		{"oversize capability", nil, join(adFirst(zero, "capabilities^{}", "report-status "+strings.Repeat("a", 257)), flushPkt), ErrProtocol},
		{"control byte in capability", nil, join(adFirst(zero, "capabilities^{}", "report-status x\x01y"), flushPkt), ErrProtocol},
		{"DEL byte in capability", nil, join(adFirst(zero, "capabilities^{}", "report-status x\x7fy"), flushPkt), ErrProtocol},
		{"non ASCII capability", nil, join(adFirst(zero, "capabilities^{}", "report-status café"), flushPkt), ErrProtocol},
		{"row with a single field", nil, join(pkt("justonefield\x00"+adCaps+"\n"), flushPkt), ErrProtocol},
		{"row with an extra field", nil, join(adFirst(in.Base, "refs/heads/main extra", adCaps), flushPkt), ErrProtocol},
		{"short object id", nil, join(adFirst("abc", "refs/heads/main", adCaps), flushPkt), ErrProtocol},
		{"uppercase object id", nil, join(adFirst(strings.ToUpper(in.Base), "refs/heads/main", adCaps), flushPkt), ErrProtocol},
		{"zero id on an ordinary ref", nil, join(adFirst(zero, "refs/heads/main", adCaps), flushPkt), ErrProtocol},
		{"placeholder with a real id", nil, join(adFirst(in.Base, "capabilities^{}", adCaps), flushPkt), ErrProtocol},
		{"placeholder after a ref", nil, join(adFirst(in.Base, "refs/heads/main", adCaps), adRow(zero, "capabilities^{}"), flushPkt), ErrProtocol},
		{"ref after the empty placeholder", nil, join(adFirst(zero, "capabilities^{}", adCaps), adRow(in.Base, "refs/heads/main"), flushPkt), ErrProtocol},
		{"ref name with dots", nil, join(adFirst(in.Base, "refs/heads/a..b", adCaps), flushPkt), ErrProtocol},
		{"bare HEAD is not a receive-pack ref", nil, join(adFirst(in.Base, "HEAD", adCaps), flushPkt), ErrProtocol},
		{"no flush terminator", nil, adFirst(in.Base, "refs/heads/main", adCaps), io.EOF},
		{"malformed length", nil, []byte("zzzz"), ErrProtocol},
		{"byte limit exceeded", func(i *egress.Intent) { i.Limits.AdvertisementBytes = 64 }, advertised(in, in.Old), ErrLimit},
		{"ref count exceeded", func(i *egress.Intent) { i.Limits.RefCount = 1 },
			join(adFirst(in.Base, "refs/heads/main", adCaps), adRow(in.Base, "refs/heads/other"), flushPkt), ErrLimit},
		{"remote ref already exists", nil, join(adFirst(in.Base, in.Ref, adCaps), flushPkt), ErrRemote},
		{"expected predecessor moved", func(i *egress.Intent) { i.Old = i.Base },
			join(adFirst(strings.Repeat("d", 40), in.Ref, adCaps), flushPkt), ErrRemote},
		{"expected predecessor missing", func(i *egress.Intent) { i.Old = i.Base },
			join(adFirst(in.Base, "refs/heads/main", adCaps), flushPkt), ErrRemote},
		{"expected predecessor deleted", func(i *egress.Intent) { i.Old = i.Base },
			join(adFirst(zero, "capabilities^{}", adCaps), flushPkt), ErrRemote},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			intent := in
			if tc.mutate != nil {
				tc.mutate(&intent)
			}
			_, err := readAdvertisement(bytes.NewReader(tc.wire), intent)
			wantIs(t, err, tc.want)
		})
	}
}

func TestReadAdvertisementByteAndRefLimitsAreInclusive(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	wire := advertised(in, in.Old)
	in.Limits.AdvertisementBytes = len(wire)
	if _, err := readAdvertisement(bytes.NewReader(wire), in); err != nil {
		t.Fatal("exact byte limit refused:", err)
	}
	in.Limits.AdvertisementBytes = len(wire) - 1
	_, err := readAdvertisement(bytes.NewReader(wire), in)
	wantIs(t, err, ErrLimit)

	in, _, _ = packFixture(t, "sha1")
	two := join(adFirst(in.Base, "refs/heads/main", adCaps), adRow(in.Base, "refs/heads/other"), flushPkt)
	in.Limits.RefCount = 2
	if _, err := readAdvertisement(bytes.NewReader(two), in); err != nil {
		t.Fatal("exact ref limit refused:", err)
	}
}

func TestReadAdvertisementAcceptsOnlyTheDocumentedSpellings(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	zero := strings.Repeat("0", 40)
	cases := []struct {
		name   string
		mutate func(*egress.Intent)
		wire   []byte
	}{
		{"version 1 prefix", nil, join(pkt("version 1\n"), adFirst(zero, "capabilities^{}", adCaps), flushPkt)},
		{"printable ASCII extremes in a capability", nil, join(adFirst(zero, "capabilities^{}", "report-status !~"), flushPkt)},
		{"256 byte capability", nil, join(adFirst(zero, "capabilities^{}", "report-status "+strings.Repeat("a", 256)), flushPkt)},
		{"peeled tag and have rows", nil, join(adFirst(in.Base, "refs/tags/v1", adCaps), adRow(in.Base, "refs/tags/v1^{}"), adRow(in.Base, ".have"), flushPkt)},
		{"sha1 without object-format", nil, join(adFirst(zero, "capabilities^{}", "report-status"), flushPkt)},
		{"matching non-zero predecessor", func(i *egress.Intent) { i.Old = i.Base }, join(adFirst(in.Base, in.Ref, adCaps), flushPkt)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			intent := in
			if tc.mutate != nil {
				tc.mutate(&intent)
			}
			if _, err := readAdvertisement(bytes.NewReader(tc.wire), intent); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestReadAdvertisementSHA256NeedsExplicitObjectFormat(t *testing.T) {
	in, _, _ := packFixture(t, "sha256")
	zero := strings.Repeat("0", 64)
	for _, tc := range []struct {
		name string
		caps string
		want error
	}{
		{"declared", "report-status object-format=sha256", nil},
		{"absent means sha1", "report-status", ErrRemote},
		{"other format", "report-status object-format=sha1", ErrRemote},
		{"both formats", "report-status object-format=sha1 object-format=sha256", ErrProtocol},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readAdvertisement(bytes.NewReader(join(adFirst(zero, "capabilities^{}", tc.caps), flushPkt)), in)
			if tc.want == nil && err != nil {
				t.Fatal(err)
			}
			if tc.want != nil {
				wantIs(t, err, tc.want)
			}
		})
	}
}

// Only a closed, negotiated subset may ever reach the client or the remote.
func TestForwardedAdvertisementHasNoBroadFeatures(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			in, _, _ := packFixture(t, format)
			ad, err := readAdvertisement(bytes.NewReader(advertised(in, in.Old)), in)
			if err != nil {
				t.Fatal(err)
			}
			var b bytes.Buffer
			if err = ad.writeTo(&b); err != nil {
				t.Fatal(err)
			}
			want := join(pkt(strings.Repeat("0", len(in.Head))+" capabilities^{}\x00report-status ofs-delta atomic object-format="+format+"\n"), flushPkt)
			if !bytes.Equal(b.Bytes(), want) {
				t.Fatalf("forwarded %q; want %q", b.Bytes(), want)
			}
		})
	}
}

func TestAdvertisementForwardIsRowForRow(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	wire := join(adFirst(in.Base, "refs/heads/main", "report-status side-band-64k push-options"), adRow(in.Base, "refs/heads/other"), flushPkt)
	ad, err := readAdvertisement(bytes.NewReader(wire), in)
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err = ad.writeTo(&b); err != nil {
		t.Fatal(err)
	}
	want := join(pkt(in.Base+" refs/heads/main\x00report-status\n"), adRow(in.Base, "refs/heads/other"), flushPkt)
	if !bytes.Equal(b.Bytes(), want) {
		t.Fatalf("%q", b.Bytes())
	}
}

func TestAdvertisementWriteFailureIsReported(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	ad, err := readAdvertisement(bytes.NewReader(advertised(in, in.Old)), in)
	if err != nil {
		t.Fatal(err)
	}
	if err = ad.writeTo(&failingWriter{}); !errors.Is(err, errInjected) {
		t.Fatal(err)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errInjected }

func updateAd(t *testing.T, in egress.Intent) *advertisement {
	t.Helper()
	ad, err := readAdvertisement(bytes.NewReader(advertised(in, in.Old)), in)
	if err != nil {
		t.Fatal(err)
	}
	return ad
}

func command(in egress.Intent, caps string) []byte {
	return pkt(in.Old + " " + in.Head + " " + in.Ref + "\x00" + caps + "\n")
}

func TestReadUpdateRefusesWithSpecificReason(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	other := strings.Repeat("e", 40)
	cases := []struct {
		name string
		wire []byte
		want error
	}{
		{"no capabilities", pkt(in.Old + " " + in.Head + " " + in.Ref + "\n"), ErrProtocol},
		{"two NUL sections", pkt(in.Old + " " + in.Head + " " + in.Ref + "\x00report-status\x00x\n"), ErrProtocol},
		{"different predecessor", pkt(other + " " + in.Head + " " + in.Ref + "\x00report-status\n"), ErrScope},
		{"different head", pkt(in.Old + " " + other + " " + in.Ref + "\x00report-status\n"), ErrScope},
		{"different ref", pkt(in.Old + " " + in.Head + " refs/heads/feature/other\x00report-status\n"), ErrScope},
		{"delete command", pkt(in.Old + " " + strings.Repeat("0", 40) + " " + in.Ref + "\x00report-status\n"), ErrScope},
		{"shallow line", pkt("shallow " + in.Base + "\n"), ErrProtocol},
		{"push certificate", pkt("push-cert\x00report-status\n"), ErrProtocol},
		{"garbage before capabilities", pkt("garbage\x00report-status\n"), ErrProtocol},
		{"report-status absent", command(in, "ofs-delta"), ErrProtocol},
		{"duplicate capability", command(in, "report-status report-status"), ErrProtocol},
		{"empty capability token", command(in, "report-status  ofs-delta"), ErrProtocol},
		{"trailing space", command(in, "report-status "), ErrProtocol},
		{"second leading space", command(in, "  report-status"), ErrProtocol},
		{"side-band-64k", command(in, "report-status side-band-64k"), ErrProtocol},
		{"side-band", command(in, "report-status side-band"), ErrProtocol},
		{"report-status-v2", command(in, "report-status report-status-v2"), ErrProtocol},
		{"delete-refs", command(in, "report-status delete-refs"), ErrProtocol},
		{"push-options", command(in, "report-status push-options"), ErrProtocol},
		{"quiet", command(in, "report-status quiet"), ErrProtocol},
		{"agent", command(in, "report-status agent=evil"), ErrProtocol},
		{"signed push", command(in, "report-status push-cert=abc"), ErrProtocol},
		{"wrong object-format", command(in, "report-status object-format=sha256"), ErrProtocol},
		{"empty stream", nil, io.EOF},
		{"command without terminator", command(in, "report-status"), io.EOF},
		{"second command", join(command(in, "report-status"), pkt(in.Old+" "+in.Head+" refs/heads/main\n"), flushPkt), ErrScope},
		{"malformed second packet", join(command(in, "report-status"), adRow(in.Old, "refs/heads/main"), flushPkt), ErrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, noUpdate, err := readUpdate(bytes.NewReader(tc.wire), in, updateAd(t, in))
			if noUpdate {
				t.Fatal("treated as no-op")
			}
			wantIs(t, err, tc.want)
		})
	}
}

func TestReadUpdateRefusesCapabilityTheAdvertisementDidNotOffer(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	bare, err := readAdvertisement(bytes.NewReader(join(adFirst(strings.Repeat("0", 40), "capabilities^{}", "report-status"), flushPkt)), in)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"ofs-delta", "atomic"} {
		_, _, err = readUpdate(bytes.NewReader(join(command(in, "report-status "+c), flushPkt)), in, bare)
		wantIs(t, err, ErrProtocol)
	}
}

func TestReadUpdateRefusesTheSamePredecessorAndHead(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	in.Old = in.Head
	ad := updateAd(t, in)
	_, noUpdate, err := readUpdate(bytes.NewReader(join(command(in, "report-status"), flushPkt)), in, ad)
	if noUpdate {
		t.Fatal("no-op")
	}
	wantIs(t, err, ErrScope)
}

func TestReadUpdateSHA256NeedsClientObjectFormat(t *testing.T) {
	in, _, _ := packFixture(t, "sha256")
	ad := updateAd(t, in)
	_, _, err := readUpdate(bytes.NewReader(join(command(in, "report-status ofs-delta"), flushPkt)), in, ad)
	wantIs(t, err, ErrProtocol)
	if _, _, err = readUpdate(bytes.NewReader(join(command(in, "report-status object-format=sha256"), flushPkt)), in, ad); err != nil {
		t.Fatal(err)
	}
}

// The upstream command is rebuilt from the validated intent. Whatever spelling,
// order or optional feature the untrusted client used cannot reach the remote.
func TestReadUpdateReEncodesOneFixedUpstreamCommand(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		in, _, _ := packFixture(t, format)
		ad := updateAd(t, in)
		want := join(pkt(in.Old+" "+in.Head+" "+in.Ref+"\x00report-status atomic object-format="+format+"\n"), flushPkt)
		for _, caps := range []string{
			"report-status object-format=" + format,
			" report-status object-format=" + format, // native send-pack spelling
			"object-format=" + format + " atomic ofs-delta report-status",
			"atomic report-status object-format=" + format,
		} {
			got, noUpdate, err := readUpdate(bytes.NewReader(join(command(in, caps), flushPkt)), in, ad)
			if err != nil || noUpdate {
				t.Fatal(caps, noUpdate, err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("%s upstream %q; want %q", format, got, want)
			}
		}
	}
}

func TestReadUpdateFlushIsAnExplicitNoUpdate(t *testing.T) {
	in, _, _ := packFixture(t, "sha1")
	got, noUpdate, err := readUpdate(bytes.NewReader(flushPkt), in, updateAd(t, in))
	if err != nil || !noUpdate || got != nil {
		t.Fatal(got, noUpdate, err)
	}
}

func statusWire(unpack, status string) []byte {
	return join(pkt(unpack), pkt(status), flushPkt)
}

func TestReadStatusRefusesWithSpecificReason(t *testing.T) {
	ref := "refs/heads/feature/owner"
	big := strings.Repeat("x", 2049)
	cases := []struct {
		name string
		wire []byte
		want error
	}{
		{"flush instead of unpack", flushPkt, ErrProtocol},
		{"oversize unpack line", statusWire("unpack "+big+"\n", "ok "+ref+"\n"), ErrProtocol},
		{"unpack prefix only", statusWire("unpack \n", "ok "+ref+"\n"), ErrProtocol},
		{"unpack prefix only with a rejection", statusWire("unpack \n", "ng "+ref+" x\n"), ErrProtocol},
		{"unpack prefix only without newline", statusWire("unpack ", "ng "+ref+" x\n"), ErrProtocol},
		{"unpack word missing", statusWire("done ok\n", "ok "+ref+"\n"), ErrProtocol},
		{"remote refuses with ERR instead of a report", pkt("ERR temporary failure\n"), ErrRemote},
		{"unpack truncated", pkt("unpack ok\n"), io.EOF},
		{"flush instead of status", join(pkt("unpack ok\n"), flushPkt), ErrProtocol},
		{"oversize status line", statusWire("unpack ok\n", "ng "+ref+" "+big+"\n"), ErrProtocol},
		{"status for another ref", statusWire("unpack ok\n", "ok refs/heads/main\n"), ErrProtocol},
		{"rejection for another ref", statusWire("unpack ok\n", "ng refs/heads/main reason\n"), ErrProtocol},
		{"rejection without a reason separator", statusWire("unpack ok\n", "ng "+ref+"\n"), ErrProtocol},
		{"rejection with an empty reason", statusWire("unpack ok\n", "ng "+ref+" \n"), ErrProtocol},
		{"rejection with the reserved reason ok", statusWire("unpack ok\n", "ng "+ref+" ok\n"), ErrProtocol},
		{"unknown status verb", statusWire("unpack ok\n", "maybe "+ref+"\n"), ErrProtocol},
		{"success trailing text", statusWire("unpack ok\n", "ok "+ref+" extra\n"), ErrProtocol},
		{"success with failed unpack", statusWire("unpack index-pack abnormal exit\n", "ok "+ref+"\n"), ErrProtocol},
		{"second ref status", join(pkt("unpack ok\n"), pkt("ok "+ref+"\n"), pkt("ok refs/heads/main\n"), flushPkt), ErrProtocol},
		{"missing final flush", join(pkt("unpack ok\n"), pkt("ok "+ref+"\n")), io.EOF},
		{"sideband style data", join(pkt("\x01unpack ok\n"), pkt("ok "+ref+"\n"), flushPkt), ErrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			accepted, reply, err := readStatus(bytes.NewReader(tc.wire), ref)
			if accepted || reply != nil {
				t.Fatalf("produced a verdict: %v %q", accepted, reply)
			}
			wantIs(t, err, tc.want)
		})
	}
}

// The 2048 byte bound on each remote status line is inclusive, and it applies
// even when the line would otherwise be summarized as a rejection.
func TestReadStatusLineLengthBoundaries(t *testing.T) {
	ref := "refs/heads/feature/owner"
	pad := func(prefix string, total int) string {
		return prefix + strings.Repeat("x", total-len(prefix)-1) + "\n"
	}
	for _, tc := range []struct {
		name   string
		unpack string
		status string
		ok     bool
	}{
		{"unpack at the bound", pad("unpack ", 2048), "ng " + ref + " r\n", true},
		{"unpack over the bound", pad("unpack ", 2049), "ng " + ref + " r\n", false},
		{"status at the bound", "unpack ok\n", pad("ng "+ref+" ", 2048), true},
		{"status over the bound", "unpack ok\n", pad("ng "+ref+" ", 2049), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			accepted, _, err := readStatus(bytes.NewReader(statusWire(tc.unpack, tc.status)), ref)
			if tc.ok && (err != nil || accepted) {
				t.Fatal(accepted, err)
			}
			if !tc.ok {
				wantIs(t, err, ErrProtocol)
			}
		})
	}
}

// Remote prose is untrusted. The reply handed back to the client is a closed
// phrase and must never echo what the remote wrote.
func TestReadStatusRepliesWithClosedVocabulary(t *testing.T) {
	ref := "refs/heads/feature/owner"
	for _, tc := range []struct {
		name     string
		wire     []byte
		accepted bool
		want     []byte
	}{
		{"accepted", statusWire("unpack ok\n", "ok "+ref+"\n"), true,
			join(pkt("unpack ok\n"), pkt("ok "+ref+"\n"), flushPkt)},
		{"rejected by hook", statusWire("unpack ok\n", "ng "+ref+" pre-receive hook declined token=SECRET\x1b[31m\n"), false,
			join(pkt("unpack ok\n"), pkt("ng "+ref+" remote rejection\n"), flushPkt)},
		{"rejected unpack", statusWire("unpack index-pack failed token=SECRET\n", "ng "+ref+" unpacker error\n"), false,
			join(pkt("unpack remote rejection\n"), pkt("ng "+ref+" remote rejection\n"), flushPkt)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			accepted, reply, err := readStatus(bytes.NewReader(tc.wire), ref)
			if err != nil {
				t.Fatal(err)
			}
			if accepted != tc.accepted || !bytes.Equal(reply, tc.want) {
				t.Fatalf("%v %q; want %v %q", accepted, reply, tc.accepted, tc.want)
			}
			if bytes.Contains(reply, []byte("SECRET")) || bytes.Contains(reply, []byte("\x1b")) {
				t.Fatal("remote text leaked")
			}
		})
	}
}

func TestPacketLengthRefusalsAreClassified(t *testing.T) {
	for _, bad := range []string{"0001", "0002", "0003", "fff1", "ffff", "zzzz", "00g0", "-001", "0x10"} {
		t.Run(bad, func(t *testing.T) {
			_, _, err := readPacket(strings.NewReader(bad))
			wantIs(t, err, ErrProtocol)
		})
	}
	for _, short := range []string{"0008abc", "000a"} {
		t.Run(short, func(t *testing.T) {
			_, _, err := readPacket(strings.NewReader(short))
			if !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
				t.Fatal(err)
			}
		})
	}
	// Hexadecimal lengths are accepted in either case, across the full digit set.
	for header, size := range map[string]int{"000A": 6, "000a": 6, "000F": 11, "000f": 11, "0009": 5, "0010": 12, "00Af": 171} {
		payload := bytes.Repeat([]byte{'p'}, size)
		b, flush, err := readPacket(bytes.NewReader(append([]byte(header), payload...)))
		if err != nil || flush || !bytes.Equal(b, payload) {
			t.Errorf("%s: %q %v %v", header, b, flush, err)
		}
	}
	if b, flush, err := readPacket(strings.NewReader("0004")); err != nil || flush || len(b) != 0 {
		t.Fatal("empty data packet", b, flush, err)
	}
	if _, err := packet(make([]byte, maxPacket-4+1)); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
}

type lyingWriter struct{ n int }

func (w lyingWriter) Write([]byte) (int, error) { return w.n, nil }

func TestWriteAllRefusesALyingWriter(t *testing.T) {
	for _, n := range []int{-1, 4} {
		if _, err := writeAll(lyingWriter{n}, []byte("abc")); !errors.Is(err, io.ErrShortWrite) {
			t.Fatal(n, err)
		}
	}
	// A write that makes progress and also reports an error stops immediately.
	w := &progressThenError{}
	total, err := writeAll(w, []byte("abcdef"))
	if !errors.Is(err, errInjected) || total != 2 || w.calls != 1 {
		t.Fatal(total, err, w.calls)
	}
}

type progressThenError struct{ calls int }

func (w *progressThenError) Write(b []byte) (int, error) {
	w.calls++
	return 2, errInjected
}

func TestClassifiedFailureCodes(t *testing.T) {
	if classified(nil) != nil {
		t.Fatal("nil became an error")
	}
	for _, tc := range []struct {
		err  error
		code string
	}{
		{ErrProtocol, "GIT_TRANSPORT_PROTOCOL"},
		{ErrLimit, "GIT_TRANSPORT_LIMIT"},
		{ErrSource, "GIT_TRANSPORT_SOURCE_MISMATCH"},
		{ErrRemote, "GIT_TRANSPORT_REMOTE_CHANGED"},
		{ErrScope, "GIT_TRANSPORT_SCOPE_REFUSED"},
		{ErrReplay, "GIT_TRANSPORT_ALREADY_CONSUMED"},
		{ErrPort, "GIT_TRANSPORT_PORT_FAILURE"},
		{errInjected, "GIT_TRANSPORT_PORT_FAILURE"},
		{io.ErrUnexpectedEOF, "GIT_TRANSPORT_PORT_FAILURE"},
		// A context error claims cancellation only when the run's context ended.
		{context.DeadlineExceeded, "GIT_TRANSPORT_PORT_FAILURE"},
		{context.Canceled, "GIT_TRANSPORT_PORT_FAILURE"},
		{contextEnded{context.DeadlineExceeded}, "GIT_TRANSPORT_DEADLINE"},
		{contextEnded{context.Canceled}, "GIT_TRANSPORT_CANCELLED"},
		{errors.Join(ErrScope, contextEnded{context.Canceled}), "GIT_TRANSPORT_CANCELLED"},
		{errors.Join(contextEnded{context.DeadlineExceeded}, ownerFailure{ErrLimit}), "GIT_TRANSPORT_DEADLINE"},
		// Custody: ErrScope is a refusal; anything else is the owner's fault.
		{custodyFailure(ErrScope), "GIT_TRANSPORT_SCOPE_REFUSED"},
		{custodyFailure(errors.Join(ErrRemote, errInjected)), "GIT_TRANSPORT_PORT_FAILURE"},
		{custodyFailure(context.Canceled), "GIT_TRANSPORT_PORT_FAILURE"},
		// A stream error that wraps a sentinel is still the stream's fault.
		{ownerFailure{errors.Join(errInjected, ErrScope)}, "GIT_TRANSPORT_PORT_FAILURE"},
	} {
		got := classified(tc.err)
		var f *Failure
		if !errors.As(got, &f) || f.Code() != tc.code || got.Error() != tc.code {
			t.Fatalf("%v -> %v; want %s", tc.err, got, tc.code)
		}
		if !errors.Is(got, tc.err) {
			t.Fatalf("cause of %v lost", tc.err)
		}
	}
}

// Readback is a new observation. It never rewrites what the original attempt
// recorded and never attributes a current remote value to that attempt.
func TestReconcileKeepsOriginalOutcomeAndRefusesUnboundResults(t *testing.T) {
	g, _, _, _, in, _ := gateFixture(t)
	digest := IntentDigest(g.plan)
	for _, outcome := range []RefOutcome{NotAttempted, Unknown, Accepted, Rejected, NoUpdate} {
		r := Result{OperationID: in.Binding.OperationID, IntentDigest: digest, RefOutcome: outcome}
		for _, tc := range []struct {
			oid   string
			state ReadbackState
		}{
			{"", Unobserved},
			{in.Head, TargetObserved},
			{in.Base, OtherObserved},
			{strings.Repeat("0", 40), OtherObserved},
		} {
			got, err := Reconcile(g.plan, r, tc.oid)
			if err != nil || got.State != tc.state || got.Original != outcome || got.CurrentOID != tc.oid {
				t.Fatal(outcome, tc.oid, got, err)
			}
		}
	}
	good := Result{OperationID: in.Binding.OperationID, IntentDigest: digest, RefOutcome: Unknown}
	for _, tc := range []struct {
		name   string
		result Result
		oid    string
		want   error
	}{
		{"empty result", Result{}, "", ErrScope},
		{"empty digest", Result{OperationID: in.Binding.OperationID}, "", ErrScope},
		{"other digest", Result{OperationID: in.Binding.OperationID, IntentDigest: strings.Repeat("a", 64)}, "", ErrScope},
		{"empty operation", Result{IntentDigest: digest}, "", ErrScope},
		{"other operation", Result{OperationID: "other", IntentDigest: digest}, in.Head, ErrScope},
		{"short observed id", good, in.Head[:39], ErrProtocol},
		{"uppercase observed id", good, strings.ToUpper(in.Head), ErrProtocol},
		{"sha256 sized observed id", good, strings.Repeat("a", 64), ErrProtocol},
		{"non hex observed id", good, strings.Repeat("g", 40), ErrProtocol},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Reconcile(g.plan, tc.result, tc.oid)
			wantIs(t, err, tc.want)
			if got != (Readback{}) {
				t.Fatal("partial readback returned", got)
			}
		})
	}
}

// A SHA-256 plan meeting a genuine SHA-1 advertisement (40-digit OIDs) is a
// changed remote, established from the capabilities before any OID is parsed.
func TestSHA1RemoteForASHA256PlanIsRemoteChanged(t *testing.T) {
	in, _, _ := packFixture(t, "sha256")
	sha1Row := adFirst(strings.Repeat("1", 40), "refs/heads/main", "report-status object-format=sha1")
	_, err := readAdvertisement(bytes.NewReader(join(sha1Row, flushPkt)), in)
	wantIs(t, err, ErrRemote)
}
