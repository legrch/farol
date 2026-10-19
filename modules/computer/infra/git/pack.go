package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"io"
	"strconv"

	egressport "github.com/legrch/farol/modules/computer/app/port/egress"
	"github.com/legrch/farol/modules/computer/domain/egress"
)

type object struct {
	kind  string
	data  []byte
	depth int
}
type packedEntry struct {
	offset     int64
	typ        byte
	baseOffset int64
	baseOID    string
	data       []byte
	resolved   *object
}

type source struct {
	ctx      context.Context
	plan     *egress.Plan
	reader   egressport.Objects
	in       egress.Intent
	cache    map[string]*object
	expanded int64
}

func (s *source) account(n int64) error {
	limit := s.in.Limits.ExpandedBytes
	if n < 0 || n > limit-s.expanded {
		return ErrLimit
	}
	s.expanded += n
	return nil
}
func objectDigests(format, kind string, data []byte) (string, string) {
	var h hash.Hash = sha1.New()
	if format == "sha256" {
		h = sha256.New()
	}
	strong := sha256.New()
	header := []byte(kind + " " + strconv.Itoa(len(data)) + "\x00")
	_, _ = h.Write(header)
	_, _ = h.Write(data)
	_, _ = strong.Write(header)
	_, _ = strong.Write(data)
	return hex.EncodeToString(h.Sum(nil)), hex.EncodeToString(strong.Sum(nil))
}
func (s *source) verify(kind string, data []byte) (string, error) {
	id, strong := objectDigests(s.in.Format, kind, data)
	entry, ok := s.plan.Object(id)
	if !ok || entry.Kind != kind || entry.Size != int64(len(data)) || entry.Digest != strong {
		return "", ErrSource
	}
	return id, nil
}
func (s *source) known(id string) (*object, error) {
	if v := s.cache[id]; v != nil {
		return v, nil
	}
	if !s.plan.IsKnown(id) || s.reader == nil {
		return nil, ErrSource
	}
	if err := s.ctx.Err(); err != nil {
		return nil, err
	}
	kind, data, err := s.reader.ReadObject(s.ctx, id)
	if err != nil {
		return nil, err
	}
	if err = s.ctx.Err(); err != nil {
		return nil, err
	}
	meta, ok := s.plan.Object(id)
	if !ok || kind != meta.Kind || int64(len(data)) != meta.Size || int64(len(data)) > s.in.Limits.ObjectBytes {
		return nil, ErrSource
	}
	if err = s.account(int64(len(data))); err != nil {
		return nil, err
	}
	// The port promises immutable custody; copy as well so later caller mutation
	// cannot alter bytes after the source identity check.
	data = bytes.Clone(data)
	got, err := s.verify(kind, data)
	if err != nil || got != id {
		return nil, ErrSource
	}
	v := &object{kind: kind, data: data}
	s.cache[id] = v
	return v, nil
}

// capture implements ByteReader so zlib must not prefetch bytes belonging to
// another object or the trailer. Only consumed pack bytes enter the upload.
type capture struct {
	ctx   context.Context
	r     io.Reader
	data  []byte
	limit int64
}

func (c *capture) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	left := c.limit - int64(len(c.data))
	if left <= 0 {
		return 0, ErrLimit
	}
	if int64(len(p)) > left {
		p = p[:left]
	}
	n, err := c.r.Read(p)
	if n < 0 || n > len(p) {
		return 0, ErrProtocol
	}
	c.data = append(c.data, p[:n]...)
	if n == 0 && err == nil {
		return 0, io.ErrNoProgress
	}
	return n, err
}
func (c *capture) ReadByte() (byte, error) {
	var b [1]byte
	_, err := io.ReadFull(c, b[:])
	return b[0], err
}

type verifiedPack struct {
	bytes   []byte
	objects map[string]*object
	source  *source
}

