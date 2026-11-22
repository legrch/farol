//go:build darwin || linux

package codex

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/legrch/farol/modules/task/domain"
	"golang.org/x/sys/unix"
)

const gitMetadataMaxBytes = 4096
const gitMetadataMaxDescriptors = 1024

// gitMetadataStamp excludes access time: reading a file can change it. Change
// time, modification time, ownership, link count and identity remain binding.
type gitMetadataStamp struct {
	device, inode, links uint64
	size                 int64
	mode, uid, gid       uint32
	modified, changed    unix.Timespec
}

func gitMetadataIdentity(s unix.Stat_t) gitMetadataStamp {
	return gitMetadataStamp{uint64(s.Dev), uint64(s.Ino), uint64(s.Nlink), s.Size, uint32(s.Mode), s.Uid, s.Gid, s.Mtim, s.Ctim}
}

type gitMetadataHeld struct {
	file      *os.File
	parent    *gitMetadataHeld
	name      string
	stamp     gitMetadataStamp
	data      []byte // nil for directories; metadata files are always nonempty
	directory bool
}

func (h *gitMetadataHeld) matches(s unix.Stat_t) bool {
	got := gitMetadataIdentity(s)
	if h.directory {
		// Unrelated entries can change ancestor directory times and link counts.
		// Their selected names, physical identities, modes and owners stay fixed.
		return got.device == h.stamp.device && got.inode == h.stamp.inode && got.mode == h.stamp.mode && got.uid == h.stamp.uid && got.gid == h.stamp.gid
	}
	return got == h.stamp
}

type gitMetadataAbsent struct {
	parent *gitMetadataHeld
	name   string
}

// One read owns every descriptor until the final identity/content recheck.
// There is no process, Git configuration, environment lookup or repository
// discovery. Only explicitly selected normal and linked worktrees are supported.
type gitMetadataReader struct {
	ctx    context.Context
	dirs   map[string]*gitMetadataHeld
	held   []*gitMetadataHeld
	absent []gitMetadataAbsent
	closed bool
}

func newGitMetadataReader(ctx context.Context) *gitMetadataReader {
	return &gitMetadataReader{ctx: ctx, dirs: make(map[string]*gitMetadataHeld)}
}

func (r *gitMetadataReader) check() error {
	if r == nil || r.ctx == nil || r.closed {
		return task.ErrIdentity
	}
	return r.ctx.Err()
}

func (r *gitMetadataReader) close() {
	for n := len(r.held) - 1; n >= 0; n-- {
		_ = r.held[n].file.Close()
	}
	r.closed = true
}

func (r *gitMetadataReader) hold(fd int, parent *gitMetadataHeld, name string, directory bool) (*gitMetadataHeld, error) {
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		_ = unix.Close(fd)
		return nil, task.ErrIdentity
	}
	var s unix.Stat_t
	if unix.Fstat(fd, &s) != nil || (directory && s.Mode&unix.S_IFMT != unix.S_IFDIR) ||
		(!directory && (s.Mode&unix.S_IFMT != unix.S_IFREG || s.Nlink != 1 || s.Size <= 0 || s.Size > gitMetadataMaxBytes)) {
		_ = f.Close()
		return nil, task.ErrIdentity
	}
	h := &gitMetadataHeld{file: f, parent: parent, name: name, stamp: gitMetadataIdentity(s), directory: directory}
	r.held = append(r.held, h)
	return h, nil
}

