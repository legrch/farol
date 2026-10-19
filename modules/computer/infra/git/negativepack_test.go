package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"

	egressport "github.com/legrch/farol/modules/computer/app/port/egress"
	"github.com/legrch/farol/modules/computer/domain/egress"
)

// packBytes assembles a pack WITHOUT a trailer so truncation can be expressed.
func packBytes(version, count uint32, entries ...[]byte) []byte {
	b := &bytes.Buffer{}
	b.WriteString("PACK")
	_ = binary.Write(b, binary.BigEndian, version)
	_ = binary.Write(b, binary.BigEndian, count)
	for _, e := range entries {
		b.Write(e)
	}
	return b.Bytes()
}

func TestReadPackRefusesMalformedStreamsWithSpecificReason(t *testing.T) {
	abc := []byte("abc")
	cases := []struct {
		name   string
		mutate func(*egress.Intent)
		wire   func(t *testing.T) []byte
		want   error
	}{
		{"empty stream", nil, func(*testing.T) []byte { return nil }, io.EOF},
		{"short header", nil, func(*testing.T) []byte { return []byte("PACK\x00\x00\x00") }, io.ErrUnexpectedEOF},
		{"wrong magic", nil, func(*testing.T) []byte { b := rawPack("sha1", 2, 0); b[0] = 'X'; return b }, ErrProtocol},
		{"version 1", nil, func(*testing.T) []byte { return rawPack("sha1", 1, 0) }, ErrProtocol},
		{"version 4", nil, func(*testing.T) []byte { return rawPack("sha1", 4, 0) }, ErrProtocol},
		{"object count over limit", nil, func(*testing.T) []byte { return packBytes(2, 16385) }, ErrLimit},
		{"reserved object type 0", nil, func(t *testing.T) []byte { return rawPack("sha1", 2, 1, entry(t, 0, 3, nil, abc)) }, ErrProtocol},
		{"tag object type", nil, func(t *testing.T) []byte { return rawPack("sha1", 2, 1, entry(t, 4, 3, nil, abc)) }, ErrProtocol},
		{"reserved object type 5", nil, func(t *testing.T) []byte { return rawPack("sha1", 2, 1, entry(t, 5, 3, nil, abc)) }, ErrProtocol},
		{"declared size over per-object limit", func(i *egress.Intent) { i.Limits.ObjectBytes = 1000 },
			func(t *testing.T) []byte { return rawPack("sha1", 2, 1, entry(t, 3, 2000, nil, make([]byte, 2000))) }, ErrLimit},
		{"size varint never terminates", nil, func(*testing.T) []byte {
			return packBytes(2, 1, append([]byte{0xb0}, bytes.Repeat([]byte{0x80}, 9)...))
		}, ErrLimit},
		{"size varint overflows 64 bits", nil, func(*testing.T) []byte {
			return packBytes(2, 1, append(append([]byte{0xb0}, bytes.Repeat([]byte{0x80}, 8)...), 0x10))
		}, ErrLimit},
		{"size varint truncated", nil, func(*testing.T) []byte { return packBytes(2, 1, []byte{0xb0}) }, io.EOF},
		{"ofs-delta without distance", nil, func(*testing.T) []byte { return packBytes(2, 1, entryHeader(6, 3)) }, io.EOF},
		{"declared object is missing", nil, func(*testing.T) []byte { return packBytes(2, 1) }, io.EOF},
		{"ofs-delta distance truncated", nil, func(*testing.T) []byte { return packBytes(2, 1, entryHeader(6, 3), []byte{0x80}) }, io.EOF},
		{"ofs-delta distance zero", nil, func(t *testing.T) []byte {
			return packBytes(2, 2, entry(t, 3, 3, nil, abc), entry(t, 6, 3, []byte{0}, abc))
		}, ErrProtocol},
		{"ofs-delta before the first object", nil, func(t *testing.T) []byte {
			return packBytes(2, 1, entry(t, 6, 3, []byte{1}, abc))
		}, ErrProtocol},
		{"ofs-delta into the middle of an object", nil, func(t *testing.T) []byte {
			first := entry(t, 3, 3, nil, abc)
			return packBytes(2, 2, first, entry(t, 6, 3, ofsDistance(len(first)-1), abc))
		}, ErrProtocol},
		{"ofs-delta distance overflows", nil, func(t *testing.T) []byte {
			return packBytes(2, 2, entry(t, 3, 3, nil, abc), entry(t, 6, 3, bytes.Repeat([]byte{0xff}, 12), abc))
		}, ErrLimit},
		{"ref-delta base id truncated", nil, func(*testing.T) []byte {
			return packBytes(2, 1, entryHeader(7, 3), bytes.Repeat([]byte{1}, 10))
		}, io.ErrUnexpectedEOF},
		{"bad zlib header", nil, func(*testing.T) []byte {
			return packBytes(2, 1, entryHeader(3, 3), []byte("XXXXXXXX"))
		}, ErrProtocol},
		{"corrupt deflate body", nil, func(*testing.T) []byte {
			// Valid zlib header, then a final deflate block of reserved type 3.
			return packBytes(2, 1, entryHeader(3, 3), []byte{0x78, 0x9c, 0x07, 0, 0, 0})
		}, ErrProtocol},
		{"stream shorter than declared", nil, func(t *testing.T) []byte { return rawPack("sha1", 2, 1, entry(t, 3, 10, nil, abc)) }, io.ErrUnexpectedEOF},
		{"stream longer than declared", nil, func(t *testing.T) []byte { return rawPack("sha1", 2, 1, entry(t, 3, 3, nil, []byte("abcdef"))) }, ErrProtocol},
		{"corrupt deflate checksum", nil, func(t *testing.T) []byte {
			e := entry(t, 3, 3, nil, abc)
			e[len(e)-1] ^= 1
			return rawPack("sha1", 2, 1, e)
		}, ErrProtocol},
		{"trailer absent", nil, func(t *testing.T) []byte { return packBytes(2, 1, entry(t, 3, 3, nil, abc)) }, io.EOF},
		{"trailer truncated", nil, func(t *testing.T) []byte {
			return append(packBytes(2, 1, entry(t, 3, 3, nil, abc)), 1, 2, 3, 4, 5)
		}, io.ErrUnexpectedEOF},
		{"trailer of the wrong algorithm", nil, func(t *testing.T) []byte {
			return rawPack("sha256", 2, 1, entry(t, 3, 3, nil, abc))
		}, ErrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in, known, _ := packFixture(t, "sha1")
			if tc.mutate != nil {
				tc.mutate(&in)
			}
			_, err := readWire(t, in, known, tc.wire(t))
			wantIs(t, err, tc.want)
		})
	}
}

