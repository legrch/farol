package apptree

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const (
	maxEntries       = 100000
	maxBytes   int64 = 1 << 30
	maxDepth         = 128
	// These additional memory refusals preserve the v2 stream for accepted trees.
	maxRetained = 64 << 20
	maxLink     = 4096
	maxDocument = 65536
	dirFlags    = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_DIRECTORY | unix.O_CLOEXEC
	fileFlags   = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
)

type fingerprint struct {
	// Access time is excluded because observing a tree may update it. Compare
	// change/modify timestamps, size and link count as well as object identity.
	device, inode                                  uint64
	mode, uid, gid                                 uint32
	links                                          uint64
	size, mtimeSec, mtimeNano, ctimeSec, ctimeNano int64
}

func (s fingerprint) kind() byte {
	switch s.mode & unix.S_IFMT {
	case unix.S_IFDIR:
		return 'd'
	case unix.S_IFREG:
		return 'f'
	case unix.S_IFLNK:
		return 'l'
	}
	return 0
}
func (s fingerprint) safeDir() bool {
	return s.kind() == 'd' && s.uid == uint32(unix.Geteuid()) && s.mode&0022 == 0
}
func (s fingerprint) identity() ObjectIdentity {
	return ObjectIdentity{strconv.FormatUint(s.device, 10), strconv.FormatUint(s.inode, 10), s.mode, s.uid, s.gid}
}
func held(ctx context.Context, fd int) (fingerprint, error) {
	if e := canceled(ctx); e != nil {
		return fingerprint{}, e
	}
	var s unix.Stat_t
	if unix.Fstat(fd, &s) != nil {
		return fingerprint{}, refuse(CodeIO)
	}
	if e := canceled(ctx); e != nil {
		return fingerprint{}, e
	}
	return metadata(s), nil
}
func named(ctx context.Context, fd int, name string) (fingerprint, error) {
	if e := canceled(ctx); e != nil {
		return fingerprint{}, e
	}
	var s unix.Stat_t
	if unix.Fstatat(fd, name, &s, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return fingerprint{}, refuse(CodeIO)
	}
	if e := canceled(ctx); e != nil {
		return fingerprint{}, e
	}
	return metadata(s), nil
}
func check(ctx context.Context, parent int, name string, fd int, want fingerprint) error {
	n, e := named(ctx, parent, name)
	if e != nil {
		return e
	}
	if n != want {
		return refuse(CodeChanged)
	}
	if fd >= 0 {
		h, e := held(ctx, fd)
		if e != nil {
			return e
		}
		if h != want {
			return refuse(CodeChanged)
		}
	}
	return nil
}
func openDir(ctx context.Context, parent int, name string, want fingerprint) (int, error) {
	return openDirOwned(ctx, parent, name, want, cleanup{})
}
func openDirOwned(ctx context.Context, parent int, name string, want fingerprint, owner cleanup) (int, error) {
	if !want.safeDir() {
		return -1, refuse(CodeType)
	}
	if e := canceled(ctx); e != nil {
		return -1, e
	}
	fd, e := unix.Openat(parent, name, dirFlags, 0)
	if e != nil {
		return -1, refuse(CodeIO)
	}
	if e = check(ctx, parent, name, fd, want); e != nil {
		return -1, finishCleanup(ctx, e, owner.fd(fd))
	}
	return fd, nil
}

type entry struct {
	stat fingerprint
	link string
}
type inventory struct {
	entries         map[string]entry
	count, retained int
	bytes           int64
	digest          hash.Hash
	buffer          []byte
	cleanup         cleanup
}

