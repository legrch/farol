package filesystem

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Mutable is an independent native producer. Its private syscall seam exists
// only for hermetic package tests; production always selects the platform adapter.
type Mutable struct {
	filePolicy authority.FilePolicy
	home       string
	fs         mutationFS
}

func NewMutable(trustedHome string) *Mutable {
	return &Mutable{home: trustedHome, fs: nativeMutationFS()}
}

// NewMutableWithFilePolicy pairs with NewWithFilePolicy at the SAME trusted
// composition boundary. It changes filename semantics, never the publication
// guard, expected digest, descriptor validation or native transaction protocol.
func NewMutableWithFilePolicy(trustedHome string, selected authority.FilePolicy) (*Mutable, error) {
	if _, err := NewWithFilePolicy(trustedHome, selected); err != nil {
		return nil, err
	}
	return &Mutable{home: trustedHome, filePolicy: selected, fs: nativeMutationFS()}, nil
}

var _ port.MutableWorkspace = (*Mutable)(nil)

type fileVersion struct {
	dev, ino           uint64
	mode, uid          uint32
	links              uint64
	size, mtime, ctime int64
}

func (v fileVersion) inode(w fileVersion) bool { return v.dev == w.dev && v.ino == w.ino }
func (v fileVersion) regular() bool            { return v.mode&unix.S_IFMT == unix.S_IFREG && v.links == 1 }
func (v fileVersion) candidate(w fileVersion) bool {
	return v.inode(w) && v.mode == w.mode && v.size == w.size && v.mtime == w.mtime && v.uid == w.uid
}

// Effect calls are synchronous single attempts. Read/write may transfer bounded
// chunks, never replay publication. No recursive removal or ordinary rename.
type mutationFS interface {
	root() (int, error)
	open(int, string, int, uint32) (int, error)
	close(int)
	stat(int) (fileVersion, error)
	lstat(int, string) (fileVersion, error)
	read(int, int) ([]byte, error)
	write(int, []byte) error
	chmod(int, uint32) error
	sync(int) error
	mkdir(int, string, uint32) error
	link(int, string, int, string) error
	swap(int, string, int, string) error
	unlink(int, string, bool) error
	uid() uint32
	name() (string, error)
}
type directoryPin struct {
	parent, fd int
	name       string
	version    fileVersion
}
type mutationWalk struct {
	fs   mutationFS
	pins []directoryPin
}

