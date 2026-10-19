package git

// applyDelta reconstructs the documented Git delta format, with independent
// limits on instruction bytes, base size, target size and actual copy bounds.
func applyDelta(base, delta []byte, max int64) ([]byte, error) {
	pos := 0
	readSize := func() (uint64, error) {
		var size uint64
		for shift := uint(0); shift < 64; shift += 7 {
			if pos >= len(delta) {
				return 0, ErrProtocol
			}
			b := delta[pos]
			pos++
			if shift == 63 && b > 1 {
				return 0, ErrLimit
			}
			size |= uint64(b&127) << shift
			if b&128 == 0 {
				return size, nil
			}
		}
		return 0, ErrLimit
	}
	source, err := readSize()
	if err != nil || source != uint64(len(base)) {
		return nil, ErrSource
	}
	target, err := readSize()
	if err != nil {
		return nil, err
	}
	if target > uint64(max) {
		return nil, ErrLimit
	}
	out := make([]byte, 0, int(target))
	for pos < len(delta) {
		op := delta[pos]
		pos++
		if op&128 == 0 {
			n := int(op)
			if n == 0 || n > len(delta)-pos || uint64(n) > target-uint64(len(out)) {
				return nil, ErrProtocol
			}
			out = append(out, delta[pos:pos+n]...)
			pos += n
			continue
		}
		var offset, size uint64
		for bit := uint(0); bit < 7; bit++ {
			if op&(1<<bit) == 0 {
				continue
			}
			if pos >= len(delta) {
				return nil, ErrProtocol
			}
			value := uint64(delta[pos])
			pos++
			if bit < 4 {
				offset |= value << (8 * bit)
			} else {
				size |= value << (8 * (bit - 4))
			}
		}
		if size == 0 {
			size = 0x10000
		}
		if offset > uint64(len(base)) || size > uint64(len(base))-offset || size > target-uint64(len(out)) {
			return nil, ErrProtocol
		}
		out = append(out, base[offset:offset+size]...)
	}
	if uint64(len(out)) != target {
		return nil, ErrProtocol
	}
	return out, nil
}
