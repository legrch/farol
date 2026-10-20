package execution

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"debug/macho"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

// launchImage is the identity a running process must have to be the verified
// launch image: the kernel code-signing directory hash of its main executable
// and the filesystem object that executable was mapped from. Both are expected
// values derived from the held, already verified application directory; neither
// comes from the request or from a path string.
type launchImage struct {
	CDHash [20]byte
	Device uint32
	Inode  uint64
}

// expectedImage is what a process may legitimately run: the executable's file
// and the code-directory hash of ANY slice of it. LaunchServices, Rosetta or a
// user preference choose the slice, so none is assumed; every slice is part of
// the verified bytes, so accepting each of them binds the same file.
type expectedImage struct {
	CDHashes [][20]byte
	Device   uint32
	Inode    uint64
}

func (e expectedImage) accepts(live launchImage) bool {
	if live.Device != e.Device || live.Inode != e.Inode {
		return false
	}
	for _, hash := range e.CDHashes {
		if hash == live.CDHash {
			return true
		}
	}
	return false
}

func (e expectedImage) equal(other expectedImage) bool {
	if e.Device != other.Device || e.Inode != other.Inode || len(e.CDHashes) != len(other.CDHashes) {
		return false
	}
	for i := range e.CDHashes {
		if e.CDHashes[i] != other.CDHashes[i] {
			return false
		}
	}
	return true
}

const (
	// macOSDirectory is the bundle directory LaunchServices executes from. The
	// verified package has exactly one entry in it.
	macOSDirectory = "Contents/MacOS"
	// The packaged launcher is a shell script that execs the Electron runtime
	// executable. The process the kernel reports after that exec is the
	// runtime, so the script is accepted only when it names exactly this path.
	runtimeExecutable = "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron"
	runtimeReference  = `"$contents_dir/Frameworks/Electron Runtime.app/Contents/MacOS/Electron"`

	maxSignatureBytes = 16 << 20
	maxScriptBytes    = 4096
)

var errLaunchImage = errors.New("launch image not derivable")

func imageError(reason string, cause error) error {
	if cause == nil {
		return fmt.Errorf("%w: %s", errLaunchImage, reason)
	}
	return fmt.Errorf("%w: %s: %w", errLaunchImage, reason, cause)
}

// openBelow opens a path below a held directory one component at a time, never
// following a link. The returned file is owned by the caller.
func openBelow(root *os.File, components ...string) (*os.File, error) {
	return openBelowAs(root, false, components...)
}

// openBelowAs is openBelow where dirLast requires the final component to be a
// directory as well.
func openBelowAs(root *os.File, dirLast bool, components ...string) (*os.File, error) {
	current := root
	for i, name := range components {
		last := i == len(components)-1
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if !last || dirLast {
			flags |= unix.O_DIRECTORY
		}
		raw, err := current.SyscallConn()
		if err != nil {
			return nil, err
		}
		fd := -1
		var opened error
		if err := raw.Control(func(parent uintptr) { fd, opened = unix.Openat(int(parent), name, flags, 0) }); err != nil || opened != nil {
			if current != root {
				_ = current.Close()
			}
			return nil, errors.Join(err, opened)
		}
		next := os.NewFile(uintptr(fd), name)
		if next == nil {
			_ = unix.Close(fd)
			if current != root {
				_ = current.Close()
			}
			return nil, errors.New("descriptor not adoptable")
		}
		if current != root {
			_ = current.Close()
		}
		current = next
	}
	return current, nil
}

// statByName stats a path below a held directory without following a link.
func statByName(root *os.File, components ...string) (unix.Stat_t, error) {
	var st unix.Stat_t
	parent, err := openBelowAs(root, true, components[:len(components)-1]...)
	if err != nil {
		return st, err
	}
	if parent != root {
		defer parent.Close()
	}
	raw, err := parent.SyscallConn()
	if err != nil {
		return st, err
	}
	var inner error
	if err := raw.Control(func(fd uintptr) {
		inner = unix.Fstatat(int(fd), components[len(components)-1], &st, unix.AT_SYMLINK_NOFOLLOW)
	}); err != nil {
		return st, err
	}
	return st, inner
}