func TestReadPackSHA256TrailerMismatches(t *testing.T) {
	in, known, objects := packFixture(t, "sha256")
	wire := makePack(t, "sha256", objects)
	flipped := bytes.Clone(wire)
	flipped[len(flipped)-1] ^= 1
	_, err := readWire(t, in, known, flipped)
	wantIs(t, err, ErrProtocol)
	// A SHA-1 trailer is too short to be read as a SHA-256 trailer.
	sha1Trailer := rawPack("sha1", 2, 0)
	_, err = readWire(t, in, known, sha1Trailer)
	wantIs(t, err, io.ErrUnexpectedEOF)
}

func TestReadPackObjectCountLimitIsInclusive(t *testing.T) {
	in, known, _ := packFixture(t, "sha1")
	in.Limits.Objects = 6
	_, err := readWire(t, in, known, packBytes(2, 7))
	wantIs(t, err, ErrLimit)
	_, err = readWire(t, in, known, packBytes(2, 6))
	if errors.Is(err, ErrLimit) {
		t.Fatal("the exact count limit was refused:", err)
	}
}

func TestReadPackByteLimitIsInclusive(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	wire := makePack(t, in.Format, objects)
	in.Limits.PackBytes = int64(len(wire))
	if _, err := readWire(t, in, known, wire); err != nil {
		t.Fatal("exact pack limit refused:", err)
	}
	in.Limits.PackBytes = int64(len(wire)) - 1
	_, err := readWire(t, in, known, wire)
	wantIs(t, err, ErrLimit)
}

