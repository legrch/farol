package helperroutes

import (
	"context"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const directoryFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC

type fingerprint struct {
	device, inode  uint64
	mode, uid, gid uint32
}

func (p fingerprint) identity() Identity {
	return Identity{Device: strconv.FormatUint(p.device, 10), Inode: strconv.FormatUint(p.inode, 10)}
}

type role uint8

const (
	ancestor role = iota
	home
	owned
	state
	sharedRoot
	sharedApplications
)

func (p fingerprint) permitted(r role) error {
	if p.mode&unix.S_IFMT != unix.S_IFDIR {
		return failure(CodeType, false, nil)
	}
	uid := uint32(unix.Geteuid())
	ownerOK := p.uid == uid
	switch r {
	case ancestor:
		ownerOK = p.uid == 0 || p.uid == uid
	case sharedRoot, sharedApplications:
		ownerOK = p.uid == 0
	}
	if !ownerOK {
		return failure(CodeOwner, false, nil)
	}
	modeOK := p.mode&0022 == 0
	if r == state {
		modeOK = p.mode&0077 == 0
	}
	if r == sharedApplications {
		modeOK = p.mode&0002 == 0 && (p.mode&0020 == 0 || p.gid == 80)
	}
	if !modeOK {
		return failure(CodeMode, false, nil)
	}
	return nil
}

// All injection is private to package tests. The production constructor fixes
// the physical root to /; there is no runtime alternate root or policy flag.
type filesystem struct {
	rootOpen func() (int, error)
	rootStat func(*unix.Stat_t) error
	openat   func(int, string, int, uint32) (int, error)
	fstat    func(int, *unix.Stat_t) error
	statat   func(int, string, *unix.Stat_t, int) error
	close    func(*os.File) error
}

func nativeFilesystem() filesystem {
	return filesystem{
		rootOpen: func() (int, error) { return unix.Open("/", directoryFlags, 0) },
		rootStat: func(s *unix.Stat_t) error { return unix.Fstatat(unix.AT_FDCWD, "/", s, unix.AT_SYMLINK_NOFOLLOW) },
		openat:   unix.Openat, fstat: unix.Fstat, statat: unix.Fstatat, close: (*os.File).Close,
	}
}

type node struct {
	file   *os.File
	fd     int
	parent int // -1 is the physical root, opened independently for each root role.
	name   string
	role   role
	pin    fingerprint
}

func syscallFailure(err error, opening bool) error {
	if err == nil {
		return nil
	}
	if err == unix.ENOENT {
		code := CodeMissing
		if opening {
			code = CodeChanged
		}
		return failure(code, true, err)
	}
	if err == unix.ELOOP || err == unix.ENOTDIR {
		code := CodeType
		if opening {
			code = CodeChanged
		}
		return failure(code, true, err)
	}
	return failure(CodeNative, true, err)
}

func (o *owner) named(ctx context.Context, parent int, name string) (fingerprint, error) {
	if err := contextFailure(ctx); err != nil {
		return fingerprint{}, err
	}
	var s unix.Stat_t
	var err error
	if parent < 0 {
		err = o.fs.rootStat(&s)
	} else {
		err = o.fs.statat(o.nodes[parent].fd, name, &s, unix.AT_SYMLINK_NOFOLLOW)
	}
	return metadata(s), combine(syscallFailure(err, false), contextFailure(ctx))
}

func (o *owner) held(ctx context.Context, n node) (fingerprint, error) {
	if err := contextFailure(ctx); err != nil {
		return fingerprint{}, err
	}
	var s unix.Stat_t
	err := o.fs.fstat(n.fd, &s)
	return metadata(s), combine(syscallFailure(err, false), contextFailure(ctx))
}

func (o *owner) add(ctx context.Context, parent int, name string, r role) (int, error) {
	before, err := o.named(ctx, parent, name)
	if err != nil {
		return -1, err
	}
	if err := before.permitted(r); err != nil {
		return -1, err
	}
	if err := contextFailure(ctx); err != nil {
		return -1, err
	}
	var fd int
	if parent < 0 {
		fd, err = o.fs.rootOpen()
	} else {
		fd, err = o.fs.openat(o.nodes[parent].fd, name, directoryFlags, 0)
	}
	if err != nil {
		return -1, combine(syscallFailure(err, true), contextFailure(ctx))
	}
	index := len(o.nodes)
	o.nodes = append(o.nodes, node{file: os.NewFile(uintptr(fd), name), fd: fd, parent: parent, name: name, role: r, pin: before})
	if err := contextFailure(ctx); err != nil {
		return -1, err
	}
	after, err := o.held(ctx, o.nodes[index])
	if err != nil {
		return -1, err
	}
	current, err := o.named(ctx, parent, name)
	if err != nil {
		return -1, err
	}
	if before != after || before != current {
		return -1, failure(CodeChanged, false, nil)
	}
	return index, nil
}

func (o *owner) open(ctx context.Context, homePath, op string) error {
	current, err := o.add(ctx, -1, "/", ancestor)
	if err != nil {
		return err
	}
	parts := strings.Split(homePath[1:], "/")
	for i, part := range parts {
		r := ancestor
		if i == len(parts)-1 {
			r = home
		}
		current, err = o.add(ctx, current, part, r)
		if err != nil {
			return err
		}
	}
	o.home = current
	appParent, appRole := current, owned
	if o.shared {
		appParent, err = o.add(ctx, -1, "/", sharedRoot)
		if err != nil {
			return err
		}
		appRole = sharedApplications
	}
	o.apps, err = o.add(ctx, appParent, "Applications", appRole)
	if err != nil {
		return err
	}
	current = o.home
	for _, part := range []string{"Library", "Application Support", "Farol Next Preview"} {
		current, err = o.add(ctx, current, part, owned)
		if err != nil {
			return err
		}
	}
	o.state, err = o.add(ctx, current, "farol-next-state", state)
	if err != nil {
		return err
	}
	o.update, err = o.add(ctx, current, "installed-updates", owned)
	if err != nil {
		return err
	}
	o.operation, err = o.add(ctx, o.update, op, owned)
	return err
}

func (o *owner) check(ctx context.Context, n node) error {
	held, err := o.held(ctx, n)
	if err != nil {
		return err
	}
	named, err := o.named(ctx, n.parent, n.name)
	if err != nil {
		return err
	}
	if held != n.pin || named != n.pin {
		return failure(CodeChanged, false, nil)
	}
	return nil
}

func (o *owner) verify(ctx context.Context) (result error) {
	if err := contextFailure(ctx); err != nil {
		return err
	}
	fresh := &owner{fs: o.fs}
	defer func() { result = combine(combine(result, fresh.cleanup()), contextFailure(ctx)) }()
	for _, n := range o.nodes {
		if err := o.check(ctx, n); err != nil {
			return err
		}
		i, err := fresh.add(ctx, n.parent, n.name, n.role)
		if err != nil {
			return err
		}
		if fresh.nodes[i].pin != n.pin {
			return failure(CodeChanged, false, nil)
		}
	}
	// Retain the entire fresh and original graphs through the final comparisons.
	// Pins omit content metadata, and held references prevent inode recycling.
	for i, n := range o.nodes {
		if err := fresh.check(ctx, fresh.nodes[i]); err != nil {
			return err
		}
		if err := o.check(ctx, n); err != nil {
			return err
		}
	}
	return contextFailure(ctx)
}
