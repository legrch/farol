//go:build darwin

package process

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

type nativeHostRuntimeFilesystem struct{}

// Extended ACL qualification. POSIX mode bits cannot express an macOS ACL
// grant, so a file that another account may replace or rewrite through an
// allow entry is not a qualified runtime image even when its mode is private.
// The ACL of the exact vnode held by the descriptor is read with
// fgetattrlist(ATTR_CMN_EXTENDED_SECURITY); the returned bytes follow the
// public kauth_filesec shape of sys/kauth.h behind a fixed
// [total][prologue][length] prefix (measured on APFS, macOS 27 arm64). Every
// deviation from that layout, any unknown kind/flag/right bit and any allow
// entry carrying an effective modification right fails the descriptor closed.
// Deny entries and read-only allows never extend modification rights and are
// accepted. Symlinks are never opened here (O_NOFOLLOW) and carry no ACL.
const hostRuntimeACLAttrExtendedSecurity = 0x00400000 // ATTR_CMN_EXTENDED_SECURITY
const hostRuntimeACLPrologueWords = 8                 // measured constant prefix word
const hostRuntimeACLFilesecHeader = 44                // magic + owner GUID + group GUID + entrycount + flags
const hostRuntimeACLFilesecMagic = 0x012cc16d         // KAUTH_FILESEC_MAGIC
const hostRuntimeACLNoEntries = 0xffffffff            // KAUTH_FILESEC_NOACL
const hostRuntimeACLMaxEntries = 128                  // KAUTH_ACL_MAX_ENTRIES
type hostRuntimeACLAttrList struct {
	Bitmapcount uint16
	Reserved    uint16
	Commonattr  uint32
	Volattr     uint32
	Dirattr     uint32
	Fileattr    uint32
	Forkattr    uint32
}

const (
	hostRuntimeACEKindMask    = 0xf // KAUTH_ACE_KINDMASK
	hostRuntimeACEPermit      = 1   // KAUTH_ACE_PERMIT
	hostRuntimeACEDeny        = 2   // KAUTH_ACE_DENY
	hostRuntimeACEKnownFlags  = hostRuntimeACEKindMask | 1<<4 | 1<<5 | 1<<6 | 1<<7 | 1<<8
	hostRuntimeACEModify      = 1<<2 | 1<<4 | 1<<5 | 1<<6 | 1<<8 | 1<<10 | 1<<12 | 1<<13 | 1<<21 | 1<<23
	hostRuntimeACEKnownRights = (1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5 | 1<<6 | 1<<7 | 1<<8 | 1<<9 | 1<<10 | 1<<11 | 1<<12 | 1<<13) | (1<<20 | 1<<21 | 1<<22 | 1<<23 | 1<<24 | 1<<25 | 1<<26)
)

func hostRuntimeACLVerdict(fd int) error {
	var buffer [4 + 8 + hostRuntimeACLFilesecHeader + hostRuntimeACLMaxEntries*24]byte
	// The syscall only reads these pinned Go buffers and writes the result
	// buffer; nothing escapes as a retained pointer.
	list := hostRuntimeACLAttrList{Bitmapcount: 5, Commonattr: hostRuntimeACLAttrExtendedSecurity} // ATTR_BIT_MAP_COUNT, ATTR_CMN_EXTENDED_SECURITY
	if _, _, errno := unix.Syscall6(unix.SYS_FGETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0, 0); errno != 0 {
		return errno
	}
	// On success the syscall returns zero; the byte count is the first word.
	return hostRuntimeACLFromBuffer(buffer[:])
}

func hostRuntimeACLFromBuffer(buffer []byte) error {
	if len(buffer) < 12 {
		return errHostRuntime
	}
	total := int(binary.LittleEndian.Uint32(buffer[0:4]))
	if total < 12 || total > len(buffer) || binary.LittleEndian.Uint32(buffer[4:8]) != hostRuntimeACLPrologueWords {
		return errHostRuntime
	}
	size := int(binary.LittleEndian.Uint32(buffer[8:12]))
	if size == 0 {
		if total != 12 {
			return errHostRuntime
		}
		return nil // the vnode carries no extended security
	}
	if size < hostRuntimeACLFilesecHeader || size != total-12 || size > hostRuntimeACLFilesecHeader+hostRuntimeACLMaxEntries*24 {
		return errHostRuntime
	}
	fsec := buffer[12:]
	if binary.LittleEndian.Uint32(fsec[0:4]) != hostRuntimeACLFilesecMagic {
		return errHostRuntime
	}
	count := binary.LittleEndian.Uint32(fsec[36:40])
	if count == hostRuntimeACLNoEntries {
		return nil
	}
	if count > hostRuntimeACLMaxEntries || hostRuntimeACLFilesecHeader+24*int(count) != size {
		return errHostRuntime
	}
	for i := 0; i < int(count); i++ {
		ace := fsec[hostRuntimeACLFilesecHeader+24*i:]
		flags := binary.LittleEndian.Uint32(ace[16:20])
		rights := binary.LittleEndian.Uint32(ace[20:24])
		if flags&^hostRuntimeACEKnownFlags != 0 || rights&^hostRuntimeACEKnownRights != 0 {
			return errHostRuntime
		}
		switch flags & hostRuntimeACEKindMask {
		case hostRuntimeACEDeny:
			// A deny never grants a modification right.
		case hostRuntimeACEPermit:
			if rights&hostRuntimeACEModify != 0 {
				return errHostRuntime
			}
		default:
			return errHostRuntime // audit/alarm kinds are not implemented by the kernel
		}
	}
	return nil
}