func TestReadPackManifestMismatchesAreSourceMismatches(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(in *egress.Intent, objects []*object)
	}{
		{"strong digest", func(in *egress.Intent, _ []*object) { in.Objects[0].Digest = strings.Repeat("f", 64) }},
		{"size", func(in *egress.Intent, objects []*object) { in.Objects[2].Size++ }},
		{"kind", func(in *egress.Intent, objects []*object) { in.Objects[2].Kind = "tree" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in, known, objects := packFixture(t, "sha1")
			tc.mutate(&in, objects)
			_, err := readWire(t, in, known, makePack(t, in.Format, objects))
			wantIs(t, err, ErrSource)
		})
	}
	t.Run("unapproved extra object", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		wire := makePack(t, in.Format, append(objects, &object{kind: "blob", data: []byte("not in the manifest")}))
		_, err := readWire(t, in, known, wire)
		wantIs(t, err, ErrSource)
	})
	t.Run("same object twice", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		_, err := readWire(t, in, known, makePack(t, in.Format, append(objects, objects[2])))
		wantIs(t, err, ErrProtocol)
	})
}

// A tiny compressed stream can inflate to a very large object. The declared
// sizes are charged before any allocation, so the total stays bounded.
func TestReadPackChargesExpandedWorkBeforeInflating(t *testing.T) {
	in, known, _ := packFixture(t, "sha1")
	in.Limits.ObjectBytes = 1 << 20
	in.Limits.ExpandedBytes = 2 << 20
	zeros := make([]byte, 1<<20)
	wire := rawPack("sha1", 2, 3, entry(t, 3, 1<<20, nil, zeros), entry(t, 3, 1<<20, nil, zeros), entry(t, 3, 1<<20, nil, zeros))
	if len(wire) > 64<<10 {
		t.Fatal("fixture is not a compression bomb")
	}
	_, err := readWire(t, in, known, wire)
	wantIs(t, err, ErrLimit)
}

// Every unit of accounted work, including delta output and authenticated
// reads of known bases, must fail closed exactly below the total.
func TestExpandedWorkLimitFailsClosedAtEveryBoundary(t *testing.T) {
	for _, build := range []struct {
		name string
		fx   func(t *testing.T) (egress.Intent, memoryObjects, []byte)
	}{
		{"plain", func(t *testing.T) (egress.Intent, memoryObjects, []byte) {
			in, known, objects := packFixture(t, "sha1")
			return in, known, makePack(t, in.Format, objects)
		}},
		{"ofs chain", func(t *testing.T) (egress.Intent, memoryObjects, []byte) {
			in, known, _, wire := chainFixture(t, "sha1", false)
			return in, known, wire
		}},
		{"ref chain", func(t *testing.T) (egress.Intent, memoryObjects, []byte) {
			in, known, _, wire := chainFixture(t, "sha1", true)
			return in, known, wire
		}},
	} {
		t.Run(build.name, func(t *testing.T) {
			in, known, wire := build.fx(t)
			var largest int64
			for _, group := range [][]egress.Object{in.Objects, in.Known} {
				for _, o := range group {
					largest = max(largest, o.Size)
				}
			}
			in.Limits.ObjectBytes = largest
			in.Limits.ExpandedBytes = 1 << 20
			p, err := readWire(t, in, known, wire)
			if err != nil {
				t.Fatal(err)
			}
			need := p.source.expanded
			if need <= largest {
				t.Fatalf("fixture does no accountable work: %d", need)
			}
			in.Limits.ExpandedBytes = need
			if _, err = readWire(t, in, known, wire); err != nil {
				t.Fatal("exact budget refused:", err)
			}
			for limit := need - 1; limit >= largest; limit-- {
				in.Limits.ExpandedBytes = limit
				_, err = readWire(t, in, known, wire)
				if !errors.Is(err, ErrLimit) {
					t.Fatalf("budget %d of %d: %v", limit, need, err)
				}
			}
		})
	}
}

type brokenReader struct {
	n   int
	err error
}

func (r brokenReader) Read([]byte) (int, error) { return r.n, r.err }

