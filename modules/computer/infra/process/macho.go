package process

import (
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

// Only bounded loader metadata is decoded. This is dependency discovery, not
// code-signature verification, executable trust or arbitrary dlopen analysis.
type hostMachOImports struct {
	libraries, rpaths []string
	fileType          uint32
}

var errHostMachO = errors.New("HOST_RUNTIME_BINARY_UNSUPPORTED")

func hostMachOImportsAt(r io.ReaderAt, size int64) (hostMachOImports, error) {
	fail := func() (hostMachOImports, error) { return hostMachOImports{}, errHostMachO }
	if size < 32 || size > 128<<20 {
		return fail()
	}
	header := make([]byte, 32)
	if _, err := r.ReadAt(header, 0); err != nil {
		return fail()
	}
	offset := int64(0)
	// A universal image must contain exactly one selected native ARM64 slice.
	magic := binary.BigEndian.Uint32(header)
	if magic == 0xcafebabe || magic == 0xcafebabf {
		count := binary.BigEndian.Uint32(header[4:])
		width := 20
		if magic == 0xcafebabf {
			width = 32
		}
		if count == 0 || count > 16 || int64(8+int(count)*width) > size {
			return fail()
		}
		arches := make([]byte, int(count)*width)
		if _, err := r.ReadAt(arches, 8); err != nil {
			return fail()
		}
		found := false
		for i := 0; i < int(count); i++ {
			a := arches[i*width : (i+1)*width]
			if binary.BigEndian.Uint32(a) != 0x0100000c {
				continue
			}
			if found {
				return fail()
			}
			found = true
			var off, length uint64
			if width == 20 {
				off = uint64(binary.BigEndian.Uint32(a[8:]))
				length = uint64(binary.BigEndian.Uint32(a[12:]))
			} else {
				off = binary.BigEndian.Uint64(a[8:])
				length = binary.BigEndian.Uint64(a[16:])
			}
			if off < uint64(8+int(count)*width) || length < 32 || off > uint64(size) || length > uint64(size)-off {
				return fail()
			}
			offset = int64(off)
			size = int64(length)
		}
		if !found {
			return fail()
		}
		if _, err := r.ReadAt(header, offset); err != nil {
			return fail()
		}
	}
	if binary.LittleEndian.Uint32(header) != 0xfeedfacf || binary.LittleEndian.Uint32(header[4:]) != 0x0100000c {
		return fail()
	}
	count, bytes := binary.LittleEndian.Uint32(header[16:]), binary.LittleEndian.Uint32(header[20:])
	if count > 8192 || bytes > 4<<20 || int64(bytes) > size-32 || uint64(count)*8 > uint64(bytes) {
		return fail()
	}
	commands := make([]byte, int(bytes))
	if len(commands) > 0 {
		if _, err := r.ReadAt(commands, offset+32); err != nil {
			return fail()
		}
	}
	result := hostMachOImports{fileType: binary.LittleEndian.Uint32(header[12:])}
	cursor := 0
	for i := uint32(0); i < count; i++ {
		if len(commands)-cursor < 8 {
			return fail()
		}
		command := binary.LittleEndian.Uint32(commands[cursor:])
		length := binary.LittleEndian.Uint32(commands[cursor+4:])
		if length < 8 || length%8 != 0 || uint64(length) > uint64(len(commands)-cursor) {
			return fail()
		}
		item := commands[cursor : cursor+int(length)]
		cursor += int(length)
		library := command == 0xc || command == 0x80000018 || command == 0x8000001f || command == 0x80000023 || command == 0x20
		rpath := command == 0x8000001c
		if !library && !rpath {
			continue
		}
		minimum := 12
		if library {
			minimum = 24
		}
		if len(item) < minimum {
			return fail()
		}
		start := binary.LittleEndian.Uint32(item[8:])
		if start < uint32(minimum) || start >= uint32(len(item)) {
			return fail()
		}
		value := item[int(start):]
		end := -1
		for j, b := range value {
			if b == 0 {
				end = j
				break
			}
		}
		if end < 1 || end > 4096 || !utf8.Valid(value[:end]) {
			return fail()
		}
		name := string(value[:end])
		if strings.ContainsAny(name, "\r\n\x00") {
			return fail()
		}
		if library {
			result.libraries = append(result.libraries, name)
		} else {
			result.rpaths = append(result.rpaths, name)
		}
	}
	if cursor != len(commands) {
		return fail()
	}
	return result, nil
}
