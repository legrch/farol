//go:build linux || darwin

package installcopy

import (
	"context"
	"errors"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const (
	maxEntries = 100000
	maxBytes   = int64(1 << 30)
	maxDepth   = 128
	maxLink    = 4096
	dirFlags   = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	readFlags  = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	writeFlags = unix.O_WRONLY | unix.O_CREAT | unix.O_EXCL | unix.O_NOFOLLOW | unix.O_CLOEXEC
)

type fingerprint struct {
	device, inode                                  uint64
	mode, uid, gid                                 uint32
	links                                          uint64
	size, mtimeSec, mtimeNano, ctimeSec, ctimeNano int64
}

type rootPins struct{ source, destination fingerprint }

func (s fingerprint) identity() Identity {
	return Identity{strconv.FormatUint(s.device, 10), strconv.FormatUint(s.inode, 10)}
}
func (s fingerprint) kind() uint32 { return s.mode & unix.S_IFMT }
func (s fingerprint) safeDir() bool {
	return s.kind() == unix.S_IFDIR && s.uid == uint32(os.Geteuid()) && s.mode&0022 == 0
}
func (s fingerprint) privateDir() bool { return s.safeDir() && s.mode&07777 == 0700 }
func (s fingerprint) createdDir() bool {
	// mkdir's requested 0700 may be restricted by the caller's umask. The
	// top-level destination is separately required to be exactly 0700.
	return s.safeDir() && s.mode&07077 == 0
}
func (s fingerprint) sameObject(t fingerprint) bool {
	return s.device == t.device && s.inode == t.inode && s.mode == t.mode && s.uid == t.uid && s.gid == t.gid
}

// limits and hooks are private test seams. The exported Run always uses the
// production bounds and real syscalls; there is no configurable cap or I/O port.
type limits struct {
	entries, depth int
	bytes          int64
}
type hooks struct {
	before  func(string)
	open    func(int, string, int, uint32) (int, error)
	mkdir   func(int, string, uint32) error
	symlink func(string, int, string) error
	write   func(int, []byte) (int, error)
	fsync   func(int) error
	close   func(int) error
}
type runner struct {
	ctx      context.Context
	c        *captured
	limit    limits
	hooks    hooks
	effected bool
	entries  int
	bytes    int64
	buffer   []byte
}

func (r *runner) check() error {
	if r.ctx == nil {
		return refusal("input")
	}
	if err := r.ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return &Failure{Code: "launch_copy_deadline", cause: err}
		}
		return &Failure{Code: "launch_copy_canceled", cause: err}
	}
	if !time.Now().Before(r.c.until) {
		return &Failure{Code: "launch_copy_deadline", cause: context.DeadlineExceeded}
	}
	return nil
}
func osFailure(err error) error {
	if err == nil {
		return nil
	}
	code := "io"
	switch {
	case errors.Is(err, unix.EEXIST):
		code = "collision"
	case errors.Is(err, unix.ENOENT), errors.Is(err, unix.ENOTDIR), errors.Is(err, unix.ELOOP), errors.Is(err, unix.ESTALE):
		code = "changed"
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
		code = "mode"
	}
	// Python's native OSError path is an infrastructure error even when errno
	// also supplies a bounded diagnostic or proves an exclusive no-create result.
	return &Failure{Code: "launch_copy_" + code, Internal: true, cause: err}
}
func combine(all ...error) error {
	var causes []error
	var selected *Failure
	uncertain, internal := false, false
	for _, err := range all {
		if err == nil {
			continue
		}
		causes = append(causes, err)
		if f, ok := err.(*Failure); ok && f != nil && closedCode(f.Code) {
			if selected == nil || (!selected.Internal && f.Internal) {
				selected = f
			}
			uncertain = uncertain || f.Uncertain
			internal = internal || f.Internal
		} else {
			internal = true
		}
	}
	if len(causes) == 0 {
		return nil
	}
	if len(causes) == 1 {
		return causes[0]
	}
	code := "launch_copy_io"
	if selected != nil && (!internal || selected.Internal) {
		code = selected.Code
	}
	return &Failure{Code: code, Internal: internal, Uncertain: uncertain, cause: errors.Join(causes...)}
}
func (r *runner) call(event string, fn func() error) error {
	if r.hooks.before != nil {
		r.hooks.before(event)
	}
	if err := r.check(); err != nil {
		return err
	}
	err := fn()
	// Observe cancellation even when a syscall returned an error. Effects are
	// recorded inside fn before this check, including partial writes.
	return combine(osFailure(err), r.check())
}
func (r *runner) held(fd int) (s fingerprint, err error) {
	var raw unix.Stat_t
	err = r.call("fstat", func() error { return unix.Fstat(fd, &raw) })
	return metadata(raw), err
}
func (r *runner) named(fd int, name string) (s fingerprint, err error) {
	var raw unix.Stat_t
	err = r.call("fstatat", func() error { return unix.Fstatat(fd, name, &raw, unix.AT_SYMLINK_NOFOLLOW) })
	return metadata(raw), err
}
func (r *runner) match(parent int, name string, fd int, want fingerprint) error {
	n, err := r.named(parent, name)
	if err != nil {
		return err
	}
	if n != want {
		return refusal("changed")
	}
	if fd >= 0 {
		h, err := r.held(fd)
		if err != nil {
			return err
		}
		if h != want {
			return refusal("changed")
		}
	}
	return nil
}
func (r *runner) open(parent int, name string, flags int, mode uint32, effect bool) (fd int, err error) {
	fd = -1
	dispatch := r.call
	if effect {
		dispatch = r.create
	}
	err = dispatch("open", func() error {
		var e error
		if r.hooks.open != nil {
			fd, e = r.hooks.open(parent, name, flags, mode)
		} else {
			fd, e = unix.Openat(parent, name, flags, mode)
		}
		return e
	})
	if err != nil && fd >= 0 {
		err = combine(err, r.close(fd))
		fd = -1
	}
	return
}
func (r *runner) create(event string, fn func() error) error {
	return r.call(event, func() error {
		prior := r.effected
		// Mark before dispatch: even EINTR/EIO can follow a private mutation.
		r.effected = true
		err := fn()
		// Exclusive EEXIST proves this dispatch created nothing; preserve any
		// earlier sticky uncertainty rather than clearing it.
		if errors.Is(err, unix.EEXIST) {
			r.effected = prior
		}
		return err
	})
}
func (r *runner) close(fd int) error {
	// Close owned descriptions even after cancellation. Never retry close, since
	// an interrupted close may already have released its numeric descriptor.
	return r.closeWith(func() error {
		if r.hooks.close != nil {
			return r.hooks.close(fd)
		}
		return unix.Close(fd)
	})
}
func (r *runner) closeWith(fn func() error) error {
	before := r.check()
	err := fn() // Cleanup must actually run even after cancellation.
	return combine(osFailure(err), before, r.check())
}
func component(s string) bool {
	return s != "" && s != "." && s != ".." && utf8.ValidString(s) && !strings.ContainsAny(s, "/\x00")
}
func (r *runner) names(fd, remaining int) (all []string, err error) {
	// Reopening dot creates an independent open description. A dup would alter
	// the borrowed or traversal handle's shared directory offset.
	own, err := r.open(fd, ".", dirFlags, 0, false)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(own), "")
	if f == nil {
		return nil, combine(&Failure{Code: "launch_copy_io", Internal: true}, r.close(own))
	}
	defer func() {
		err = combine(err, r.closeWith(f.Close))
	}()
	for {
		var batch []string
		var re error
		err = r.call("readdir", func() error {
			batch, re = f.Readdirnames(128)
			if re == io.EOF {
				return nil
			}
			return re
		})
		if err != nil {
			return nil, err
		}
		if len(batch) > remaining-len(all) {
			return nil, refusal("limit")
		}
		for _, name := range batch {
			if !component(name) {
				return nil, refusal("name")
			}
		}
		all = append(all, batch...)
		if re == io.EOF {
			break
		}
	}
	sort.Strings(all) // UTF-8 lexical order is Unicode scalar order, as in Python.
	for i := 1; i < len(all); i++ {
		if all[i] == all[i-1] {
			return nil, refusal("changed")
		}
	}
	return all, r.check()
}
func borrowed(c *captured, fn func(int, int) error) error {
	a, err := c.source.File.SyscallConn()
	if err != nil {
		return osFailure(err)
	}
	b, err := c.destination.File.SyscallConn()
	if err != nil {
		return osFailure(err)
	}
	var result error
	err = a.Control(func(source uintptr) {
		// Both Control references stay live through all real synchronous I/O,
		// fences, and final checks. No borrowed numeric fd escapes these scopes.
		e := b.Control(func(destination uintptr) { result = fn(int(source), int(destination)) })
		if e != nil {
			result = combine(result, osFailure(e))
		}
	})
	if err != nil {
		return combine(result, osFailure(err))
	}
	return result
}
func prepareSystem(c *captured) error {
	r := &runner{ctx: context.Background(), c: c}
	return borrowed(c, func(source, destination int) error {
		s, err := r.held(source)
		if err != nil {
			return err
		}
		d, err := r.held(destination)
		if err != nil {
			return err
		}
		if s.identity() != c.source.Identity || d.identity() != c.destination.Identity {
			return refusal("identity")
		}
		if !s.safeDir() || !d.privateDir() {
			return refusal("mode")
		}
		if s.identity() == d.identity() {
			return refusal("identity")
		}
		names, err := r.names(destination, 0)
		if err != nil {
			if f, ok := err.(*Failure); ok && f.Code == "launch_copy_limit" {
				return refusal("destination")
			}
			return err
		}
		if len(names) != 0 {
			return refusal("destination")
		}
		if now, err := r.held(source); err != nil {
			return err
		} else if now != s {
			return refusal("changed")
		}
		if now, err := r.held(destination); err != nil {
			return err
		} else if now != d {
			return refusal("changed")
		}
		c.roots = rootPins{s, d}
		return nil
	})
}
func runSystem(o *Operation, ctx context.Context) error {
	return o.run(ctx, limits{maxEntries, maxDepth, maxBytes}, hooks{})
}
func (o *Operation) run(ctx context.Context, limit limits, h hooks) (err error) {
	if o == nil || o.capture == nil || !o.capture.used.CompareAndSwap(false, true) {
		return &Failure{Code: "launch_copy_consumed", Uncertain: true}
	}
	r := &runner{ctx: ctx, c: o.capture, limit: limit, hooks: h, buffer: make([]byte, 1<<20)}
	defer func() {
		if err == nil || !r.effected {
			return
		}
		if f, ok := err.(*Failure); ok && f != nil {
			copy := *f
			copy.Uncertain = copy.Uncertain || r.effected
			err = &copy
		}
	}()
	if err = r.check(); err != nil {
		return err
	}
	// The earlier of the original bound and the caller deadline is conveyed to
	// the trusted fence. Syscalls themselves remain synchronous and may block.
	fenceCtx, cancel := context.WithDeadline(ctx, r.c.until)
	defer cancel()
	r.ctx = fenceCtx
	return borrowed(r.c, func(source, destination int) error {
		if err := r.roots(source, destination); err != nil {
			return err
		}
		if err := r.c.fence(fenceCtx); err != nil {
			return err
		}
		if err := r.check(); err != nil {
			return err
		}
		if err := r.roots(source, destination); err != nil {
			return err
		}
		tree, err := r.copyDirectory(source, destination, 0)
		if err != nil {
			return err
		}
		if err = r.verify(source, destination, tree); err != nil {
			return err
		}
		if err = r.check(); err != nil {
			return err
		}
		if err = r.c.fence(fenceCtx); err != nil {
			return r.fenceFailure(err)
		}
		if err = r.check(); err != nil {
			return err
		}
		if err = r.verify(source, destination, tree); err != nil {
			return err
		}
		return r.check()
	})
}
func (r *runner) roots(source, destination int) error {
	s, err := r.held(source)
	if err != nil {
		return err
	}
	d, err := r.held(destination)
	if err != nil {
		return err
	}
	if s != r.c.roots.source || d != r.c.roots.destination {
		return refusal("changed")
	}
	return nil
}
func (r *runner) fenceFailure(err error) error {
	if !r.effected {
		return err
	}
	if f, ok := err.(*Failure); ok && f != nil && closedCode(f.Code) {
		copy := *f
		copy.Uncertain = true
		copy.cause = err
		return &copy
	}
	if errors.Is(err, context.Canceled) {
		return &Failure{Code: "launch_copy_canceled", Uncertain: true, cause: err}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &Failure{Code: "launch_copy_deadline", Uncertain: true, cause: err}
	}
	return &Failure{Code: "launch_copy_fence", Internal: true, Uncertain: true, cause: err}
}
func closedCode(code string) bool {
	switch code {
	case "launch_copy_input", "launch_copy_consumed", "launch_copy_unsupported", "launch_copy_identity", "launch_copy_mode", "launch_copy_destination", "launch_copy_changed", "launch_copy_collision", "launch_copy_limit", "launch_copy_name", "launch_copy_link", "launch_copy_file", "launch_copy_type", "launch_copy_write", "launch_copy_io", "launch_copy_fence", "launch_copy_canceled", "launch_copy_deadline":
		return true
	}
	return false
}