func TestReadPackRefusesMisbehavingReaders(t *testing.T) {
	in, known, _ := packFixture(t, "sha1")
	plan := mustPlan(t, in)
	for _, tc := range []struct {
		name string
		r    io.Reader
		want error
	}{
		{"reports more than requested", brokenReader{n: 1 << 20}, ErrProtocol},
		{"reports negative progress", brokenReader{n: -1}, ErrProtocol},
		{"makes no progress", brokenReader{}, io.ErrNoProgress},
		{"fails", brokenReader{err: errInjected}, errInjected},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readPack(context.Background(), tc.r, plan, known)
			wantIs(t, err, tc.want)
		})
	}
	t.Run("cancelled before the first byte", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := readPack(ctx, bytes.NewReader(makePackFor(t)), plan, known)
		wantIs(t, err, context.Canceled)
	})
}

func makePackFor(t *testing.T) []byte {
	t.Helper()
	_, _, objects := packFixture(t, "sha1")
	return makePack(t, "sha1", objects)
}

// The reader must not consume a byte beyond the pack's own trailer, and a
// peer that dribbles one byte at a time must not change the verdict.
func TestReadPackConsumesExactlyThePackAndSurvivesShortReads(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	wire := makePack(t, in.Format, objects)
	r := bytes.NewReader(append(bytes.Clone(wire), []byte("TRAILING-UNTRUSTED-BYTES")...))
	p, err := readPack(context.Background(), r, mustPlan(t, in), known)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(p.bytes, wire) || r.Len() != len("TRAILING-UNTRUSTED-BYTES") {
		t.Fatalf("overread: kept %d of %d, %d left", len(p.bytes), len(wire), r.Len())
	}
	p, err = readPack(context.Background(), iotest.OneByteReader(bytes.NewReader(wire)), mustPlan(t, in), known)
	if err != nil || !bytes.Equal(p.bytes, wire) {
		t.Fatal(err)
	}
}

// chainFixture introduces b0 <- b1 <- b2 as a delta chain of depth two, either
// as OFS_DELTA in base-first order, or as REF_DELTA in reverse order so each
// resolution pass can resolve only one more link.
func chainFixture(t *testing.T, format string, reverse bool) (egress.Intent, memoryObjects, []*object, []byte) {
	t.Helper()
	in, known, _ := packFixture(t, format)
	b0 := &object{kind: "blob", data: []byte("chain base\n")}
	b1 := &object{kind: "blob", data: []byte("chain base\n1")}
	b2 := &object{kind: "blob", data: []byte("chain base\n12")}
	treeData := []byte{}
	for i, b := range []*object{b0, b1, b2} {
		id, _ := hex.DecodeString(objID(format, b))
		treeData = append(treeData, []byte("100644 f"+string(rune('a'+i))+"\x00")...)
		treeData = append(treeData, id...)
	}
	tr := &object{kind: "tree", data: treeData}
	head := commit(format, objID(format, tr), in.Base)
	objects := []*object{head, tr, b0, b1, b2}
	in = setObjects(in, format, head, objects)
	baseID := func(v *object) []byte { id, _ := hex.DecodeString(objID(format, v)); return id }
	d1 := literalDelta(b0.data, b1.data)
	d2 := literalDelta(b1.data, b2.data)
	parts := [][]byte{fullEntry(t, head), fullEntry(t, tr)}
	if reverse {
		parts = append(parts,
			entry(t, 7, uint64(len(d2)), baseID(b1), d2),
			entry(t, 7, uint64(len(d1)), baseID(b0), d1),
			fullEntry(t, b0))
	} else {
		e0 := fullEntry(t, b0)
		e1 := entry(t, 6, uint64(len(d1)), ofsDistance(len(e0)), d1)
		e2 := entry(t, 6, uint64(len(d2)), ofsDistance(len(e1)), d2)
		parts = append(parts, e0, e1, e2)
	}
	return in, known, objects, rawPack(format, 2, 5, parts...)
}

func TestDeltaChainDepthIsBoundedInclusively(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		name := "ofs"
		if reverse {
			name = "reverse ref"
		}
		for _, format := range []string{"sha1", "sha256"} {
			t.Run(name+"/"+format, func(t *testing.T) {
				in, known, _, wire := chainFixture(t, format, reverse)
				in.Limits.DeltaDepth = 2
				p, err := readWire(t, in, known, wire)
				if err != nil {
					t.Fatal("depth equal to the limit refused:", err)
				}
				if len(p.objects) != 5 {
					t.Fatal(len(p.objects))
				}
				in.Limits.DeltaDepth = 1
				_, err = readWire(t, in, known, wire)
				wantIs(t, err, ErrLimit)
			})
		}
	}
}

