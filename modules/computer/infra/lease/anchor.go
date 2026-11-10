// Package lease provides an unwired, descriptor-held native observation
// of the fixed current startup APFS Data mount. No caller can nominate a mount
// root, persist an approval, or use this as a workspace authorization.
package lease

import (
	"context"
	"strings"
	"sync"

	port "github.com/legrch/farol/modules/computer/app/port/lease"
	domain "github.com/legrch/farol/modules/computer/domain/lease"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

type file struct {
	Device, Inode uint64
	Mode          uint32
}

func (f file) directory() bool { return f.Mode&0170000 == 0040000 && f.Device != 0 && f.Inode != 0 }

type ops interface {
	openRoot() (int, error)
	openAt(int, string) (int, error)
	stat(int) (file, error)
	mount(int) (domain.Mount, error)
	metadata(context.Context, string) (domain.Metadata, error)
	epoch(context.Context) (domain.Epoch, error)
	close(int) error
}
type item struct {
	fd   int
	name string
	file file
}
type chain []item

func refusal(code string) error { return &port.Failure{Code: code} }
func checkContext(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return refusal("WORKSPACE_ANCHOR_CANCELLED")
	}
	return nil
}
func closeChain(native ops, chain chain) error {
	var failed bool
	for i := len(chain) - 1; i >= 0; i-- {
		if native.close(chain[i].fd) != nil {
			failed = true
		}
	}
	if failed {
		return refusal("WORKSPACE_ANCHOR_CLOSE_UNCONFIRMED")
	}
	return nil
}