func (nativeHostRuntimeFilesystem) uid() uint32 { return uint32(os.Geteuid()) }
func (nativeHostRuntimeFilesystem) resolve(ctx context.Context, p string) (string, error) {
	if ctx == nil || ctx.Err() != nil {
		return "", errHostRuntime
	}
	return filepath.EvalSymlinks(p)
}
func hostRuntimeStatNode(p string, info os.FileInfo) (hostRuntimeNode, error) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return hostRuntimeNode{}, errHostRuntime
	}
	kind := "file"
	if info.IsDir() {
		kind = "directory"
	} else if info.Mode()&os.ModeSymlink != 0 {
		kind = "alias"
	} else if !info.Mode().IsRegular() {
		return hostRuntimeNode{}, errHostRuntime
	}
	return hostRuntimeNode{Path: p, Kind: kind, Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10), Modified: strconv.FormatInt(st.Mtimespec.Sec, 10) + ":" + strconv.FormatInt(st.Mtimespec.Nsec, 10), Changed: strconv.FormatInt(st.Ctimespec.Sec, 10) + ":" + strconv.FormatInt(st.Ctimespec.Nsec, 10), UID: st.Uid, GID: st.Gid, Mode: info.Mode(), Size: info.Size(), Links: uint64(st.Nlink)}, nil
}
func sameHostRuntimeStat(a, b os.FileInfo) bool {
	if a == nil || b == nil || !os.SameFile(a, b) {
		return false
	}
	aa, e := hostRuntimeStatNode("/checked", a)
	bb, f := hostRuntimeStatNode("/checked", b)
	return e == nil && f == nil && aa.Path == bb.Path && aa.Kind == bb.Kind && aa.Device == bb.Device && aa.Inode == bb.Inode && aa.Modified == bb.Modified && aa.Changed == bb.Changed && aa.UID == bb.UID && aa.GID == bb.GID && aa.Mode == bb.Mode && aa.Size == bb.Size && aa.Links == bb.Links
}
func hostRuntimeOpen(ctx context.Context, p string) (*os.File, os.FileInfo, error) {
	if ctx == nil || ctx.Err() != nil || !absolutePolicyPath(p) {
		return nil, nil, errHostRuntime
	}
	before, err := os.Lstat(p)
	if err != nil {
		return nil, nil, err
	}
	if before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errHostRuntime
	}
	file, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	fail := func() (*os.File, os.FileInfo, error) { file.Close(); return nil, nil, errHostRuntime }
	held, err := file.Stat()
	if err != nil || !sameHostRuntimeStat(before, held) {
		return fail()
	}
	physical, err := platformDescriptorPath(file.Fd())
	if err != nil || physical != p {
		return fail()
	}
	var volume unix.Statfs_t
	if unix.Fstatfs(int(file.Fd()), &volume) != nil || strings.TrimRight(string(volume.Fstypename[:]), "\x00") != "apfs" {
		return fail()
	}
	mount := strings.TrimRight(string(volume.Mntonname[:]), "\x00")
	if mount != "/" && mount != "/System/Volumes/Data" {
		return fail()
	}
	if err := hostRuntimeACLVerdict(int(file.Fd())); err != nil {
		return fail()
	}
	if ctx.Err() != nil {
		return fail()
	}
	return file, held, nil
}
func (nativeHostRuntimeFilesystem) node(ctx context.Context, p string) (hostRuntimeNode, error) {
	if ctx == nil || ctx.Err() != nil {
		return hostRuntimeNode{}, errHostRuntime
	}
	named, err := os.Lstat(p)
	if err != nil {
		return hostRuntimeNode{}, err
	}
	if named.Mode()&os.ModeSymlink != 0 {
		n, err := hostRuntimeStatNode(p, named)
		if err != nil {
			return n, err
		}
		target, err := os.Readlink(p)
		if err != nil {
			return n, err
		}
		after, err := os.Lstat(p)
		if err != nil || !sameHostRuntimeStat(named, after) || ctx.Err() != nil {
			return n, errHostRuntime
		}
		n.LinkTarget = target
		return n, nil
	}
	file, before, err := hostRuntimeOpen(ctx, p)
	if err != nil {
		return hostRuntimeNode{}, err
	}
	defer file.Close()
	n, err := hostRuntimeStatNode(p, before)
	if err != nil {
		return n, err
	}
	if n.Kind == "file" {
		if n.Size < 0 || n.Size > 128<<20 {
			return n, errHostRuntime
		}
		h := sha256.New()
		count, err := io.Copy(h, &measurementContextReader{ctx: ctx, reader: io.NewSectionReader(file, 0, n.Size+1)})
		if err != nil || count != n.Size {
			return n, errHostRuntime
		}
		n.SHA256 = hex.EncodeToString(h.Sum(nil))
	}
	after, err := file.Stat()
	named, other := os.Lstat(p)
	if err != nil || other != nil || !sameHostRuntimeStat(before, after) || !sameHostRuntimeStat(after, named) || ctx.Err() != nil {
		return n, errHostRuntime
	}
	return n, nil
}
func (nativeHostRuntimeFilesystem) entries(ctx context.Context, p string) ([]string, error) {
	file, before, err := hostRuntimeOpen(ctx, p)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if !before.IsDir() {
		return nil, errHostRuntime
	}
	names, err := file.Readdirnames(2049)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(names) > 2048 {
		return nil, errHostRuntime
	}
	after, err := file.Stat()
	named, other := os.Lstat(p)
	if err != nil || other != nil || !sameHostRuntimeStat(before, after) || !sameHostRuntimeStat(after, named) || ctx.Err() != nil {
		return nil, errHostRuntime
	}
	return names, nil
}