// OFS_DELTA reaches back to the very first object of the pack when the base was
// written first; that exact distance is valid.
func TestOfsDeltaMayUseTheFirstObjectAsBase(t *testing.T) {
	in, known, _, _ := chainFixture(t, "sha1", false)
	b0 := &object{kind: "blob", data: []byte("chain base\n")}
	b1 := &object{kind: "blob", data: []byte("chain base\n1")}
	b2 := &object{kind: "blob", data: []byte("chain base\n12")}
	d1 := literalDelta(b0.data, b1.data)
	d2 := literalDelta(b1.data, b2.data)
	e0 := fullEntry(t, b0)
	e1 := entry(t, 6, uint64(len(d1)), ofsDistance(len(e0)), d1)
	e2 := entry(t, 6, uint64(len(d2)), ofsDistance(len(e1)), d2)
	// Rebuild head and tree around the same three blobs, written after them.
	var treeData []byte
	for i, b := range []*object{b0, b1, b2} {
		id, _ := hex.DecodeString(objID("sha1", b))
		treeData = append(append(treeData, []byte("100644 f"+string(rune('a'+i))+"\x00")...), id...)
	}
	tr := &object{kind: "tree", data: treeData}
	head := commit("sha1", objID("sha1", tr), in.Base)
	in = setObjects(in, "sha1", head, []*object{head, tr, b0, b1, b2})
	in.Limits.DeltaDepth = 2
	wire := rawPack("sha1", 2, 5, e0, e1, e2, fullEntry(t, head), fullEntry(t, tr))
	if p, err := readWire(t, in, known, wire); err != nil || len(p.objects) != 5 {
		t.Fatal(err)
	}
}

func TestThinDeltaPropagatesAnOwnerReadFailure(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	base := known[in.Known[2].OID]
	d := literalDelta(base.data, objects[2].data)
	id, _ := hex.DecodeString(in.Known[2].OID)
	wire := rawPack("sha1", 2, 3, fullEntry(t, objects[0]), fullEntry(t, objects[1]), entry(t, 7, uint64(len(d)), id, d))
	reader := objectsFunc(func(_ context.Context, got string) (string, []byte, error) {
		if got == in.Known[2].OID {
			return "", nil, errInjected
		}
		return known.ReadObject(context.Background(), got)
	})
	_, err := readPack(context.Background(), bytes.NewReader(wire), mustPlan(t, in), reader)
	wantIs(t, err, errInjected)
	// An EOF from the owner's reader is a port fault, not a truncated client pack.
	eofReader := objectsFunc(func(_ context.Context, got string) (string, []byte, error) {
		if got == in.Known[2].OID {
			return "", nil, io.EOF
		}
		return known.ReadObject(context.Background(), got)
	})
	_, err = readPack(context.Background(), bytes.NewReader(wire), mustPlan(t, in), eofReader)
	wantIs(t, err, io.EOF)
	wantCode(t, classified(err), ErrPort)
	// A reader that returns a sentinel, or no reader at all, is still the owner's fault.
	sentinelReader := objectsFunc(func(_ context.Context, got string) (string, []byte, error) {
		if got == in.Known[2].OID {
			return "", nil, ErrSource
		}
		return known.ReadObject(context.Background(), got)
	})
	_, err = readPack(context.Background(), bytes.NewReader(wire), mustPlan(t, in), sentinelReader)
	wantCode(t, classified(err), ErrPort)
	_, err = readPack(context.Background(), bytes.NewReader(wire), mustPlan(t, in), nil)
	wantCode(t, classified(err), ErrPort)
}