func readPack(ctx context.Context, r io.Reader, plan *egress.Plan, reader egressport.Objects) (*verifiedPack, error) {
	in := plan.Intent()
	lim := in.Limits
	c := &capture{ctx: ctx, r: r, limit: lim.PackBytes}
	var header [12]byte
	if _, err := io.ReadFull(c, header[:]); err != nil {
		return nil, err
	}
	version := binary.BigEndian.Uint32(header[4:8])
	count := binary.BigEndian.Uint32(header[8:])
	if string(header[:4]) != "PACK" || (version != 2 && version != 3) {
		return nil, ErrProtocol
	}
	if uint64(count) > uint64(lim.Objects) {
		return nil, ErrLimit
	}
	s := &source{ctx: ctx, plan: plan, reader: reader, in: in, cache: map[string]*object{}}
	entries := make([]packedEntry, 0, int(count))
	offsets := map[int64]int{}
	for i := uint32(0); i < count; i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		e := packedEntry{offset: int64(len(c.data))}
		b, err := c.ReadByte()
		if err != nil {
			return nil, err
		}
		e.typ = (b >> 4) & 7
		size := uint64(b & 15)
		for shift := uint(4); b&128 != 0; shift += 7 {
			if shift >= 64 {
				return nil, ErrLimit
			}
			b, err = c.ReadByte()
			if err != nil {
				return nil, err
			}
			if shift > 57 && uint64(b&127) > (^uint64(0)>>shift) {
				return nil, ErrLimit
			}
			size |= uint64(b&127) << shift
		}
		if size > uint64(lim.ObjectBytes) {
			return nil, ErrLimit
		}
		switch e.typ {
		case 1, 2, 3:
		case 6:
			b, err = c.ReadByte()
			if err != nil {
				return nil, err
			}
			distance := uint64(b & 127)
			for b&128 != 0 {
				if distance > (^uint64(0)>>7)-1 {
					return nil, ErrLimit
				}
				b, err = c.ReadByte()
				if err != nil {
					return nil, err
				}
				distance = ((distance + 1) << 7) + uint64(b&127)
			}
			if distance == 0 || distance > uint64(e.offset-12) {
				return nil, ErrProtocol
			}
			e.baseOffset = e.offset - int64(distance)
			if _, ok := offsets[e.baseOffset]; !ok {
				return nil, ErrProtocol
			}
		case 7:
			b := make([]byte, plan.OIDBytes())
			if _, err = io.ReadFull(c, b); err != nil {
				return nil, err
			}
			e.baseOID = hex.EncodeToString(b)
		default:
			return nil, ErrProtocol // tags and reserved types are not a feature-ref upload
		}
		if err = s.account(int64(size)); err != nil {
			return nil, err
		}
		zr, err := zlib.NewReader(c)
		if err != nil {
			return nil, err
		}
		e.data = make([]byte, int(size))
		_, readErr := io.ReadFull(zr, e.data)
		var extra [1]byte
		n, endErr := zr.Read(extra[:])
		closeErr := zr.Close()
		if readErr != nil {
			return nil, readErr
		}
		if n != 0 || endErr != io.EOF {
			return nil, ErrProtocol
		}
		if closeErr != nil {
			return nil, closeErr
		}
		offsets[e.offset] = len(entries)
		entries = append(entries, e)
	}
	trailer := make([]byte, plan.OIDBytes())
	prefix := len(c.data)
	if _, err := io.ReadFull(c, trailer); err != nil {
		return nil, err
	}
	var h hash.Hash = sha1.New()
	if in.Format == "sha256" {
		h = sha256.New()
	}
	_, _ = h.Write(c.data[:prefix])
	if !bytes.Equal(h.Sum(nil), trailer) {
		return nil, ErrSource
	}
	objects := map[string]*object{}
	remaining := len(entries)
	for pass := 0; remaining > 0 && pass <= lim.DeltaDepth; pass++ {
		progress := false
		for i := range entries {
			e := &entries[i]
			if e.resolved != nil {
				continue
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			v := &object{}
			switch e.typ {
			case 1:
				v.kind = "commit"
				v.data = e.data
			case 2:
				v.kind = "tree"
				v.data = e.data
			case 3:
				v.kind = "blob"
				v.data = e.data
			default:
				var base *object
				if e.typ == 6 {
					base = entries[offsets[e.baseOffset]].resolved
				} else {
					base = objects[e.baseOID]
					if base == nil && plan.IsKnown(e.baseOID) {
						var err error
						base, err = s.known(e.baseOID)
						if err != nil {
							return nil, err
						}
					}
				}
				if base == nil {
					continue
				}
				v.kind = base.kind
				v.depth = base.depth + 1
				if v.depth > lim.DeltaDepth {
					return nil, ErrLimit
				}
				var err error
				v.data, err = applyDelta(base.data, e.data, lim.ObjectBytes)
				if err != nil {
					return nil, err
				}
				if err = s.account(int64(len(v.data))); err != nil {
					return nil, err
				}
			}
			id, err := s.verify(v.kind, v.data)
			if err != nil {
				return nil, err
			}
			if _, duplicate := objects[id]; duplicate {
				return nil, ErrProtocol
			}
			objects[id] = v
			e.resolved = v
			remaining--
			progress = true
		}
		if !progress {
			return nil, ErrSource
		}
	}
	if remaining != 0 {
		return nil, ErrLimit
	}
	p := &verifiedPack{bytes: c.data, objects: objects, source: s}
	if err := p.verifyGraph(); err != nil {
		return nil, err
	}
	return p, nil
}