func (s *inventory) retain(n int) error {
	if n > maxRetained-s.retained {
		return refuse(CodeLimit)
	}
	s.retained += n
	return nil
}
func put32(h hash.Hash, n int) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], uint32(n))
	h.Write(b[:])
}
func utf16Less(a, b string) bool {
	// No normalization or case folding. Unicode scalar order differs from UTF16
	// code-unit order for supplementary characters versus upper BMP characters.
	aa, bb := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(aa) && i < len(bb); i++ {
		if aa[i] != bb[i] {
			return aa[i] < bb[i]
		}
	}
	return len(aa) < len(bb)
}
func names(ctx context.Context, fd int, remaining int) ([]string, error) {
	return namesOwned(ctx, fd, remaining, cleanup{})
}
func namesOwned(ctx context.Context, fd int, remaining int, owner cleanup) (result []string, failure error) {
	// fd is a private independently opened directory description. NewFile owns it.
	f := os.NewFile(uintptr(fd), "")
	if f == nil {
		return nil, finishCleanup(ctx, refuse(CodeIO), owner.fd(fd))
	}
	defer func() {
		failure = finishCleanup(ctx, failure, owner.file(f))
		if failure != nil {
			result = nil
		}
	}()
	var all []string
	for {
		if e := canceled(ctx); e != nil {
			return nil, e
		}
		batch, e := f.Readdirnames(128)
		for _, n := range batch {
			if !component(n) {
				return nil, refuse(CodeName)
			}
		}
		if len(batch) > remaining-len(all) {
			return nil, refuse(CodeLimit)
		}
		all = append(all, batch...)
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, refuse(CodeIO)
		}
	}
	if e := canceled(ctx); e != nil {
		return nil, e
	}
	sort.Slice(all, func(i, j int) bool { return utf16Less(all[i], all[j]) })
	return all, canceled(ctx)
}
func list(ctx context.Context, fd int, remaining int) ([]string, error) {
	return listOwned(ctx, fd, remaining, cleanup{})
}
func listOwned(ctx context.Context, fd int, remaining int, owner cleanup) ([]string, error) {
	// A dup would share offsets. Reopen dot physically and own only the new fd.
	own, e := unix.Openat(fd, ".", dirFlags, 0)
	if e != nil {
		return nil, refuse(CodeIO)
	}
	return namesOwned(ctx, own, remaining, owner)
}
func readLink(ctx context.Context, fd int, name string) (string, error) {
	if e := canceled(ctx); e != nil {
		return "", e
	}
	var buf [maxLink + 1]byte
	n, e := unix.Readlinkat(fd, name, buf[:])
	if e != nil {
		return "", refuse(CodeIO)
	}
	target, err := linkText(buf[:n])
	if err != nil {
		return "", err
	}
	return target, canceled(ctx)
}
func linkText(raw []byte) (string, error) {
	if len(raw) > maxLink {
		return "", refuse(CodeLimit)
	}
	target := string(raw)
	if len(raw) == 0 || !utf8.ValidString(target) || strings.IndexByte(target, 0) >= 0 || target[0] == '/' {
		return "", refuse(CodeLink)
	}
	return target, nil
}
func (s *inventory) walk(ctx context.Context, fd int, prefix string, depth int, again bool) error {
	if depth > maxDepth {
		return refuse(CodeLimit)
	}
	remaining := maxEntries - s.count
	children, e := listOwned(ctx, fd, remaining, s.cleanup)
	if e != nil {
		return e
	}
	// Reserve every enumerated name before descending. Otherwise each ancestor
	// could retain a full maxEntries batch while only one child had been counted.
	// All live sibling lists together are therefore bounded by maxEntries too.
	s.count += len(children)
	for _, name := range children {
		if e = canceled(ctx); e != nil {
			return e
		}
		path := name
		if prefix != "" {
			path = prefix + "/" + name
		}
		st, e := named(ctx, fd, name)
		if e != nil {
			return e
		}
		if st.kind() == 0 {
			return refuse(CodeType)
		}
		var rec entry
		if again {
			var ok bool
			rec, ok = s.entries[path]
			if !ok || rec.stat != st {
				return refuse(CodeChanged)
			}
		} else {
			if e = s.retain(len(path)); e != nil {
				return e
			}
			rec = entry{stat: st}
			raw := []byte(path)
			put32(s.digest, len(raw))
			s.digest.Write(raw)
			s.digest.Write([]byte{st.kind()})
			put32(s.digest, int(st.mode&07777))
		}
		switch st.kind() {
		case 'd':
			child, e := openDirOwned(ctx, fd, name, st, s.cleanup)
			if e != nil {
				return e
			}
			e = s.walk(ctx, child, path, depth+1, again)
			if e == nil {
				e = check(ctx, fd, name, child, st)
			}
			e = finishCleanup(ctx, e, s.cleanup.fd(child))
			if e != nil {
				return e
			}
		case 'l':
			target, e := readLink(ctx, fd, name)
			if e != nil {
				return e
			}
			if again {
				if target != rec.link {
					return refuse(CodeChanged)
				}
			} else {
				if e = s.retain(len(target)); e != nil {
					return e
				}
				rec.link = target
				put32(s.digest, len(target))
				s.digest.Write([]byte(target))
			}
			if e = check(ctx, fd, name, -1, st); e != nil {
				return e
			}
		case 'f':
			if st.links != 1 {
				return refuse(CodeType)
			}
			if st.size < 0 || st.size > maxBytes-s.bytes {
				return refuse(CodeLimit)
			}
			s.bytes += st.size
			if !again {
				sum, e := s.read(ctx, fd, name, st, nil)
				if e != nil {
					return e
				}
				s.digest.Write(sum)
			}
		}
		if !again {
			s.entries[path] = rec
		}
	}
	return canceled(ctx)
}
func (s *inventory) read(ctx context.Context, parent int, name string, want fingerprint, document *[]byte) (result []byte, failure error) {
	if want.kind() != 'f' || want.links != 1 {
		return nil, refuse(CodeType)
	}
	if document != nil && (want.uid != uint32(unix.Geteuid()) || want.size < 1 || want.size > maxDocument) {
		return nil, refuse(CodeIdentity)
	}
	if e := canceled(ctx); e != nil {
		return nil, e
	}
	fd, e := unix.Openat(parent, name, fileFlags, 0)
	if e != nil {
		return nil, refuse(CodeIO)
	}
	defer func() {
		failure = finishCleanup(ctx, failure, s.cleanup.fd(fd))
		if failure != nil {
			result = nil
		}
	}()
	if e = check(ctx, parent, name, fd, want); e != nil {
		return nil, e
	}
	h := sha256.New()
	var size int64
	for {
		if e = canceled(ctx); e != nil {
			return nil, e
		}
		n, err := unix.Read(fd, s.buffer)
		if n > 0 {
			size += int64(n)
			if size > want.size {
				return nil, refuse(CodeChanged)
			}
			h.Write(s.buffer[:n])
			if document != nil {
				*document = append(*document, s.buffer[:n]...)
			}
		}
		if err != nil {
			return nil, refuse(CodeIO)
		}
		if n == 0 {
			break
		}
	}
	if size != want.size {
		return nil, refuse(CodeChanged)
	}
	if e = check(ctx, parent, name, fd, want); e != nil {
		return nil, e
	}
	return h.Sum(nil), nil
}
func (s *inventory) document(ctx context.Context, root int, path string) (result []byte, failure error) {
	parts := strings.Split(path, "/")
	parent := root
	defer func() {
		if parent != root {
			failure = finishCleanup(ctx, failure, s.cleanup.fd(parent))
			if failure != nil {
				result = nil
			}
		}
	}()
	for i, name := range parts[:len(parts)-1] {
		key := strings.Join(parts[:i+1], "/")
		rec, ok := s.entries[key]
		if !ok {
			return nil, refuse(CodeIdentity)
		}
		next, e := openDirOwned(ctx, parent, name, rec.stat, s.cleanup)
		if e != nil {
			return nil, e
		}
		if parent != root {
			old := parent
			parent = next
			if err := finishCleanup(ctx, nil, s.cleanup.fd(old)); err != nil {
				return nil, err
			}
		} else {
			parent = next
		}
	}
	rec, ok := s.entries[path]
	if !ok {
		return nil, refuse(CodeIdentity)
	}
	var data []byte
	_, e := s.read(ctx, parent, parts[len(parts)-1], rec.stat, &data)
	return data, e
}
func (v *Verifier) verify(ctx context.Context, parent, app int) (result Observation, failure error) {
	p, e := held(ctx, parent)
	if e != nil {
		return Observation{}, e
	}
	if p.kind() != 'd' {
		return Observation{}, refuse(CodeType)
	}
	a, e := held(ctx, app)
	if e != nil {
		return Observation{}, e
	}
	root, e := openDirOwned(ctx, parent, v.leaf, a, v.cleanup)
	if e != nil {
		return Observation{}, e
	}
	defer func() {
		failure = finishCleanup(ctx, failure, v.cleanup.fd(root))
		if failure != nil {
			result = Observation{}
		}
	}()
	s := inventory{entries: make(map[string]entry), digest: sha256.New(), buffer: make([]byte, 1<<20), cleanup: v.cleanup}
	s.digest.Write([]byte("farol.tree-digest/v2\x00"))
	if e = s.walk(ctx, root, "", 0, false); e != nil {
		return Observation{}, e
	}
	if e = s.links(ctx); e != nil {
		return Observation{}, e
	}
	if hex.EncodeToString(s.digest.Sum(nil)) != v.expected.TreeSHA256 {
		return Observation{}, refuse(CodeDigest)
	}
	info, e := s.document(ctx, root, "Contents/Info.plist")
	if e != nil {
		return Observation{}, e
	}
	build, e := s.document(ctx, root, "Contents/Resources/app/build-identity.json")
	if e != nil {
		return Observation{}, e
	}
	if e = canceled(ctx); e != nil {
		return Observation{}, e
	}
	if identityErr := v.identity(ctx, info, build, v.expected.Version, v.expected.BuildID); identityErr != nil {
		if e = canceled(ctx); e != nil {
			return Observation{}, &observationFailure{refusal: &Error{Code: CodeCanceled}, cause: identityErr, cancellation: ctx.Err()}
		}
		return Observation{}, &observationFailure{refusal: &Error{Code: CodeIdentity}, cause: identityErr}
	}
	if e = canceled(ctx); e != nil {
		return Observation{}, e
	}
	s.count = 0
	s.bytes = 0
	if e = s.walk(ctx, root, "", 0, true); e != nil {
		return Observation{}, e
	}
	if s.count != len(s.entries) {
		return Observation{}, refuse(CodeChanged)
	}
	if e = check(ctx, parent, v.leaf, root, a); e != nil {
		return Observation{}, e
	}
	current, e := held(ctx, app)
	if e != nil {
		return Observation{}, e
	}
	if current != a {
		return Observation{}, refuse(CodeChanged)
	}
	current, e = held(ctx, parent)
	if e != nil {
		return Observation{}, e
	}
	if current != p {
		return Observation{}, refuse(CodeChanged)
	}
	return Observation{Root: a.identity()}, nil
}
