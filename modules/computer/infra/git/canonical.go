package git

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"hash"
	"sort"
)

// canonical reconstructs the upload from verified source bytes, NOT raw client
// compression/deltas/order/padding. Thus a client cannot smuggle extra objects,
// gratuitous known objects or unapproved bytes in the compressed representation.
// The ordinary Git objects and their exact OIDs are unchanged. The wire pack is
// deterministic for these pinned implementation bytes, sorted and non-thin.
func (p *verifiedPack) canonical() ([]byte, int, error) {
	ids := make([]string, 0, len(p.objects))
	for id := range p.objects {
		if !p.source.plan.IsKnown(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	b := &boundedBuffer{limit: p.source.in.Limits.PackBytes - int64(p.source.plan.OIDBytes())}
	if _, err := b.Write([]byte("PACK")); err != nil {
		return nil, 0, err
	}
	if err := binary.Write(b, binary.BigEndian, uint32(2)); err != nil {
		return nil, 0, err
	}
	if err := binary.Write(b, binary.BigEndian, uint32(len(ids))); err != nil {
		return nil, 0, err
	}
	for _, id := range ids {
		if err := p.source.ctx.Err(); err != nil {
			return nil, 0, err
		}
		v := p.objects[id]
		typ := byte(0)
		switch v.kind {
		case "commit":
			typ = 1
		case "tree":
			typ = 2
		case "blob":
			typ = 3
		default:
			return nil, 0, ErrSource
		}
		size := len(v.data)
		first := byte(size&15) | (typ << 4)
		size >>= 4
		if size > 0 {
			first |= 128
		}
		if _, err := b.Write([]byte{first}); err != nil {
			return nil, 0, err
		}
		for size > 0 {
			next := byte(size & 127)
			size >>= 7
			if size > 0 {
				next |= 128
			}
			if _, err := b.Write([]byte{next}); err != nil {
				return nil, 0, err
			}
		}
		z, err := zlib.NewWriterLevel(b, zlib.BestSpeed)
		if err != nil {
			return nil, 0, err
		}
		if _, err = z.Write(v.data); err != nil {
			_ = z.Close()
			return nil, 0, err
		}
		if err = z.Close(); err != nil {
			return nil, 0, err
		}
	}
	var h hash.Hash = sha1.New()
	if p.source.in.Format == "sha256" {
		h = sha256.New()
	}
	_, _ = h.Write(b.Bytes())
	return append(b.Bytes(), h.Sum(nil)...), len(ids), nil
}

type boundedBuffer struct {
	bytes.Buffer
	limit int64
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if int64(len(p)) > b.limit-int64(b.Len()) {
		return 0, ErrLimit
	}
	return b.Buffer.Write(p)
}