func (r *gitMetadataReader) directory(path string) (*gitMetadataHeld, error) {
	if err := r.check(); err != nil {
		return nil, err
	}
	if path != "/" && !canonical(path) {
		return nil, task.ErrIdentity
	}
	if held := r.dirs[path]; held != nil {
		return held, nil
	}
	if len(r.held) >= gitMetadataMaxDescriptors {
		return nil, task.ErrIdentity
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	if path == "/" {
		fd, err := unix.Open("/", flags, 0)
		if err != nil {
			return nil, task.ErrIdentity
		}
		h, err := r.hold(fd, nil, "/", true)
		if err == nil {
			r.dirs[path] = h
		}
		return h, err
	}
	parent, err := r.directory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if len(r.held) >= gitMetadataMaxDescriptors {
		return nil, task.ErrIdentity
	}
	fd, err := unix.Openat(int(parent.file.Fd()), filepath.Base(path), flags, 0)
	if err != nil {
		return nil, task.ErrIdentity
	}
	h, err := r.hold(fd, parent, filepath.Base(path), true)
	if err == nil {
		r.dirs[path] = h
	}
	return h, err
}

func (r *gitMetadataReader) read(path string) ([]byte, error) {
	parent, err := r.directory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if err := r.check(); err != nil {
		return nil, err
	}
	if !canonical(path) || len(r.held) >= gitMetadataMaxDescriptors {
		return nil, task.ErrIdentity
	}
	fd, err := unix.Openat(int(parent.file.Fd()), filepath.Base(path), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, task.ErrIdentity
	}
	h, err := r.hold(fd, parent, filepath.Base(path), false)
	if err != nil {
		return nil, err
	}
	data, err := r.bytes(h)
	if err != nil {
		return nil, err
	}
	h.data = data
	return data, nil
}

func (r *gitMetadataReader) bytes(h *gitMetadataHeld) ([]byte, error) {
	if err := r.check(); err != nil {
		return nil, err
	}
	var before, after unix.Stat_t
	if unix.Fstat(int(h.file.Fd()), &before) != nil || gitMetadataIdentity(before) != h.stamp {
		return nil, task.ErrIdentity
	}
	data := make([]byte, int(h.stamp.size)+1)
	n, err := h.file.ReadAt(data, 0)
	if n != int(h.stamp.size) || err != io.EOF || unix.Fstat(int(h.file.Fd()), &after) != nil || gitMetadataIdentity(after) != h.stamp {
		return nil, task.ErrIdentity
	}
	if err := r.check(); err != nil {
		return nil, err
	}
	return data[:n], nil
}

func gitMetadataLine(data []byte) (string, error) {
	line := strings.TrimSuffix(string(data), "\n")
	if line == "" || strings.TrimSpace(line) != line || strings.ContainsAny(line, "\x00\r\n\t\\") {
		return "", task.ErrIdentity
	}
	return line, nil
}

func gitMetadataTarget(base, line string) (string, error) {
	if line == "" || len(line) > gitMetadataMaxBytes || strings.TrimSpace(line) != line {
		return "", task.ErrIdentity
	}
	target := line
	// Only leading parent traversals are supported. Cleaning an arbitrary
	// component/.. could otherwise erase a symlink that Git would traverse.
	if filepath.IsAbs(line) {
		if filepath.Clean(line) != line {
			return "", task.ErrIdentity
		}
	} else {
		parts := strings.Split(line, "/")
		leading := true
		for _, part := range parts {
			if part == ".." && leading {
				continue
			}
			leading = false
			if part == "" || part == "." || part == ".." {
				return "", task.ErrIdentity
			}
		}
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(base, target)
	}
	target = filepath.Clean(target)
	if !canonical(target) {
		return "", task.ErrIdentity
	}
	return target, nil
}

func (r *gitMetadataReader) pointer(path string) (string, error) {
	data, err := r.read(path)
	if err != nil {
		return "", err
	}
	line, err := gitMetadataLine(data)
	if err != nil {
		return "", err
	}
	return gitMetadataTarget(filepath.Dir(path), line)
}

// Validate the HEAD marker, without resolving a ref or reading a commit. Unborn
// repositories are supported. Other Git layouts/formats remain unsupported.
func (r *gitMetadataReader) head(directory string) error {
	data, err := r.read(filepath.Join(directory, "HEAD"))
	if err != nil {
		return err
	}
	line, err := gitMetadataLine(data)
	if err != nil {
		return err
	}
	if strings.HasPrefix(line, "ref: refs/") {
		name := strings.TrimPrefix(line, "ref: ")
		for _, part := range strings.Split(name, "/") {
			if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, ".lock") || strings.Contains(part, "..") {
				return task.ErrIdentity
			}
			for _, c := range part {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._-", c)) {
					return task.ErrIdentity
				}
			}
		}
		return nil
	}
	if len(line) != 40 && len(line) != 64 {
		return task.ErrIdentity
	}
	for _, c := range line {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return task.ErrIdentity
		}
	}
	return nil
}