// openNamed is a no-follow rooted traversal; it never uses a caller-nominated
// mount as a trusted anchor. Rechecking held names detects replaced ancestors.
func openNamed(ctx context.Context, name string, native ops) (held chain, err error) {
	if err = checkContext(ctx); err != nil {
		return nil, err
	}
	if name != "/" && !identity.CanonicalPath(name) {
		return nil, refusal("WORKSPACE_ANCHOR_PATH_REFUSED")
	}
	fd, e := native.openRoot()
	if e != nil {
		return nil, refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	held = append(held, item{fd: fd})
	cleanup := func(e error) (chain, error) {
		if closeChain(native, held) != nil {
			return nil, refusal("WORKSPACE_ANCHOR_CLOSE_UNCONFIRMED")
		}
		return nil, e
	}
	first, e := native.stat(fd)
	if e != nil || !first.directory() {
		return cleanup(refusal("WORKSPACE_ANCHOR_UNAVAILABLE"))
	}
	held[0].file = first
	if name == "/" {
		return held, nil
	}
	for _, part := range strings.Split(name[1:], "/") {
		if e = checkContext(ctx); e != nil {
			return cleanup(e)
		}
		next, openErr := native.openAt(fd, part)
		if openErr != nil {
			return cleanup(refusal("WORKSPACE_ANCHOR_PATH_REFUSED"))
		}
		held = append(held, item{fd: next, name: part})
		current, statErr := native.stat(next)
		if statErr != nil || !current.directory() {
			return cleanup(refusal("WORKSPACE_ANCHOR_PATH_REFUSED"))
		}
		held[len(held)-1].file = current
		fd = next
	}
	return held, nil
}
func recheck(ctx context.Context, held chain, native ops) error {
	for i, v := range held {
		if err := checkContext(ctx); err != nil {
			return err
		}
		current, err := native.stat(v.fd)
		if err != nil || current != v.file {
			return refusal("WORKSPACE_ANCHOR_STALE")
		}
		var next int
		if i == 0 {
			next, err = native.openRoot()
		} else {
			next, err = native.openAt(held[i-1].fd, v.name)
		}
		if err != nil {
			return refusal("WORKSPACE_ANCHOR_STALE")
		}
		observed, statErr := native.stat(next)
		closeErr := native.close(next)
		if closeErr != nil {
			return refusal("WORKSPACE_ANCHOR_CLOSE_UNCONFIRMED")
		}
		if statErr != nil || observed != v.file {
			return refusal("WORKSPACE_ANCHOR_STALE")
		}
	}
	return checkContext(ctx)
}

type lease struct {
	mu                 sync.Mutex
	native             ops
	fixed              chain
	root, data         domain.Mount
	rootInfo, dataInfo domain.Metadata
	epoch              domain.Epoch
	closed             bool
	closeError         error
	poisoned           error // irreversible failure within this held anchor
}

var _ port.Anchor = (*lease)(nil)

type Acquirer struct{ native ops }

var _ port.Acquirer = (*Acquirer)(nil)

func New() *Acquirer { return &Acquirer{native: newNative()} }

// Acquire never accepts a path: the only allowed anchors are fixed system root
// and its paired Data mount. Every failure consumes all acquired descriptors.
func (a *Acquirer) Acquire(ctx context.Context) (_ port.Anchor, err error) {
	if err = checkContext(ctx); err != nil {
		return nil, err
	}
	native := a.native
	held, e := openNamed(ctx, domain.DataPath, native)
	if e != nil {
		return nil, e
	}
	defer func() {
		if err != nil {
			if closeErr := closeChain(native, held); closeErr != nil {
				err = closeErr
			}
		}
	}()
	l := &lease{native: native, fixed: held}
	if err = l.measure(ctx); err != nil {
		return nil, err
	}
	if err = l.requalify(ctx); err != nil {
		return nil, err
	}
	return l, nil
}
func (l *lease) measure(ctx context.Context) error {
	epoch, err := l.native.epoch(ctx)
	if err != nil || !epoch.Valid() {
		return refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	root, err := l.native.mount(l.fixed[0].fd)
	if err != nil {
		return refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	data, err := l.native.mount(l.fixed[len(l.fixed)-1].fd)
	if err != nil {
		return refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	if root.Device != l.fixed[0].file.Device || root.Inode != l.fixed[0].file.Inode || data.Device != l.fixed[len(l.fixed)-1].file.Device || data.Inode != l.fixed[len(l.fixed)-1].file.Inode {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	rootInfo, err := l.native.metadata(ctx, domain.SystemPath)
	if err != nil {
		return refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	dataInfo, err := l.native.metadata(ctx, domain.DataPath)
	if err != nil {
		return refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	if !domain.Qualified(root, data, rootInfo, dataInfo, epoch) {
		return refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
	}
	l.root, l.data, l.rootInfo, l.dataInfo, l.epoch = root, data, rootInfo, dataInfo, epoch
	return nil
}
func (l *lease) requalify(ctx context.Context) error {
	if err := checkContext(ctx); err != nil {
		return err
	}
	if err := recheck(ctx, l.fixed, l.native); err != nil {
		return err
	}
	epoch, err := l.native.epoch(ctx)
	if err != nil || epoch != l.epoch {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	root, err := l.native.mount(l.fixed[0].fd)
	if err != nil || !root.SameInstance(l.root) || root.Inode != l.root.Inode {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	data, err := l.native.mount(l.fixed[len(l.fixed)-1].fd)
	if err != nil || !data.SameInstance(l.data) || data.Inode != l.data.Inode {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	rootInfo, err := l.native.metadata(ctx, domain.SystemPath)
	if err != nil || rootInfo != l.rootInfo {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	dataInfo, err := l.native.metadata(ctx, domain.DataPath)
	if err != nil || dataInfo != l.dataInfo {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	if !domain.Qualified(root, data, rootInfo, dataInfo, epoch) {
		return refusal("WORKSPACE_ANCHOR_STALE")
	}
	if err := recheck(ctx, l.fixed, l.native); err != nil {
		return err
	}
	return checkContext(ctx)
}
func (l *lease) Requalify(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return refusal("WORKSPACE_ANCHOR_CLOSED")
	}
	if l.poisoned != nil {
		return l.poisoned
	}
	err := l.requalify(ctx)
	if err != nil && (ctx == nil || ctx.Err() == nil) {
		l.poisoned = err
	}
	return err
}
func (l *lease) Check(ctx context.Context, path string) (domain.Candidate, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return domain.Candidate{}, refusal("WORKSPACE_ANCHOR_CLOSED")
	}
	if l.poisoned != nil {
		return domain.Candidate{}, l.poisoned
	}
	if err := l.requalify(ctx); err != nil {
		if ctx == nil || ctx.Err() == nil {
			l.poisoned = err
		}
		return domain.Candidate{}, err
	}
	if path == "/" || !identity.CanonicalPath(path) {
		return domain.Candidate{}, refusal("WORKSPACE_ANCHOR_PATH_REFUSED")
	}
	held, err := openNamed(ctx, path, l.native)
	if err != nil {
		return domain.Candidate{}, err
	}
	// Even a successful classification becomes unavailable if descriptor cleanup
	// cannot be confirmed. No retries of a failed close.
	var result domain.Candidate
	target := held[len(held)-1]
	if cancelErr := checkContext(ctx); cancelErr != nil {
		if closeErr := closeChain(l.native, held); closeErr != nil {
			l.poisoned = closeErr
			return domain.Candidate{}, closeErr
		}
		return domain.Candidate{}, cancelErr
	}
	mount, mountErr := l.native.mount(target.fd)
	if mountErr != nil || mount.Device != target.file.Device || mount.Inode != target.file.Inode {
		err = refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	} else if !l.data.SameInstance(mount) || target.file.Device != l.data.Device {
		err = refusal("WORKSPACE_ANCHOR_DIFFERENT_MOUNT")
	} else if err = recheck(ctx, held, l.native); err == nil {
		result = domain.CurrentCandidate(path, l.data, mount)
		if result.Authority != "not-established" {
			err = refusal("WORKSPACE_ANCHOR_DIFFERENT_MOUNT")
		}
	}
	if err == nil {
		err = l.requalify(ctx)
		if err != nil && (ctx == nil || ctx.Err() == nil) {
			l.poisoned = err
		}
	}
	if closeErr := closeChain(l.native, held); closeErr != nil {
		err = closeErr
		l.poisoned = closeErr
	}
	if err != nil {
		return domain.Candidate{}, err
	}
	return result, nil
}
func (l *lease) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return l.closeError
	}
	l.closed = true
	l.closeError = closeChain(l.native, l.fixed)
	l.fixed = nil
	return l.closeError
}
