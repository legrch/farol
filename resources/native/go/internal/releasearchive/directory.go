package releasearchive

import (
	"bytes"
	"encoding/binary"
	"io"
	"sort"
)

var little = binary.LittleEndian

func u16(b []byte, at int) uint16 { return little.Uint16(b[at : at+2]) }
func u32(b []byte, at int) uint32 { return little.Uint32(b[at : at+4]) }

func readAt(r io.ReaderAt, size int, offset int64) ([]byte, error) {
	b := make([]byte, size)
	if n, err := r.ReadAt(b, offset); err != nil || n != size {
		return nil, refuse("ARCHIVE_DIRECTORY_INVALID")
	}
	return b, nil
}

func admitExtra(extra []byte) error {
	for len(extra) != 0 {
		if len(extra) < 4 {
			return refuse("ARCHIVE_EXTRA_INVALID")
		}
		tag, length := u16(extra, 0), int(u16(extra, 2))
		if len(extra) < 4+length {
			return refuse("ARCHIVE_EXTRA_INVALID")
		}
		if tag == 1 {
			return refuse("ARCHIVE_ZIP64_UNSUPPORTED")
		}
		if tag == 0x000d || tag == 0x756e {
			return refuse("ARCHIVE_HARDLINK_INVALID")
		}
		extra = extra[4+length:]
	}
	return nil
}

type extent struct{ start, end int64 }

// admitDirectory bounds and counts actual records before archive/zip may allocate.
// All local metadata and compressed ranges are checked in the same admission pass.
func admitDirectory(r io.ReaderAt, size int64) (int, error) {
	tailSize := min(size, 65535+22)
	tail, err := readAt(r, int(tailSize), size-tailSize)
	if err != nil {
		return 0, err
	}
	end := bytes.LastIndex(tail, []byte{'P', 'K', 5, 6})
	if end < 0 || len(tail)-end < 22 {
		return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
	}
	h := tail[end:]
	if end+22+int(u16(h, 20)) != len(tail) {
		return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
	}
	count := int(u16(h, 10))
	if u16(h, 4) != 0 || u16(h, 6) != 0 || int(u16(h, 8)) != count {
		return 0, refuse("ARCHIVE_MULTIDISK_UNSUPPORTED")
	}
	length, offset := int64(u32(h, 12)), int64(u32(h, 16))
	if count == 65535 || length == 0xffffffff || offset == 0xffffffff {
		return 0, refuse("ARCHIVE_ZIP64_UNSUPPORTED")
	}
	if length <= 0 || length > maxCentral {
		return 0, refuse("ARCHIVE_CENTRAL_DIRECTORY_LIMIT")
	}
	if count <= 0 || count > maxEntries {
		return 0, refuse("ARCHIVE_ENTRY_COUNT_INVALID")
	}
	endOffset := size - tailSize + int64(end)
	if endOffset >= 20 {
		signature, err := readAt(r, 4, endOffset-20)
		if err != nil {
			return 0, err
		}
		if bytes.Equal(signature, []byte{'P', 'K', 6, 7}) {
			return 0, refuse("ARCHIVE_ZIP64_UNSUPPORTED")
		}
	}
	if offset+length != endOffset {
		return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
	}
	observed := 0
	spans := make([]extent, 0, min(count, 1024))
	for cursor := offset; cursor < endOffset; {
		if cursor+46 > endOffset {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		central, err := readAt(r, 46, cursor)
		if err != nil {
			return 0, err
		}
		if u32(central, 0) != 0x02014b50 {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		nameLen, extraLen, noteLen := int(u16(central, 28)), int(u16(central, 30)), int(u16(central, 32))
		next := cursor + 46 + int64(nameLen+extraLen+noteLen)
		if next > endOffset {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		if u16(central, 34) != 0 {
			return 0, refuse("ARCHIVE_MULTIDISK_UNSUPPORTED")
		}
		compressed, expanded, localOffset := u32(central, 20), u32(central, 24), u32(central, 42)
		if compressed == 0xffffffff || expanded == 0xffffffff || localOffset == 0xffffffff {
			return 0, refuse("ARCHIVE_ZIP64_UNSUPPORTED")
		}
		fields, err := readAt(r, nameLen+extraLen, cursor+46)
		if err != nil {
			return 0, err
		}
		if err := admitExtra(fields[nameLen:]); err != nil {
			return 0, err
		}
		if int64(localOffset)+30 > offset {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		local, err := readAt(r, 30, int64(localOffset))
		if err != nil {
			return 0, err
		}
		if u32(local, 0) != 0x04034b50 {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		if u32(local, 18) == 0xffffffff || u32(local, 22) == 0xffffffff {
			return 0, refuse("ARCHIVE_ZIP64_UNSUPPORTED")
		}
		localName, localExtra := int(u16(local, 26)), int(u16(local, 28))
		dataOffset := int64(localOffset) + 30 + int64(localName+localExtra)
		if dataOffset > offset {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		localFields, err := readAt(r, localName+localExtra, int64(localOffset)+30)
		if err != nil {
			return 0, err
		}
		if err := admitExtra(localFields[localName:]); err != nil {
			return 0, err
		}
		flags, method := u16(central, 8), u16(central, 10)
		if flags&(1|0x40) != 0 || u16(local, 6)&(1|0x40) != 0 {
			return 0, refuse("ARCHIVE_ENCRYPTED")
		}
		if method != 0 && method != 8 {
			return 0, refuse("ARCHIVE_COMPRESSION_INVALID")
		}
		if flags != u16(local, 6) || method != u16(local, 8) || !bytes.Equal(fields[:nameLen], localFields[:localName]) {
			return 0, refuse("ARCHIVE_HEADER_INVALID")
		}
		dataEnd := dataOffset + int64(compressed)
		if dataEnd > offset {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
		if flags&8 == 0 {
			if compressed != u32(local, 18) || expanded != u32(local, 22) || u32(central, 16) != u32(local, 14) {
				return 0, refuse("ARCHIVE_HEADER_INVALID")
			}
		} else {
			// A data descriptor is classic-width only; its sizes must agree with central metadata.
			if dataEnd+12 > offset {
				return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
			}
			descriptor, err := readAt(r, 12, dataEnd)
			if err != nil {
				return 0, err
			}
			if u32(descriptor, 0) == 0x08074b50 {
				if dataEnd+16 > offset {
					return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
				}
				descriptor, err = readAt(r, 12, dataEnd+4)
				if err != nil {
					return 0, err
				}
				dataEnd += 4
			}
			if u32(descriptor, 0) != u32(central, 16) || u32(descriptor, 4) != compressed || u32(descriptor, 8) != expanded {
				return 0, refuse("ARCHIVE_HEADER_INVALID")
			}
			dataEnd += 12
		}
		spans = append(spans, extent{int64(localOffset), dataEnd})
		cursor = next
		observed++
		if observed > maxEntries {
			return 0, refuse("ARCHIVE_ENTRY_COUNT_INVALID")
		}
	}
	if observed != count {
		return 0, refuse("ARCHIVE_ENTRY_COUNT_INVALID")
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end {
			return 0, refuse("ARCHIVE_DIRECTORY_INVALID")
		}
	}
	return observed, nil
}