func TestDeltaWithUnavailableOrDivergentBaseIsRefused(t *testing.T) {
	t.Run("base nowhere to be found", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		bogus := bytes.Repeat([]byte{0xab}, 20)
		d := literalDelta([]byte("x"), objects[2].data)
		wire := rawPack("sha1", 2, 3, fullEntry(t, objects[0]), fullEntry(t, objects[1]), entry(t, 7, uint64(len(d)), bogus, d))
		_, err := readWire(t, in, known, wire)
		wantIs(t, err, ErrSource)
	})
	t.Run("delta source size disagrees with the base", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		base := known[in.Known[2].OID]
		d := literalDelta(append(bytes.Clone(base.data), 'x'), objects[2].data)
		id, _ := hex.DecodeString(in.Known[2].OID)
		wire := rawPack("sha1", 2, 3, fullEntry(t, objects[0]), fullEntry(t, objects[1]), entry(t, 7, uint64(len(d)), id, d))
		_, err := readWire(t, in, known, wire)
		wantIs(t, err, ErrSource)
	})
	t.Run("delta result is not an approved object", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		base := known[in.Known[2].OID]
		d := literalDelta(base.data, []byte("unapproved result\n"))
		id, _ := hex.DecodeString(in.Known[2].OID)
		wire := rawPack("sha1", 2, 3, fullEntry(t, objects[0]), fullEntry(t, objects[1]), entry(t, 7, uint64(len(d)), id, d))
		_, err := readWire(t, in, known, wire)
		wantIs(t, err, ErrSource)
	})
	t.Run("malformed delta instructions", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		base := known[in.Known[2].OID]
		id, _ := hex.DecodeString(in.Known[2].OID)
		d := []byte{byte(len(base.data)), 5, 0} // opcode 0 is reserved
		wire := rawPack("sha1", 2, 3, fullEntry(t, objects[0]), fullEntry(t, objects[1]), entry(t, 7, uint64(len(d)), id, d))
		_, err := readWire(t, in, known, wire)
		wantIs(t, err, ErrProtocol)
	})
}

// A thin pack base is only trusted after the owner's read matches the manifest.
func TestKnownBaseReadsAreAuthenticated(t *testing.T) {
	baseID := func(in egress.Intent) string { return in.Base }
	cases := []struct {
		name string
		edit func(in *egress.Intent, v *object) (string, []byte, error)
		want error
	}{
		{"other kind", func(_ *egress.Intent, v *object) (string, []byte, error) { return "blob", v.data, nil }, ErrSource},
		{"truncated bytes", func(_ *egress.Intent, v *object) (string, []byte, error) {
			return v.kind, v.data[:len(v.data)-1], nil
		}, ErrSource},
		{"same size different bytes", func(_ *egress.Intent, v *object) (string, []byte, error) {
			d := bytes.Clone(v.data)
			d[len(d)-2] ^= 1
			return v.kind, d, nil
		}, ErrSource},
		{"owner failure", func(*egress.Intent, *object) (string, []byte, error) { return "", nil, errInjected }, errInjected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in, known, objects := packFixture(t, "sha1")
			orig := known[baseID(in)]
			reader := objectsFunc(func(_ context.Context, id string) (string, []byte, error) {
				if id == baseID(in) {
					return tc.edit(&in, orig)
				}
				return known.ReadObject(context.Background(), id)
			})
			plan := mustPlan(t, in)
			_, err := readPack(context.Background(), bytes.NewReader(makePack(t, in.Format, objects)), plan, reader)
			wantIs(t, err, tc.want)
		})
	}
	t.Run("manifest strong digest differs", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		for i := range in.Known {
			if in.Known[i].OID == in.Base {
				in.Known[i].Digest = strings.Repeat("e", 64)
			}
		}
		_, err := readWire(t, in, known, makePack(t, in.Format, objects))
		wantIs(t, err, ErrSource)
	})
	t.Run("no reader supplied", func(t *testing.T) {
		in, _, objects := packFixture(t, "sha1")
		_, err := readWire(t, in, nil, makePack(t, in.Format, objects))
		wantIs(t, err, ErrSource)
	})
	t.Run("owner read outlives the context", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		ctx, cancel := context.WithCancel(context.Background())
		reader := objectsFunc(func(c context.Context, id string) (string, []byte, error) {
			cancel()
			return known.ReadObject(c, id)
		})
		_, err := readPack(ctx, bytes.NewReader(makePack(t, in.Format, objects)), mustPlan(t, in), reader)
		wantIs(t, err, context.Canceled)
	})
	t.Run("later mutation of owner memory cannot change verified bytes", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		shared := bytes.Clone(known[in.Base].data)
		reader := objectsFunc(func(_ context.Context, id string) (string, []byte, error) {
			if id == in.Base {
				return "commit", shared, nil
			}
			return known.ReadObject(context.Background(), id)
		})
		p, err := readPack(context.Background(), bytes.NewReader(makePack(t, in.Format, objects)), mustPlan(t, in), reader)
		if err != nil {
			t.Fatal(err)
		}
		want := bytes.Clone(shared)
		for i := range shared {
			shared[i] = 'Z'
		}
		if got := p.source.cache[in.Base]; got == nil || !bytes.Equal(got.data, want) {
			t.Fatal("verified bytes alias the owner's memory")
		}
	})
}

