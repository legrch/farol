package execution

import (
	"context"
	"errors"
	"os"
	"strconv"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
	"github.com/legrch/farol/modules/release/infra/native/installmove"
	"golang.org/x/sys/unix"
)

func (r *runtime) location(entry port.HelperRecoveryEntry) (installmove.Location, error) {
	f := r.config.Files
	parent := installmove.Directory{File: f.Operation, Identity: installmove.Identity{Device: f.OperationIdentity.Device, Inode: f.OperationIdentity.Inode}}
	name := ""
	switch entry {
	case port.App:
		parent = installmove.Directory{File: f.Applications, Identity: installmove.Identity{Device: f.ApplicationsIdentity.Device, Inode: f.ApplicationsIdentity.Inode}}
		if f.SharedParent {
			parent.Kind = installmove.SharedApplicationsParent
		}
		name = "Farol.app"
	case port.Staged:
		name = "staged.app"
	case port.Previous:
		name = "previous.app"
	case port.Failed:
		name = "failed.app"
	case port.RejectedTarget:
		name = "rejected-target.json"
	default:
		return installmove.Location{}, fail("input", false, false, nil)
	}
	if parent.File == nil {
		return installmove.Location{}, fail("internal", true, false, nil)
	}
	return installmove.Location{Parent: parent, Name: name}, nil
}

type entryState struct {
	present bool
	stat    unix.Stat_t
}

