package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

type memoryObjects map[string]*object

func (m memoryObjects) ReadObject(_ context.Context, id string) (string, []byte, error) {
	v := m[id]
	if v == nil {
		return "", nil, ErrSource
	}
	return v.kind, bytes.Clone(v.data), nil
}
func meta(format string, v *object) egress.Object {
	id, digest := objectDigests(format, v.kind, v.data)
	return egress.Object{OID: id, Kind: v.kind, Size: int64(len(v.data)), Digest: digest}
}
func objID(format string, v *object) string { return meta(format, v).OID }
func commit(format string, tree string, parents ...string) *object {
	text := "tree " + tree + "\n"
	for _, p := range parents {
		text += "parent " + p + "\n"
	}
	text += "author Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n"
	return &object{kind: "commit", data: []byte(text)}
}
func tree(format string, blob *object) *object {
	id, _ := hex.DecodeString(objID(format, blob))
	return &object{kind: "tree", data: append([]byte("100644 file.txt\x00"), id...)}
}
func packFixture(t *testing.T, format string) (egress.Intent, memoryObjects, []*object) {
	t.Helper()
	oldBlob := &object{kind: "blob", data: []byte("old source\n")}
	oldTree := tree(format, oldBlob)
	oldCommit := commit(format, objID(format, oldTree))
	blob := &object{kind: "blob", data: []byte("new source\n")}
	tr := tree(format, blob)
	head := commit(format, objID(format, tr), objID(format, oldCommit))
	in := egress.Intent{Binding: egress.Binding{OperationID: "operation", WorkspaceID: "workspace", RuntimeID: "runtime", GrantID: "grant", RepositoryID: "repository", SourceSeal: strings.Repeat("a", 64), DestinationSeal: strings.Repeat("b", 64)},
		Target: egress.Target{Host: "fixture.invalid", User: "git", Repository: "owner/repo.git", Port: 22}, Format: format, Ref: "refs/heads/feature/owner", BranchPrefix: "refs/heads/feature/", DefaultRef: "refs/heads/main", Base: objID(format, oldCommit), Head: objID(format, head), Limits: egress.DefaultLimits()}
	in.Old = strings.Repeat("0", len(in.Head))
	known := memoryObjects{}
	for _, v := range []*object{oldCommit, oldTree, oldBlob} {
		m := meta(format, v)
		in.Known = append(in.Known, m)
		known[m.OID] = v
	}
	objects := []*object{head, tr, blob}
	for _, v := range objects {
		in.Objects = append(in.Objects, meta(format, v))
	}
	return in, known, objects
}
func makePack(t *testing.T, format string, objects []*object) []byte {
	t.Helper()
	b := &bytes.Buffer{}
	b.WriteString("PACK")
	_ = binary.Write(b, binary.BigEndian, uint32(2))
	_ = binary.Write(b, binary.BigEndian, uint32(len(objects)))
	for _, v := range objects {
		typ := byte(0)
		switch v.kind {
		case "commit":
			typ = 1
		case "tree":
			typ = 2
		case "blob":
			typ = 3
		case "tag":
			typ = 4
		}
		writeObjectHeader(b, typ, len(v.data))
		zw := zlib.NewWriter(b)
		_, _ = zw.Write(v.data)
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return finishPack(format, b.Bytes())
}
func writeObjectHeader(w io.Writer, typ byte, size int) {
	b := byte(size&15) | (typ << 4)
	size >>= 4
	if size > 0 {
		b |= 128
	}
	_, _ = w.Write([]byte{b})
	for size > 0 {
		b = byte(size & 127)
		size >>= 7
		if size > 0 {
			b |= 128
		}
		_, _ = w.Write([]byte{b})
	}
}
func finishPack(format string, b []byte) []byte {
	var h hash.Hash = sha1.New()
	if format == "sha256" {
		h = sha256.New()
	}
	_, _ = h.Write(b)
	return append(bytes.Clone(b), h.Sum(nil)...)
}
func pkt(text string) []byte {
	b, err := packet([]byte(text))
	if err != nil {
		panic(err)
	}
	return b
}
func advertised(in egress.Intent, old string) []byte {
	caps := "report-status report-status-v2 delete-refs side-band-64k ofs-delta atomic push-options object-format=" + in.Format + " agent=git/test"
	var b []byte
	if egress.IsZero(old) {
		b = pkt(strings.Repeat("0", len(in.Head)) + " capabilities^{}\x00" + caps + "\n")
	} else {
		b = pkt(old + " " + in.Ref + "\x00" + caps + "\n")
	}
	return append(b, []byte("0000")...)
}
func update(in egress.Intent, pack []byte) []byte {
	return append(append(pkt(in.Old+" "+in.Head+" "+in.Ref+"\x00report-status ofs-delta object-format="+in.Format+"\n"), []byte("0000")...), pack...)
}
func report(ref string, ok bool) []byte {
	s := "ok " + ref + "\n"
	if !ok {
		s = "ng " + ref + " fixture rejection\n"
	}
	return append(append(pkt("unpack ok\n"), pkt(s)...), []byte("0000")...)
}

type fakeStream struct {
	reader     *bytes.Reader
	written    bytes.Buffer
	mu         sync.Mutex
	closeCount int
	closeErr   error
	writeErr   error
	panicWrite bool
}

func newStream(in []byte) *fakeStream { return &fakeStream{reader: bytes.NewReader(in)} }
func (s *fakeStream) Read(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reader.Read(b)
}
func (s *fakeStream) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.panicWrite {
		panic("private port detail")
	}
	if s.writeErr != nil {
		return 0, s.writeErr
	}
	return s.written.Write(b)
}
func (s *fakeStream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeCount++
	return s.closeErr
}
func (s *fakeStream) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return bytes.Clone(s.written.Bytes())
}
func (s *fakeStream) Closed() int { s.mu.Lock(); defer s.mu.Unlock(); return s.closeCount }

type fakePeer struct {
	*fakeStream
	target egress.Target
}

func (p *fakePeer) Binding() egress.Target { return p.target }

type custody struct {
	mu             sync.Mutex
	digest         string
	checks, begins int
	denyAt         int
	beforeErr      error
	begun          bool
	onCheck        func(int)
	onBegin        func()
}

func (c *custody) Check(ctx context.Context, d string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checks++
	if c.onCheck != nil {
		c.onCheck(c.checks)
	}
	if d != c.digest || c.denyAt == c.checks {
		return ErrScope
	}
	return ctx.Err()
}
func (c *custody) BeforeRelease(ctx context.Context, d string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.begins++
	if c.onBegin != nil {
		c.onBegin()
	}
	if c.beforeErr != nil {
		return c.beforeErr
	}
	if c.begun || d != c.digest {
		return ErrReplay
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.begun = true
	return nil
}

var errInjected = errors.New("injected IO failure")
