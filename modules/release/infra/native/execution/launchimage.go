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
	current := root
	for i, name := range components {
		last := i == len(components)-1
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if !last {
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

// expectedLaunchImage derives the expected process image from the held verified
// application directory. It reads through that descriptor only, and it never
// executes or shells out to a code-signing tool: the expected hash is computed
// from the Mach-O LC_CODE_SIGNATURE of the executable the launch will run.
func expectedLaunchImage(app *os.File, arch string) (launchImage, error) {
	directory, err := openBelow(app, "Contents", "MacOS")
	if err != nil {
		return launchImage{}, imageError("launch directory", err)
	}
	names, err := directory.Readdirnames(3)
	_ = directory.Close()
	if err != nil || len(names) != 1 {
		return launchImage{}, imageError("launch directory must hold exactly one executable", err)
	}
	launcher, err := openBelow(app, "Contents", "MacOS", names[0])
	if err != nil {
		return launchImage{}, imageError("launch executable", err)
	}
	defer launcher.Close()
	head := make([]byte, maxScriptBytes)
	n, err := launcher.ReadAt(head, 0)
	if err != nil && err != io.EOF {
		return launchImage{}, imageError("launch executable read", err)
	}
	head = head[:n]
	if bytes.HasPrefix(head, []byte("#!")) {
		if !bytes.Contains(head, []byte(runtimeReference)) {
			return launchImage{}, imageError("launcher does not name the runtime executable", nil)
		}
		runtime, err := openBelow(app, "Contents", "Frameworks", "Electron Runtime.app", "Contents", "MacOS", "Electron")
		if err != nil {
			return launchImage{}, imageError("runtime executable", err)
		}
		defer runtime.Close()
		return imageOf(runtime, arch)
	}
	return imageOf(launcher, arch)
}

func imageOf(file *os.File, arch string) (launchImage, error) {
	st, err := fstat(file)
	if err != nil {
		return launchImage{}, imageError("executable stat", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Size < 1 {
		return launchImage{}, imageError("executable is not a plain file", nil)
	}
	hash, err := codeDirectoryHash(file, st.Size, arch)
	if err != nil {
		return launchImage{}, imageError("code directory", err)
	}
	return launchImage{CDHash: hash, Device: uint32(st.Dev), Inode: uint64(st.Ino)}, nil
}

// codeDirectoryHash returns the 20-byte code-directory hash the kernel reports
// for the given Mach-O: the first 20 bytes of the digest of the best
// CodeDirectory. A universal binary is resolved to the slice for arch (a Go
// GOARCH name), which is the slice a native launch executes.
func codeDirectoryHash(file io.ReaderAt, size int64, arch string) ([20]byte, error) {
	whole := io.NewSectionReader(file, 0, size)
	slice := whole
	fat, err := macho.NewFatFile(whole)
	switch {
	case err == nil:
		cpu := map[string]macho.Cpu{"arm64": macho.CpuArm64, "amd64": macho.CpuAmd64}[arch]
		found := false
		for _, candidate := range fat.Arches {
			if candidate.Cpu == cpu {
				if found {
					return [20]byte{}, errors.New("duplicate universal slice")
				}
				found = true
				if int64(candidate.Offset)+int64(candidate.Size) > size {
					return [20]byte{}, errors.New("universal slice out of range")
				}
				slice = io.NewSectionReader(file, int64(candidate.Offset), int64(candidate.Size))
			}
		}
		if !found {
			return [20]byte{}, errors.New("no universal slice for the running architecture")
		}
	case errors.Is(err, macho.ErrNotFat):
	default:
		return [20]byte{}, err
	}
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