func sameMetadata(a, b unix.Stat_t) bool {
	// Observing a tree may update atime. Mutation-sensitive fields still cover
	// identity, type, ownership, links, size and change/modify timestamps.
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

// No numeric borrowed descriptor escapes Control. Only ENOENT proves absence;
// unreadability, ELOOP and dependency/cleanup failures never become absence.
func observe(ctx context.Context, location installmove.Location) (state entryState, result error) {
	if err := ctx.Err(); err != nil {
		return state, err
	}
	raw, err := location.Parent.File.SyscallConn()
	if err != nil {
		return state, err
	}
	var query error
	err = raw.Control(func(fd uintptr) {
		query = unix.Fstatat(int(fd), location.Name, &state.stat, unix.AT_SYMLINK_NOFOLLOW)
	})
	if err != nil {
		return entryState{}, errors.Join(query, err)
	}
	if query == unix.ENOENT {
		return entryState{}, ctx.Err()
	}
	if query != nil {
		return entryState{}, query
	}
	state.present = true
	return state, ctx.Err()
}

func snapshot(s entryState) port.HelperRecoveryEntrySnapshot {
	if !s.present {
		return port.HelperRecoveryEntrySnapshot{}
	}
	return port.HelperRecoveryEntrySnapshot{Present: true, Directory: s.stat.Mode&unix.S_IFMT == unix.S_IFDIR,
		OwnedByEffectiveUser: s.stat.Uid == uint32(os.Geteuid()),
		Identity:             port.HelperIdentity{Device: strconv.FormatUint(uint64(s.stat.Dev), 10), Inode: strconv.FormatUint(s.stat.Ino, 10)}}
}

func (r *runtime) Entries(ctx context.Context) (port.HelperRecoveryEntries, error) {
	var entries port.HelperRecoveryEntries
	err := r.invoke(ctx, "", func(c context.Context) error {
		if err := r.fence(c); err != nil {
			return err
		}
		var first [5]entryState
		for i := range first {
			location, err := r.location(port.HelperRecoveryEntry(i))
			if err != nil {
				return err
			}
			first[i], err = observe(c, location)
			if err != nil {
				return err
			}
		}
		if err := r.fence(c); err != nil {
			return err
		}
		for i := range first {
			location, err := r.location(port.HelperRecoveryEntry(i))
			if err != nil {
				return err
			}
			second, err := observe(c, location)
			if err != nil {
				return err
			}
			if second.present != first[i].present || second.present && !sameMetadata(second.stat, first[i].stat) {
				return fail("entry_replaced", false, false, nil)
			}
		}
		entries = port.HelperRecoveryEntries{App: snapshot(first[0]), Staged: snapshot(first[1]), Previous: snapshot(first[2]), Failed: snapshot(first[3]), RejectedTarget: snapshot(first[4])}
		return r.fence(c)
	})
	if err != nil {
		return port.HelperRecoveryEntries{}, err
	}
	return entries, nil
}

func pureIdentityRefusal(err error) bool {
	e, ok := err.(*appidentity.Error)
	if !ok || e == nil {
		return false
	}
	switch e.Code {
	case appidentity.Limit, appidentity.InvalidPlist, appidentity.InvalidJSON, appidentity.BundleMismatch, appidentity.BuildMismatch:
		return true
	}
	return false
}

// tree opens only the chosen fixed directory under its borrowed pinned parent.
// It owns and closes that newly opened handle; cancellation cannot abandon it.
// A negative match is returned only after all owned cleanup and final fencing.
func (r *runtime) tree(ctx context.Context, entry port.HelperRecoveryEntry, build port.HelperBuild) (negative bool, result error) {
	if entry == port.RejectedTarget {
		return false, fail("input", false, false, nil)
	}
	location, err := r.location(entry)
	if err != nil {
		return false, err
	}
	if err := r.fence(ctx); err != nil {
		return false, err
	}
	before, err := observe(ctx, location)
	if err != nil {
		return false, err
	}
	if !before.present || before.stat.Mode&unix.S_IFMT != unix.S_IFDIR || before.stat.Uid != uint32(os.Geteuid()) {
		return true, r.fence(ctx)
	}
	raw, err := location.Parent.File.SyscallConn()
	if err != nil {
		return false, err
	}
	fd := -1
	var opened error
	err = raw.Control(func(parent uintptr) {
		fd, opened = unix.Openat(int(parent), location.Name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	})
	// Open racing with disappearance is an error, not an inspected mismatch.
	if err != nil || opened != nil {
		return false, errors.Join(err, opened)
	}
	app := os.NewFile(uintptr(fd), "helper-app")
	if app == nil {
		return false, errors.Join(fail("internal", true, false, nil), unix.Close(fd))
	}
	defer func() {
		if err := app.Close(); err != nil {
			negative = false
			result = errors.Join(result, err)
		}
		if err := r.fence(ctx); err != nil {
			negative = false
			result = errors.Join(result, err)
		}
	}()
	var stat unix.Stat_t
	held, err := app.SyscallConn()
	if err != nil {
		return false, err
	}
	err = held.Control(func(fd uintptr) { opened = unix.Fstat(int(fd), &stat) })
	if err != nil || opened != nil {
		return false, errors.Join(err, opened)
	}
	if !sameMetadata(stat, before.stat) {
		return false, fail("entry_replaced", false, false, nil)
	}
	verifier, err := apptree.New(location.Parent.File, app, location.Name, apptree.Expected{TreeSHA256: build.Digest, Version: build.Version, BuildID: build.BuildID}, appidentity.Verify)
	if err != nil {
		return false, err
	}
	_, err = verifier.Verify(ctx)
	if err != nil {
		if apptree.IsVerificationRefusal(err, pureIdentityRefusal) {
			return true, nil
		}
		return false, err
	}
	return false, nil
}

func (r *runtime) MatchesTree(ctx context.Context, entry port.HelperRecoveryEntry, build port.HelperBuild) (bool, error) {
	negative := false
	err := r.invoke(ctx, "", func(c context.Context) error { var err error; negative, err = r.tree(c, entry, build); return err })
	return err == nil && !negative, err
}
func (r *runtime) VerifyTree(ctx context.Context, entry port.HelperRecoveryEntry, build port.HelperBuild) error {
	return r.invoke(ctx, "", func(c context.Context) error {
		negative, err := r.tree(c, entry, build)
		if err != nil {
			return err
		}
		if negative {
			return fail("tree_mismatch", false, false, nil)
		}
		return nil
	})
}

func (r *runtime) Rename(ctx context.Context, from, to port.HelperRecoveryEntry, expected port.HelperIdentity) error {
	return r.move(ctx, from, to, expected, port.HelperIdentity{}, false)
}
func (r *runtime) Exchange(ctx context.Context, left, right port.HelperRecoveryEntry, leftID, rightID port.HelperIdentity) error {
	return r.move(ctx, left, right, leftID, rightID, true)
}
func (r *runtime) move(ctx context.Context, left, right port.HelperRecoveryEntry, leftID, rightID port.HelperIdentity, exchange bool) error {
	kind := "rename:"
	if exchange {
		kind = "exchange:"
	}
	key := kind + strconv.Itoa(int(left)) + ":" + strconv.Itoa(int(right))
	return r.invoke(ctx, key, func(c context.Context) error {
		if left == port.RejectedTarget || right == port.RejectedTarget {
			return fail("input", false, false, nil)
		}
		l, err := r.location(left)
		if err != nil {
			return err
		}
		rightLocation, err := r.location(right)
		if err != nil {
			return err
		}
		identity := func(i port.HelperIdentity) installmove.Identity {
			return installmove.Identity{Device: i.Device, Inode: i.Inode}
		}
		var op *installmove.Operation
		if exchange {
			op, err = installmove.PrepareExchange(l, rightLocation, identity(leftID), identity(rightID), r.until, r.fence)
		} else {
			op, err = installmove.PrepareRename(l, rightLocation, identity(leftID), r.until, r.fence)
		}
		if err != nil {
			return err
		}
		return op.Run(c)
	})
}
