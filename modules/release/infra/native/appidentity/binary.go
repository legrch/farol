package appidentity

import (
	"encoding/binary"
	"math"
	"sort"
)

type binaryParser struct {
	raw           []byte
	b             *budget
	offsets, ends []int
	refWidth      int
	states        []uint8
	values        []any
	heights       []int
}

func uintBE(raw []byte) uint64 {
	var n uint64
	for _, c := range raw {
		n = n<<8 | uint64(c)
	}
	return n
}
func width(n byte) bool { return n >= 1 && n <= 8 }
func parseBinary(raw []byte, b *budget) (any, error) {
	bad := func() (any, error) { return nil, refusal(InvalidPlist) }
	if len(raw) < 40 {
		return bad()
	}
	t := raw[len(raw)-32:]
	for _, c := range t[:6] {
		if c != 0 {
			return bad()
		}
	}
	if !width(t[6]) || !width(t[7]) {
		return bad()
	}
	count, top, table := uintBE(t[8:16]), uintBE(t[16:24]), uintBE(t[24:32])
	if count == 0 || count > maxUnits || top >= count || table < 8 || table > uint64(len(raw)-32) || count*uint64(t[6]) != uint64(len(raw)-32)-table {
		return bad()
	}
	p := binaryParser{raw: raw, b: b, refWidth: int(t[7]), offsets: make([]int, int(count)), ends: make([]int, int(count)), states: make([]uint8, int(count)), values: make([]any, int(count)), heights: make([]int, int(count))}
	type position struct{ at, id int }
	positions := make([]position, int(count))
	for i := range p.offsets {
		if e := b.check(); e != nil {
			return nil, e
		}
		start := int(table) + i*int(t[6])
		off := uintBE(raw[start : start+int(t[6])])
		if off < 8 || off >= table {
			return bad()
		}
		p.offsets[i] = int(off)
		positions[i] = position{int(off), i}
	}
	sort.Slice(positions, func(i, j int) bool { return positions[i].at < positions[j].at })
	for i, pos := range positions {
		end := int(table)
		if i+1 < len(positions) {
			end = positions[i+1].at
		}
		if end <= pos.at {
			return bad()
		}
		p.ends[pos.id] = end
	}
	// Validate every table object, including objects unreachable from the root.
	for i := range p.offsets {
		if _, _, e := p.object(i, 0); e != nil {
			return nil, e
		}
	}
	return p.values[int(top)], nil
}
func (p *binaryParser) object(id, depth int) (any, int, error) {
	bad := func() (any, int, error) { return nil, 0, refusal(InvalidPlist) }
	if e := p.b.check(); e != nil {
		return nil, 0, e
	}
	if depth > maxDepth {
		return nil, 0, refusal(Limit)
	}
	if p.states[id] == 1 {
		return bad()
	}
	if p.states[id] == 2 {
		if depth+p.heights[id] > maxDepth {
			return nil, 0, refusal(Limit)
		}
		return p.values[id], p.heights[id], nil
	}
	if e := p.b.node(depth); e != nil {
		return nil, 0, e
	}
	p.states[id] = 1
	raw := p.raw[p.offsets[id]:p.ends[id]]
	marker := raw[0]
	kind, nibble := marker>>4, marker&15
	at := 1
	length := uint64(nibble)
	if kind == 4 || kind == 5 || kind == 6 || kind == 10 || kind == 13 {
		if nibble == 15 {
			if len(raw) < 2 || raw[1]>>4 != 1 || raw[1]&15 > 3 {
				return bad()
			}
			w := 1 << uint(raw[1]&15)
			if len(raw) < 2+w {
				return bad()
			}
			length = uintBE(raw[2 : 2+w])
			at = 2 + w
		}
		if length > maxDecoded {
			return nil, 0, refusal(Limit)
		}
	}
	var value any
	h := 0
	switch kind {
	case 0:
		switch nibble {
		case 0:
			value = nil
		case 8:
			value = false
		case 9:
			value = true
		default:
			return bad()
		}
	case 1:
		if nibble > 4 || len(raw) < 1+(1<<uint(nibble)) {
			return bad()
		}
		value = struct{}{}
	case 2, 3:
		w := 0
		if kind == 2 && nibble == 2 {
			w = 4
		} else if kind == 2 && nibble == 3 || kind == 3 && nibble == 3 {
			w = 8
		}
		if w == 0 || len(raw) < 1+w {
			return bad()
		}
		var n float64
		if w == 4 {
			n = float64(math.Float32frombits(binary.BigEndian.Uint32(raw[1:])))
		} else {
			n = math.Float64frombits(binary.BigEndian.Uint64(raw[1:]))
		}
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return bad()
		}
		// Python's plist date projection is a datetime in years 1..9999.
		if kind == 3 && (n < -63113904000 || n >= 252423993600) {
			return bad()
		}
		value = struct{}{}
	case 4, 5, 6:
		scale := uint64(1)
		if kind == 6 {
			scale = 2
		}
		if length*scale > uint64(len(raw)-at) {
			return bad()
		}
		payload := raw[at : at+int(length*scale)]
		if kind == 4 {
			value = payload
			if e := p.b.add(0, len(payload)); e != nil {
				return nil, 0, e
			}
		} else {
			var s string
			if kind == 5 {
				for _, c := range payload {
					if c > 127 {
						return bad()
					}
				}
				s = string(payload)
			} else {
				var ok bool
				s, ok = utf16Text(payload, binary.BigEndian)
				if !ok {
					return bad()
				}
			}
			if e := p.b.add(0, len(s)); e != nil {
				return nil, 0, e
			}
			value = s
		}
	case 8:
		if nibble > 7 || len(raw) < int(nibble)+2 {
			return bad()
		}
		value = struct{}{}
	case 10, 13:
		edges := length
		if kind == 13 {
			edges *= 2
		}
		if edges > maxUnits {
			return nil, 0, refusal(Limit)
		}
		if edges*uint64(p.refWidth) > uint64(len(raw)-at) {
			return bad()
		}
		if e := p.b.add(int(edges), 0); e != nil {
			return nil, 0, e
		}
		ids := make([]int, int(edges))
		for i := range ids {
			start := at + i*p.refWidth
			n := uintBE(raw[start : start+p.refWidth])
			if n >= uint64(len(p.offsets)) {
				return bad()
			}
			ids[i] = int(n)
		}
		children := make([]any, len(ids))
		for i, child := range ids {
			v, ch, e := p.object(child, depth+1)
			if e != nil {
				return nil, 0, e
			}
			children[i] = v
			if ch+1 > h {
				h = ch + 1
			}
		}
		if kind == 10 {
			value = children
		} else {
			m := make(map[string]any, int(length))
			for i := 0; i < int(length); i++ {
				key, ok := children[i].(string)
				if !ok {
					return bad()
				}
				if _, ok = m[key]; ok {
					return bad()
				}
				m[key] = children[int(length)+i]
			}
			value = m
		}
	default:
		return bad()
	}
	p.states[id] = 2
	p.values[id] = value
	p.heights[id] = h
	return value, h, nil
}