type objectsFunc func(context.Context, string) (string, []byte, error)

func (f objectsFunc) ReadObject(ctx context.Context, id string) (string, []byte, error) {
	return f(ctx, id)
}

var _ egressport.Objects = objectsFunc(nil)

func TestCanonicalUploadFailsClosedAtEveryByteBudget(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	p, err := readWire(t, in, known, makePack(t, in.Format, objects))
	if err != nil {
		t.Fatal(err)
	}
	good, n, err := p.canonical()
	if err != nil || n != 3 {
		t.Fatal(n, err)
	}
	total := int64(len(good))
	p.source.in.Limits.PackBytes = total
	if again, _, err := p.canonical(); err != nil || !bytes.Equal(again, good) {
		t.Fatal("the exact budget was refused or changed the bytes:", err)
	}
	for limit := total - 1; limit >= 0; limit-- {
		p.source.in.Limits.PackBytes = limit
		out, count, err := p.canonical()
		if !errors.Is(err, ErrLimit) || out != nil || count != 0 {
			t.Fatalf("budget %d of %d: %d %v", limit, total, count, err)
		}
	}
}

func TestCanonicalUploadStopsWhenContextEnds(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	ctx, cancel := context.WithCancel(context.Background())
	p, err := readPack(ctx, bytes.NewReader(makePack(t, in.Format, objects)), mustPlan(t, in), known)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	out, _, err := p.canonical()
	wantIs(t, err, context.Canceled)
	if out != nil {
		t.Fatal("partial upload returned")
	}
}

func TestCanonicalUploadIsSortedAndOmitsKnownObjects(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	// The client both reorders and gratuitously includes a known object.
	wire := makePack(t, in.Format, []*object{objects[2], known[in.Known[0].OID], objects[0], objects[1]})
	p, err := readWire(t, in, known, wire)
	if err != nil {
		t.Fatal(err)
	}
	out, n, err := p.canonical()
	if err != nil || n != 3 {
		t.Fatal(n, err)
	}
	back, err := readWire(t, in, known, out)
	if err != nil || len(back.objects) != 3 {
		t.Fatal(err)
	}
	if binary.BigEndian.Uint32(out[8:12]) != 3 || binary.BigEndian.Uint32(out[4:8]) != 2 {
		t.Fatal("header")
	}
}

func TestMalformedZlibIsAPublicProtocolFailureWithTheOriginalCause(t *testing.T) {
	in, known, _ := packFixture(t, "sha1")
	_, err := readWire(t, in, known, packBytes(2, 1, entryHeader(3, 3), []byte("XXXXXXXX")))
	if !errors.Is(err, zlib.ErrHeader) {
		t.Fatalf("original zlib cause lost: %v", err)
	}
	wantCode(t, classified(err), ErrProtocol)
	// A complete zlib stream that inflates to fewer bytes than the object
	// header declares is the client's encoding, not a transport failure.
	_, err = readWire(t, in, known, rawPack("sha1", 2, 1, entry(t, 3, 10, nil, []byte("abc"))))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("original truncation cause lost: %v", err)
	}
	wantCode(t, classified(err), ErrProtocol)
	if got := inflateFailure(io.ErrUnexpectedEOF); got != io.ErrUnexpectedEOF {
		t.Fatalf("stream truncation reclassified: %v", got)
	}
	if got := inflateFailure(ErrLimit); got != ErrLimit {
		t.Fatalf("limit reclassified: %v", got)
	}
}