type hostRuntimeContextReaderAt struct {
	ctx    context.Context
	reader io.ReaderAt
}

func (r hostRuntimeContextReaderAt) ReadAt(b []byte, off int64) (int, error) {
	if r.ctx.Err() != nil {
		return 0, r.ctx.Err()
	}
	return r.reader.ReadAt(b, off)
}
func (nativeHostRuntimeFilesystem) imports(ctx context.Context, p string) (hostMachOImports, bool, error) {
	file, before, err := hostRuntimeOpen(ctx, p)
	if err != nil {
		return hostMachOImports{}, false, err
	}
	defer file.Close()
	if !before.Mode().IsRegular() {
		return hostMachOImports{}, false, errHostRuntime
	}
	prefix := make([]byte, 4)
	n, err := file.ReadAt(prefix, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return hostMachOImports{}, false, err
	}
	macho := n == 4 && (string(prefix) == "\xcf\xfa\xed\xfe" || string(prefix) == "\xca\xfe\xba\xbe" || string(prefix) == "\xca\xfe\xba\xbf")
	var imports hostMachOImports
	if macho {
		imports, err = hostMachOImportsAt(hostRuntimeContextReaderAt{ctx, file}, before.Size())
		if err != nil {
			return imports, true, err
		}
	}
	if !macho && n >= 2 && string(prefix[:2]) == "#!" {
		imports.fileType = hostRuntimeScriptType
	}
	after, err := file.Stat()
	named, other := os.Lstat(p)
	if err != nil || other != nil || !sameHostRuntimeStat(before, after) || !sameHostRuntimeStat(after, named) || ctx.Err() != nil {
		return imports, macho, errHostRuntime
	}
	return imports, macho, nil
}

// Discovery never runs a version probe, shell startup file or installed tool.
// Missing/unqualified optional programs produce a sealed absent capability;
// callers keep the independently qualified basic Shell and File Computer.
func DiscoverInstalledHostRuntime(ctx context.Context) (*HostRuntimePlan, error) {
	return discoverHostRuntime(ctx, nativeHostRuntimeFilesystem{})
}

func (nativePlatformFacts) hostRuntime(ctx context.Context, p *HostRuntimePlan) error {
	return p.recheck(ctx, nativeHostRuntimeFilesystem{})
}
func (darwinLaunchFilesystem) checkHostRuntime(ctx context.Context, p *HostRuntimePlan) error {
	return p.recheck(ctx, nativeHostRuntimeFilesystem{})
}