func (r *gitMetadataReader) resolve(root task.Root) (string, error) {
	if err := r.check(); err != nil {
		return "", err
	}
	if !canonical(root.Path) || !canonical(root.GitCommonDirectory) {
		return "", task.ErrIdentity
	}
	worktree, err := r.directory(root.Path)
	if err != nil {
		return "", err
	}
	if strconv.FormatUint(worktree.stamp.device, 10) != root.Device || strconv.FormatUint(worktree.stamp.inode, 10) != root.Inode {
		return "", task.ErrIdentity
	}
	dot := filepath.Join(root.Path, ".git")
	var s unix.Stat_t
	if unix.Fstatat(int(worktree.file.Fd()), ".git", &s, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return "", task.ErrIdentity
	}
	common := root.GitCommonDirectory
	switch s.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		if dot != common {
			return "", task.ErrIdentity
		}
	case unix.S_IFREG:
		data, err := r.read(dot)
		if err != nil {
			return "", err
		}
		line, err := gitMetadataLine(data)
		if err != nil || !strings.HasPrefix(line, "gitdir: ") {
			return "", task.ErrIdentity
		}
		admin, err := gitMetadataTarget(root.Path, strings.TrimPrefix(line, "gitdir: "))
		if err != nil || filepath.Dir(admin) != filepath.Join(common, "worktrees") {
			return "", task.ErrIdentity
		}
		resolved, err := r.pointer(filepath.Join(admin, "commondir"))
		if err != nil {
			return "", err
		}
		if resolved != common {
			return "", task.ErrIdentity
		}
		backlink, err := r.pointer(filepath.Join(admin, "gitdir"))
		if err != nil {
			return "", err
		}
		if backlink != dot {
			return "", task.ErrIdentity
		}
		if err := r.head(admin); err != nil {
			return "", err
		}
	default:
		return "", task.ErrIdentity
	}
	for _, directory := range []string{common, filepath.Join(common, "objects"), filepath.Join(common, "refs")} {
		if _, err := r.directory(directory); err != nil {
			return "", err
		}
	}
	// A common directory redirect would change Git's own common-dir answer.
	// This supported topology ends at the explicitly selected common directory.
	parent := r.dirs[common]
	var redirect unix.Stat_t
	if err := unix.Fstatat(int(parent.file.Fd()), "commondir", &redirect, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
		return "", task.ErrIdentity
	}
	r.absent = append(r.absent, gitMetadataAbsent{parent, "commondir"})
	if err := r.head(common); err != nil {
		return "", err
	}
	return common, nil
}

func (r *gitMetadataReader) unchanged(held *gitMetadataHeld) error {
	if err := r.check(); err != nil {
		return err
	}
	var opened, named unix.Stat_t
	if unix.Fstat(int(held.file.Fd()), &opened) != nil || !held.matches(opened) {
		return task.ErrIdentity
	}
	if held.parent != nil && (unix.Fstatat(int(held.parent.file.Fd()), held.name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !held.matches(named)) {
		return task.ErrIdentity
	}
	return nil
}

func (r *gitMetadataReader) verify() error {
	if err := r.check(); err != nil {
		return err
	}
	for _, held := range r.held {
		if err := r.unchanged(held); err != nil {
			return err
		}
		if held.data != nil {
			current, err := r.bytes(held)
			if err != nil {
				return err
			}
			if !bytes.Equal(current, held.data) {
				return task.ErrIdentity
			}
		}
	}
	for _, absent := range r.absent {
		if err := r.check(); err != nil {
			return err
		}
		var s unix.Stat_t
		if err := unix.Fstatat(int(absent.parent.file.Fd()), absent.name, &s, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
			return task.ErrIdentity
		}
	}
	// Recheck the held directory names after the metadata reads, from leaves
	// back to /. Descriptor reads alone cannot detect a renamed ancestor.
	for n := len(r.held) - 1; n >= 0; n-- {
		if r.held[n].directory {
			if err := r.unchanged(r.held[n]); err != nil {
				return err
			}
		}
	}
	return r.check()
}

func gitCommon(ctx context.Context, root task.Root) (string, error) {
	r := newGitMetadataReader(ctx)
	defer r.close()
	common, err := r.resolve(root)
	if err != nil {
		return "", err
	}
	if err := r.verify(); err != nil {
		return "", err
	}
	return common, nil
}
