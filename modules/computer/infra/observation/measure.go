// Package observation measures read-only continuity candidates. It is NOT wired
// into any grant, settings mutation, tool, or live workspace admission.
package observation

import (
	"context"
	"strconv"
	"strings"

	identityport "github.com/legrch/farol/modules/computer/app/port/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

type fileIdentity struct {
	Device, Inode                  uint64
	Mode, UID                      uint32
	BirthSeconds, BirthNanoseconds int64
}

func (f fileIdentity) directory() bool { return f.Mode&0170000 == 0040000 }

// Each operation opens one component relative to a held parent with DIRECTORY,
// NOFOLLOW and CLOEXEC. facts must bind volume/object attributes to the SAME fd.
// No method can write, exec, resolve a bookmark, mount, or renew authority.
type nativeOperations interface {
	openRoot() (int, error)
	openAt(int, string) (int, error)
	stat(int) (fileIdentity, error)
	facts(context.Context, int) (identity.Evidence, error)
	close(int) error
	uid() uint32
}
type heldDirectory struct {
	fd       int
	name     string
	identity fileIdentity
}
type chain []heldDirectory

func fail(code string) error { return &identityport.Failure{Code: code} }
func cancelled(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return fail("WORKSPACE_REQUEST_CANCELLED")
	}
	return nil
}
func closeChain(ops nativeOperations, held chain) error {
	var result error
	for i := len(held) - 1; i >= 0; i-- {
		if ops.close(held[i].fd) != nil {
			result = fail("WORKSPACE_IDENTITY_UNAVAILABLE")
		}
	}
	return result
}

// '/' is allowed only for opening a mount root internally, not for enlarging an
// approved workspace. All descriptors remain held until the observation ends.
func openChain(ctx context.Context, path string, ops nativeOperations) (held chain, err error) {
	if err = cancelled(ctx); err != nil {
		return nil, err
	}
	if path != "/" && !identity.CanonicalPath(path) {
		return nil, fail("WORKSPACE_PATH_REFUSED")
	}
	fd, openErr := ops.openRoot()
	if openErr != nil {
		return nil, fail("WORKSPACE_PATH_REFUSED")
	}
	opened := chain{{fd: fd}}
	defer func() {
		if err != nil {
			if closeErr := closeChain(ops, opened); closeErr != nil {
				err = closeErr
			}
			held = nil
		}
	}()
	root, statErr := ops.stat(fd)
	if statErr != nil || !root.directory() {
		return nil, fail("WORKSPACE_PATH_REFUSED")
	}
	opened[0].identity = root
	parts := []string{}
	if path != "/" {
		parts = strings.Split(path[1:], "/")
	}
	for _, part := range parts {
		if err = cancelled(ctx); err != nil {
			return nil, err
		}
		child, openErr := ops.openAt(fd, part)
		if openErr != nil {
			return nil, fail("WORKSPACE_PATH_REFUSED")
		}
		opened = append(opened, heldDirectory{fd: child, name: part})
		measured, statErr := ops.stat(child)
		if statErr != nil || !measured.directory() {
			return nil, fail("WORKSPACE_PATH_REFUSED")
		}
		opened[len(opened)-1].identity = measured
		fd = child
	}
	return opened, nil
}

// Re-open every named link from its held parent; compare descriptor identity,
// not child counts/mtime (ordinary workspace content churn is allowed). These
// are bounded checks, not an atomic namespace snapshot or a future-use lease.
func recheckChain(ctx context.Context, held chain, ops nativeOperations) error {
	for i, item := range held {
		if err := cancelled(ctx); err != nil {
			return err
		}
		current, err := ops.stat(item.fd)
		if err != nil || current != item.identity {
			return fail("WORKSPACE_RACE_DETECTED")
		}
		var fd int
		if i == 0 {
			fd, err = ops.openRoot()
		} else {
			fd, err = ops.openAt(held[i-1].fd, item.name)
		}
		if err != nil {
			return fail("WORKSPACE_RACE_DETECTED")
		}
		named, statErr := ops.stat(fd)
		closeErr := ops.close(fd)
		if closeErr != nil {
			return fail("WORKSPACE_IDENTITY_UNAVAILABLE")
		}
		if statErr != nil || named != item.identity {
			return fail("WORKSPACE_RACE_DETECTED")
		}
	}
	return cancelled(ctx)
}

type Probe struct{}

func New() *Probe { return &Probe{} }

var _ identityport.Probe = (*Probe)(nil)

// measureHeld uses the same canonical descriptor-bound evidence checks as Observe.
// Ownership of held descriptors remains with the caller, including on failure.
func measureHeld(ctx context.Context, path string, held chain, ops nativeOperations) (identity.Observation, error) {
	var result identity.Observation
	if err := cancelled(ctx); err != nil {
		return result, err
	}
	target := held[len(held)-1]
	if target.identity.UID != ops.uid() || target.identity.Mode&0022 != 0 {
		return result, fail("WORKSPACE_PATH_REFUSED")
	}
	before, err := ops.facts(ctx, target.fd)
	if err != nil {
		return result, err
	}
	if !before.Valid() || before.FileID != strconv.FormatUint(target.identity.Inode, 10) ||
		before.BirthSeconds != strconv.FormatInt(target.identity.BirthSeconds, 10) ||
		before.BirthNanoseconds != strconv.FormatInt(target.identity.BirthNanoseconds, 10) {
		return result, fail("WORKSPACE_IDENTITY_INVALID")
	}
	if err = recheckChain(ctx, held, ops); err != nil {
		return result, err
	}
	after, err := ops.facts(ctx, target.fd)
	if err != nil {
		return result, err
	}
	if before != after {
		return result, fail("WORKSPACE_RACE_DETECTED")
	}
	if err = recheckChain(ctx, held, ops); err != nil {
		return result, err
	}
	result = identity.Observation{
		Binding:  identity.Binding{Path: path, Device: strconv.FormatUint(target.identity.Device, 10), Inode: strconv.FormatUint(target.identity.Inode, 10)},
		Evidence: before,
	}
	if !result.Valid() {
		return identity.Observation{}, fail("WORKSPACE_IDENTITY_INVALID")
	}
	return result, nil
}

func observe(ctx context.Context, path string, ops nativeOperations) (result identity.Observation, err error) {
	if err = cancelled(ctx); err != nil {
		return result, err
	}
	if !identity.CanonicalPath(path) {
		return result, fail("WORKSPACE_PATH_REFUSED")
	}
	held, err := openChain(ctx, path, ops)
	if err != nil {
		return result, err
	}
	defer func() {
		if closeErr := closeChain(ops, held); closeErr != nil && err == nil {
			result = identity.Observation{}
			err = closeErr
		}
	}()
	return measureHeld(ctx, path, held, ops)
}