func fstat(file *os.File) (unix.Stat_t, error) {
	var st unix.Stat_t
	raw, err := file.SyscallConn()
	if err != nil {
		return st, err
	}
	var inner error
	if err := raw.Control(func(fd uintptr) { inner = unix.Fstat(int(fd), &st) }); err != nil {
		return st, err
	}
	return st, inner
}

// pinnedFile is a descriptor opened without following a link, with the
// identity it had when it was pinned.
type pinnedFile struct {
	path []string
	file *os.File
	st   unix.Stat_t
}

func sameObject(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Nlink == b.Nlink &&
		a.Uid == b.Uid && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

// heldLaunch pins the files the expected launch image is derived from BEFORE
// the tree is verified. The verification then covers exactly the entries these
// descriptors name, and derive proves that before reading a single byte.
type heldLaunch struct {
	exe, runtime *pinnedFile
}

func pin(app *os.File, path ...string) (*pinnedFile, error) {
	file, err := openBelow(app, path...)
	if err != nil {
		return nil, err
	}
	st, err := fstat(file)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return &pinnedFile{path: path, file: file, st: st}, nil
}

func (h *heldLaunch) close() {
	for _, p := range []*pinnedFile{h.exe, h.runtime} {
		if p != nil {
			_ = p.file.Close()
		}
	}
}

// pinLaunchImage opens, without following links, the executable LaunchServices
// will run: the single entry of Contents/MacOS and, when that is a launcher
// script, the runtime executable it names. It must run before verification.
func pinLaunchImage(app *os.File) (*heldLaunch, error) {
	directory, err := openBelowAs(app, true, "Contents", "MacOS")
	if err != nil {
		return nil, imageError("launch directory", err)
	}
	names, err := directory.Readdirnames(3)
	_ = directory.Close()
	if err != nil || len(names) != 1 {
		return nil, imageError("launch directory must hold exactly one executable", err)
	}
	held := &heldLaunch{}
	if held.exe, err = pin(app, "Contents", "MacOS", names[0]); err != nil {
		return nil, imageError("launch executable", err)
	}
	head := make([]byte, 2)
	if n, err := held.exe.file.ReadAt(head, 0); n == 2 && err == nil && string(head) == "#!" {
		if held.runtime, err = pin(app, "Contents", "Frameworks", "Electron Runtime.app", "Contents", "MacOS", "Electron"); err != nil {
			held.close()
			return nil, imageError("runtime executable", err)
		}
	}
	return held, nil
}

// derive computes the expected process image from the pinned descriptors only.
// After verification it proves each descriptor is still the object its name
// resolves to, and that it did not change while being read. A swap anywhere
// between pinning and here makes the name and the descriptor disagree. It never
// reopens an executable by name to read it, and never runs a signing tool.
func (h *heldLaunch) derive(app *os.File) (expectedImage, error) {
	for _, p := range []*pinnedFile{h.exe, h.runtime} {
		if p == nil {
			continue
		}
		current, err := fstat(p.file)
		if err != nil || !sameObject(current, p.st) {
			return expectedImage{}, imageError("pinned executable changed", err)
		}
		named, err := statByName(app, p.path...)
		if err != nil || !sameObject(named, p.st) {
			return expectedImage{}, imageError("executable name no longer names the pinned object", err)
		}
	}
	source := h.exe
	if h.runtime != nil {
		head := make([]byte, maxScriptBytes)
		n, err := h.exe.file.ReadAt(head, 0)
		if err != nil && err != io.EOF {
			return expectedImage{}, imageError("launcher read", err)
		}
		if !bytes.Contains(head[:n], []byte(runtimeReference)) {
			return expectedImage{}, imageError("launcher does not name the runtime executable", nil)
		}
		source = h.runtime
	}
	image, err := imageOf(source.file)
	if err != nil {
		return expectedImage{}, err
	}
	after, err := fstat(source.file)
	if err != nil || !sameObject(after, source.st) {
		return expectedImage{}, imageError("executable changed while read", err)
	}
	return image, nil
}

// expectedLaunchImage pins and derives in one step, for callers with no
// verification between the two.
func expectedLaunchImage(app *os.File) (expectedImage, error) {
	held, err := pinLaunchImage(app)
	if err != nil {
		return expectedImage{}, err
	}
	defer held.close()
	return held.derive(app)
}

func imageOf(file *os.File) (expectedImage, error) {
	st, err := fstat(file)
	if err != nil {
		return expectedImage{}, imageError("executable stat", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Size < 1 {
		return expectedImage{}, imageError("executable is not a plain file", nil)
	}
	hashes, err := codeDirectoryHashes(file, st.Size)
	if err != nil {
		return expectedImage{}, imageError("code directory", err)
	}
	return expectedImage{CDHashes: hashes, Device: uint32(st.Dev), Inode: uint64(st.Ino)}, nil
}

// slices returns each Mach-O slice of the file: the whole file when thin, every
// architecture when universal.
func slices(file io.ReaderAt, size int64) ([]*io.SectionReader, []macho.Cpu, error) {
	whole := io.NewSectionReader(file, 0, size)
	fat, err := macho.NewFatFile(whole)
	switch {
	case err == nil:
		var out []*io.SectionReader
		var cpus []macho.Cpu
		for _, candidate := range fat.Arches {
			if int64(candidate.Offset)+int64(candidate.Size) > size {
				return nil, nil, errors.New("universal slice out of range")
			}
			out = append(out, io.NewSectionReader(file, int64(candidate.Offset), int64(candidate.Size)))
			cpus = append(cpus, candidate.Cpu)
		}
		if len(out) == 0 {
			return nil, nil, errors.New("empty universal binary")
		}
		return out, cpus, nil
	case errors.Is(err, macho.ErrNotFat):
		return []*io.SectionReader{whole}, []macho.Cpu{0}, nil
	}
	return nil, nil, err
}

// codeDirectoryHashes returns the 20-byte code-directory hash of EVERY slice, in
// file order. Each is the first 20 bytes of the digest of that slice's best
// CodeDirectory. An unsigned or malformed slice refuses the whole file.
func codeDirectoryHashes(file io.ReaderAt, size int64) ([][20]byte, error) {
	parts, _, err := slices(file, size)
	if err != nil {
		return nil, err
	}
	hashes := make([][20]byte, 0, len(parts))
	for _, part := range parts {
		hash, err := sliceHash(part)
		if err != nil {
			return nil, err
		}
		hashes = append(hashes, hash)
	}
	return hashes, nil
}

// codeDirectoryHash returns the hash of the slice for arch (a Go GOARCH name).
func codeDirectoryHash(file io.ReaderAt, size int64, arch string) ([20]byte, error) {
	parts, cpus, err := slices(file, size)
	if err != nil {
		return [20]byte{}, err
	}
	if len(parts) == 1 && cpus[0] == 0 {
		return sliceHash(parts[0])
	}
	want := map[string]macho.Cpu{"arm64": macho.CpuArm64, "amd64": macho.CpuAmd64}[arch]
	found := -1
	for i, cpu := range cpus {
		if cpu == want {
			if found >= 0 {
				return [20]byte{}, errors.New("duplicate universal slice")
			}
			found = i
		}
	}
	if found < 0 {
		return [20]byte{}, errors.New("no universal slice for the architecture")
	}
	return sliceHash(parts[found])
}

func sliceHash(slice *io.SectionReader) ([20]byte, error) {
	thin, err := macho.NewFile(slice)
	if err != nil {
		return [20]byte{}, err
	}
	var location []byte
	for _, load := range thin.Loads {
		raw, ok := load.(macho.LoadBytes)
		if !ok || len(raw) < 16 || thin.ByteOrder.Uint32(raw[0:4]) != 0x1d {
			continue
		}
		if location != nil {
			return [20]byte{}, errors.New("duplicate code signature command")
		}
		location = raw
	}
	if location == nil {
		return [20]byte{}, errors.New("no code signature")
	}
	offset, length := int64(thin.ByteOrder.Uint32(location[8:12])), int64(thin.ByteOrder.Uint32(location[12:16]))
	if length < 12 || length > maxSignatureBytes || offset+length > slice.Size() {
		return [20]byte{}, errors.New("code signature out of range")
	}
	blob := make([]byte, length)
	if _, err := slice.ReadAt(blob, offset); err != nil {
		return [20]byte{}, err
	}
	return bestCDHash(blob)
}

const (
	superBlobMagic      = 0xfade0cc0
	codeDirectoryMagic  = 0xfade0c02
	slotCodeDirectory   = 0
	slotAlternateFirst  = 0x1000
	slotAlternateLast   = 0x1004
	hashTypeSHA1        = 1
	hashTypeSHA256      = 2
	hashTypeSHA256Trunc = 3
	hashTypeSHA384      = 4
)

// The kernel keeps the highest-priority CodeDirectory when a signature carries
// several; cdhash is that directory's digest truncated to 20 bytes.
func hashPriority(kind byte) int {
	switch kind {
	case hashTypeSHA1:
		return 1
	case hashTypeSHA256Trunc:
		return 2
	case hashTypeSHA256:
		return 3
	case hashTypeSHA384:
		return 4
	}
	return 0
}

func bestCDHash(blob []byte) ([20]byte, error) {
	be := binary.BigEndian
	if len(blob) < 12 || be.Uint32(blob[0:4]) != superBlobMagic || int64(be.Uint32(blob[4:8])) > int64(len(blob)) {
		return [20]byte{}, errors.New("malformed signature superblob")
	}
	total := int(be.Uint32(blob[4:8]))
	count := int(be.Uint32(blob[8:12]))
	if count < 1 || count > 64 || 12+count*8 > total {
		return [20]byte{}, errors.New("malformed signature index")
	}
	var best []byte
	bestRank := 0
	var bestKind byte
	for i := 0; i < count; i++ {
		kind, offset := be.Uint32(blob[12+i*8:]), int(be.Uint32(blob[16+i*8:]))
		if kind != slotCodeDirectory && (kind < slotAlternateFirst || kind > slotAlternateLast) {
			continue
		}
		if offset < 12+count*8 || offset+44 > total {
			return [20]byte{}, errors.New("code directory out of range")
		}
		if be.Uint32(blob[offset:]) != codeDirectoryMagic {
			return [20]byte{}, errors.New("code directory magic")
		}
		length := int(be.Uint32(blob[offset+4:]))
		if length < 44 || offset+length > total {
			return [20]byte{}, errors.New("code directory length")
		}
		directory := blob[offset : offset+length]
		hashKind := directory[37]
		if rank := hashPriority(hashKind); rank > bestRank {
			best, bestRank, bestKind = directory, rank, hashKind
		}
	}
	if best == nil {
		return [20]byte{}, errors.New("no usable code directory")
	}
	var digest hash.Hash
	switch bestKind {
	case hashTypeSHA1:
		digest = sha1.New()
	case hashTypeSHA256, hashTypeSHA256Trunc:
		digest = sha256.New()
	case hashTypeSHA384:
		digest = sha512.New384()
	}
	digest.Write(best)
	var out [20]byte
	copy(out[:], digest.Sum(nil))
	return out, nil
}

// argvHolds reports whether a kern.procargs2 buffer carries exactly the given
// argument. The buffer is argc, the exec path, padding, then argc strings.
func argvHolds(raw []byte, argument string) bool {
	if len(raw) < 4 {
		return false
	}
	argc := int(binary.LittleEndian.Uint32(raw[:4]))
	rest := raw[4:]
	end := bytes.IndexByte(rest, 0)
	if end < 0 {
		return false
	}
	rest = rest[end:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	for i := 0; i < argc; i++ {
		end := bytes.IndexByte(rest, 0)
		if end < 0 {
			return false
		}
		if string(rest[:end]) == argument {
			return true
		}
		rest = rest[end+1:]
	}
	return false
}