func (w *mutationWalk) close() {
	for i := len(w.pins) - 1; i >= 0; i-- {
		w.fs.close(w.pins[i].fd)
	}
}
func (w *mutationWalk) add(parent int, name string) (int, error) {
	fd, err := w.fs.open(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		// ENOTDIR can name a refused symlink on macOS, not an absent directory.
		if v, lookupErr := w.fs.lstat(parent, name); lookupErr == nil && v.mode&unix.S_IFMT == unix.S_IFLNK {
			return -1, refusal("WORKSPACE_PATH_REFUSED")
		}
		return -1, openError(err)
	}
	v, err := w.fs.stat(fd)
	if err != nil || v.mode&unix.S_IFMT != unix.S_IFDIR {
		w.fs.close(fd)
		return -1, refusal("WORKSPACE_PATH_REFUSED")
	}
	w.pins = append(w.pins, directoryPin{parent: parent, fd: fd, name: name, version: v})
	return fd, nil
}
func (w *mutationWalk) check() error {
	for _, p := range w.pins {
		v, err := w.fs.stat(p.fd)
		if err != nil || !v.inode(p.version) || v.mode != p.version.mode || v.uid != p.version.uid {
			return refusal("WORKSPACE_ROOT_CHANGED")
		}
		if p.name != "" {
			v, err = w.fs.lstat(p.parent, p.name)
			if err != nil || !v.inode(p.version) || v.mode&unix.S_IFMT != unix.S_IFDIR {
				return refusal("WORKSPACE_ROOT_CHANGED")
			}
		}
	}
	return nil
}
func (m *Mutable) root(d port.MutationDescriptor) (*mutationWalk, int, error) {
	parts, err := components(d.Root, true, false)
	if err != nil {
		return nil, -1, err
	}
	approved, err := components(d.ApprovedRoot.Path, true, false)
	if err != nil || len(approved) > len(parts) {
		return nil, -1, refusal("WORKSPACE_INVALID_REQUEST")
	}
	for i, p := range approved {
		if p != parts[i] {
			return nil, -1, refusal("WORKSPACE_INVALID_REQUEST")
		}
	}
	parse := func(s string) (uint64, error) {
		if len(s) == 0 || len(s) > 20 {
			return 0, errors.New("invalid identity")
		}
		for _, r := range s {
			if r < '0' || r > '9' {
				return 0, errors.New("invalid identity")
			}
		}
		return strconv.ParseUint(s, 10, 64)
	}
	dev, e1 := parse(d.ApprovedRoot.Device)
	ino, e2 := parse(d.ApprovedRoot.Inode)
	if e1 != nil || e2 != nil {
		return nil, -1, refusal("WORKSPACE_INVALID_REQUEST")
	}
	fd, err := m.fs.root()
	if err != nil {
		return nil, -1, openError(err)
	}
	version, err := m.fs.stat(fd)
	if err != nil {
		m.fs.close(fd)
		return nil, -1, refusal("WORKSPACE_ROOT_CHANGED")
	}
	walk := &mutationWalk{fs: m.fs, pins: []directoryPin{{fd: fd, parent: -1, version: version}}}
	for i, part := range parts {
		fd, err = walk.add(fd, part)
		if err != nil {
			walk.close()
			return nil, -1, err
		}
		v := walk.pins[len(walk.pins)-1].version
		if i == len(approved)-1 && (v.dev != dev || v.ino != ino) {
			walk.close()
			return nil, -1, refusal("WORKSPACE_ROOT_CHANGED")
		}
	}
	v := walk.pins[len(walk.pins)-1].version
	if v.uid != m.fs.uid() || v.mode&0022 != 0 {
		walk.close()
		return nil, -1, refusal("WORKSPACE_PATH_REFUSED")
	}
	return walk, fd, nil
}
func checkMutation(ctx context.Context, request port.MutationRequest, walk *mutationWalk) error {
	if ctx == nil || ctx.Err() != nil {
		return refusal("WORKSPACE_MUTATION_CANCELLED")
	}
	if request.BeforePublish == nil || request.WithPublication == nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	if err := request.BeforePublish(ctx); err != nil {
		return err
	}
	return walk.check()
}
func mutationError(code string) error { return refusal("WORKSPACE_" + code) }
func expectedHash(op mutation.Operation) *string {
	switch v := op.(type) {
	case mutation.Write:
		return v.ExpectedSHA256
	case mutation.Edit:
		hash := v.ExpectedSHA256
		return &hash
	}
	return nil
}
func (m *Mutable) policy(d port.MutationDescriptor, path string) error {
	denied := append(append([]string{}, d.DeniedPaths...), d.WriteDeniedPaths...)
	p, err := (&Workspace{homeDirectory: m.home, filePolicy: m.filePolicy}).parsePolicy(port.Descriptor{FilePolicy: d.FilePolicy, Root: d.Root, DeniedPaths: denied})
	if err != nil {
		return err
	}
	parts, err := components(path, false, false)
	if err != nil {
		return err
	}
	if p.denies(parts) {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	// Legacy callers retain their explicit Git-metadata boundary. The new root
	// policy allows ordinary named files; authority/publication guards still apply.
	for _, part := range parts {
		if m.filePolicy == authority.LegacyProtectedFiles && strings.EqualFold(part, ".git") {
			return refusal("WORKSPACE_PATH_REFUSED")
		}
	}
	return nil
}