type node struct {
	name                string
	source, destination fingerprint
	children            []*node
}

func (r *runner) copyDirectory(source, destination, depth int) (tree *node, err error) {
	if depth > r.limit.depth {
		return nil, refusal("limit")
	}
	s, err := r.held(source)
	if err != nil {
		return nil, err
	}
	d, err := r.held(destination)
	if err != nil {
		return nil, err
	}
	if depth == 0 && (s != r.c.roots.source || d != r.c.roots.destination) {
		return nil, refusal("changed")
	}
	if !s.safeDir() || !d.createdDir() {
		return nil, refusal("mode")
	}
	names, err := r.names(source, r.limit.entries-r.entries)
	if err != nil {
		return nil, err
	}
	// Reserve every sibling name before descending, so wide nested directories
	// cannot repeatedly spend the same global entry budget.
	r.entries += len(names)
	empty, err := r.names(destination, 0)
	if err != nil {
		return nil, err
	}
	if len(empty) != 0 {
		return nil, refusal("destination")
	}
	tree = &node{source: s}
	for _, name := range names {
		child, e := r.copyEntry(source, destination, name, depth)
		if e != nil {
			return nil, e
		}
		tree.children = append(tree.children, child)
	}
	if now, e := r.held(source); e != nil {
		return nil, e
	} else if now != s {
		return nil, refusal("changed")
	}
	beforeSync, e := r.held(destination)
	if e != nil {
		return nil, e
	} else if !d.sameObject(beforeSync) {
		return nil, refusal("changed")
	}
	if err = r.sync(destination); err != nil {
		return nil, err
	}
	tree.destination, err = r.held(destination)
	if err == nil && tree.destination != beforeSync {
		return nil, refusal("changed")
	}
	return tree, err
}
func (r *runner) copyEntry(source, destination int, name string, depth int) (result *node, err error) {
	s, err := r.named(source, name)
	if err != nil {
		return nil, err
	}
	if s.kind() != unix.S_IFLNK && (s.uid != uint32(os.Geteuid()) || s.mode&0022 != 0) {
		return nil, refusal("mode")
	}
	n := &node{name: name, source: s}
	switch s.kind() {
	case unix.S_IFDIR:
		if depth+1 > r.limit.depth {
			return nil, refusal("limit")
		}
		if err = r.create("mkdir", func() error {
			if r.hooks.mkdir != nil {
				return r.hooks.mkdir(destination, name, 0700)
			}
			return unix.Mkdirat(destination, name, 0700)
		}); err != nil {
			return nil, err
		}
		var reader int
		reader, err = r.open(source, name, dirFlags, 0, false)
		if err != nil {
			return nil, err
		}
		defer func() {
			err = combine(err, r.close(reader))
		}()
		if err = r.match(source, name, reader, s); err != nil {
			return nil, err
		}
		var writer int
		writer, err = r.open(destination, name, dirFlags, 0, false)
		if err != nil {
			return nil, err
		}
		defer func() {
			err = combine(err, r.close(writer))
		}()
		var child *node
		child, err = r.copyDirectory(reader, writer, depth+1)
		if err != nil {
			return nil, err
		}
		if err = r.match(source, name, reader, s); err != nil {
			return nil, err
		}
		if err = r.mode(writer, s.mode&07777); err != nil {
			return nil, err
		}
		if err = r.sync(writer); err != nil {
			return nil, err
		}
		prior := child.destination
		prior.mode = s.mode
		child.destination, err = r.held(writer)
		if err != nil {
			return nil, err
		}
		if !prior.sameObject(child.destination) {
			return nil, refusal("changed")
		}
		if err = r.match(destination, name, writer, child.destination); err != nil {
			return nil, err
		}
		child.name = name
		return child, nil
	case unix.S_IFLNK:
		text, err := r.readLink(source, name)
		if err != nil {
			return nil, err
		}
		if err = r.match(source, name, -1, s); err != nil {
			return nil, err
		}
		if err = r.create("symlink", func() error {
			if r.hooks.symlink != nil {
				return r.hooks.symlink(text, destination, name)
			}
			return unix.Symlinkat(text, destination, name)
		}); err != nil {
			return nil, err
		}
		n.destination, err = r.named(destination, name)
		if err != nil {
			return nil, err
		}
		if n.destination.kind() != unix.S_IFLNK || n.destination.uid != uint32(os.Geteuid()) {
			return nil, refusal("changed")
		}
		copied, err := r.readLink(destination, name)
		if err != nil {
			return nil, err
		}
		if copied != text {
			return nil, refusal("changed")
		}
	case unix.S_IFREG:
		if s.links != 1 {
			return nil, refusal("file")
		}
		if err = r.copyFile(source, destination, name, s, &n.destination); err != nil {
			return nil, err
		}
	default:
		return nil, refusal("type")
	}
	if err = r.match(source, name, -1, s); err != nil {
		return nil, err
	}
	if err = r.match(destination, name, -1, n.destination); err != nil {
		return nil, err
	}
	return n, nil
}
func (r *runner) readLink(fd int, name string) (text string, err error) {
	var buf [maxLink + 1]byte
	var n int
	err = r.call("readlink", func() error { var e error; n, e = unix.Readlinkat(fd, name, buf[:]); return e })
	if err != nil {
		return "", err
	}
	return linkText(buf[:n])
}
func linkText(raw []byte) (string, error) {
	if len(raw) > maxLink {
		return "", refusal("limit")
	}
	t := string(raw)
	if len(t) == 0 || t[0] == '/' || !utf8.ValidString(t) || strings.IndexByte(t, 0) >= 0 {
		return "", refusal("link")
	}
	return t, nil
}
func (r *runner) mode(fd int, mode uint32) error {
	return r.call("chmod", func() error {
		r.effected = true
		return unix.Fchmod(fd, mode)
	})
}
func (r *runner) sync(fd int) error {
	return r.call("fsync", func() error {
		if r.hooks.fsync != nil {
			return r.hooks.fsync(fd)
		}
		return unix.Fsync(fd)
	})
}
func (r *runner) copyFile(source, destination int, name string, want fingerprint, copied *fingerprint) (err error) {
	reader, err := r.open(source, name, readFlags, 0, false)
	if err != nil {
		return err
	}
	defer func() {
		err = combine(err, r.close(reader))
	}()
	if err = r.match(source, name, reader, want); err != nil {
		return err
	}
	writer, err := r.open(destination, name, writeFlags, 0600, true)
	if err != nil {
		return err
	}
	defer func() {
		err = combine(err, r.close(writer))
	}()
	created, err := r.held(writer)
	if err != nil {
		return err
	}
	if created.kind() != unix.S_IFREG || created.uid != uint32(os.Geteuid()) || created.links != 1 || created.size != 0 || created.mode&07177 != 0 {
		return refusal("changed")
	}
	written := int64(0)
	for {
		var n int
		if err = r.call("read", func() error { var e error; n, e = unix.Read(reader, r.buffer); return e }); err != nil {
			return err
		}
		if n == 0 {
			break
		}
		if int64(n) > r.limit.bytes-r.bytes {
			return refusal("limit")
		}
		r.bytes += int64(n)
		written += int64(n)
		for offset := 0; offset < n; {
			var count int
			if err = r.call("write", func() error {
				r.effected = true
				var e error
				if r.hooks.write != nil {
					count, e = r.hooks.write(writer, r.buffer[offset:n])
				} else {
					count, e = unix.Write(writer, r.buffer[offset:n])
				}
				return e
			}); err != nil {
				return err
			}
			if count <= 0 || count > n-offset {
				return refusal("write")
			}
			offset += count
		}
	}
	if err = r.match(source, name, reader, want); err != nil {
		return err
	}
	if written != want.size {
		return refusal("changed")
	}
	if err = r.mode(writer, want.mode&07777); err != nil {
		return err
	}
	if err = r.sync(writer); err != nil {
		return err
	}
	d, err := r.held(writer)
	if err != nil {
		return err
	}
	if d.kind() != unix.S_IFREG || d.uid != uint32(os.Geteuid()) || d.links != 1 || d.size != written || d.mode&07777 != want.mode&07777 {
		return refusal("changed")
	}
	if d.identity() != created.identity() || d.gid != created.gid {
		return refusal("changed")
	}
	*copied = d
	return r.match(destination, name, writer, d)
}
func (r *runner) verify(source, destination int, n *node) error {
	if s, err := r.held(source); err != nil {
		return err
	} else if s != n.source {
		return refusal("changed")
	}
	if d, err := r.held(destination); err != nil {
		return err
	} else if d != n.destination {
		return refusal("changed")
	}
	for _, fd := range []int{source, destination} {
		names, err := r.names(fd, len(n.children))
		if err != nil {
			return err
		}
		if len(names) != len(n.children) {
			return refusal("changed")
		}
		for i, child := range n.children {
			if names[i] != child.name {
				return refusal("changed")
			}
		}
	}
	for _, child := range n.children {
		if err := r.match(source, child.name, -1, child.source); err != nil {
			return err
		}
		if err := r.match(destination, child.name, -1, child.destination); err != nil {
			return err
		}
		if child.source.kind() == unix.S_IFDIR {
			if err := r.verifyChild(source, destination, child); err != nil {
				return err
			}
		}
	}
	if s, err := r.held(source); err != nil {
		return err
	} else if s != n.source {
		return refusal("changed")
	}
	if d, err := r.held(destination); err != nil {
		return err
	} else if d != n.destination {
		return refusal("changed")
	}
	return r.check()
}
func (r *runner) verifyChild(source, destination int, child *node) (err error) {
	a, err := r.open(source, child.name, dirFlags, 0, false)
	if err != nil {
		return err
	}
	defer func() {
		err = combine(err, r.close(a))
	}()
	b, err := r.open(destination, child.name, dirFlags, 0, false)
	if err != nil {
		return err
	}
	defer func() {
		err = combine(err, r.close(b))
	}()
	if err = r.verify(a, b, child); err != nil {
		return err
	}
	if err = r.match(source, child.name, a, child.source); err != nil {
		return err
	}
	return r.match(destination, child.name, b, child.destination)
}
