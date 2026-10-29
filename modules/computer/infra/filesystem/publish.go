package filesystem

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// publish is one admitted attempt. A swap verification failure may perform at
// most one internal guarded undo before returning. There is no retry/fallback
// after a reported unknown/refusal. See mutation.md for same-user race residuals.
func (m *Mutable) publish(ctx context.Context, request port.MutationRequest, walk *mutationWalk, parent int, leaf string, payload []byte, previous *fileVersion, result *fileVersion) (err error) {
	if len(payload) > mutation.MaxBytes {
		return refusal("WORKSPACE_FILE_TOO_LARGE")
	}
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	name, err := m.fs.name()
	if err != nil || !stageName(name) {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	if err = m.fs.mkdir(parent, name, 0700); err != nil {
		if deterministicNoEffect(err) {
			return refusal("WORKSPACE_PATH_REFUSED")
		}
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	stage, err := m.fs.open(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	defer m.fs.close(stage)
	directory, err := m.fs.stat(stage)
	if err != nil || directory.mode&unix.S_IFMT != unix.S_IFDIR || directory.mode&0777 != 0700 || directory.uid != m.fs.uid() {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	const candidate = "candidate"
	// owned is nonnil only while the staging name is proven ours to delete.
	// settled prevents any extra cleanup/undo after an uncertain one-attempt call.
	var owned *fileVersion
	settled := false
	defer func() {
		if settled {
			return
		}
		clean := true
		if owned != nil {
			clean = m.discard(stage, candidate, *owned)
		}
		if !clean || !m.removeStage(parent, name, stage, directory) {
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
			return
		}
		if syncErr := m.fs.sync(parent); syncErr != nil {
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	}()
	fd, err := m.fs.open(stage, candidate, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	opened, statErr := m.fs.stat(fd)
	if statErr != nil || !opened.regular() || opened.uid != m.fs.uid() {
		m.fs.close(fd)
		settled = true
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	owned = &opened
	mode := uint32(0644)
	if previous != nil {
		mode = previous.mode & 07777
	}
	if err = m.fs.write(fd, payload); err == nil {
		err = m.fs.chmod(fd, mode)
	}
	if err == nil {
		err = m.fs.sync(fd)
	}
	written, statErr := m.fs.stat(fd)
	m.fs.close(fd)
	if err != nil || statErr != nil {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if !written.regular() || !written.inode(opened) || written.size != int64(len(payload)) {
		owned = nil
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	owned = &written
	hash := payloadHash(payload)
	if !m.unchanged(stage, candidate, written, hash, false) {
		owned = nil
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	target, lookupErr := m.fs.lstat(parent, leaf)
	if previous == nil {
		if !errors.Is(lookupErr, unix.ENOENT) {
			return refusal("WORKSPACE_MUTATION_CONFLICT")
		}
	} else if lookupErr != nil || target != *previous {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	if !m.stageHeld(parent, name, directory) {
		settled = true
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	// Preparation check stays outside the publication gate. The gate below
	// rechecks authority and retains its locks through the actual link/swap.
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	uncertain, err := withMutationPublication(ctx, request, walk, func() error {
		// Recheck exact name bindings inside the current-owner gate as well.
		if !m.stageHeld(parent, name, directory) {
			settled = true
			return mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
		target, lookupErr := m.fs.lstat(parent, leaf)
		if previous == nil {
			if !errors.Is(lookupErr, unix.ENOENT) {
				return refusal("WORKSPACE_MUTATION_CONFLICT")
			}
		} else if lookupErr != nil || target != *previous {
			return refusal("WORKSPACE_MUTATION_CONFLICT")
		}
		if previous == nil {
			err = m.fs.link(stage, candidate, parent, leaf)
			if err != nil {
				if deterministicNoEffect(err) {
					return refusal("WORKSPACE_MUTATION_CONFLICT")
				}
				settled = true
				return mutationError("MUTATION_OUTCOME_UNKNOWN")
			}
			owned = nil
		} else {
			err = m.fs.swap(stage, candidate, parent, leaf)
			if err != nil {
				if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EINVAL) {
					return refusal("WORKSPACE_PATH_REFUSED")
				}
				if deterministicNoEffect(err) {
					return refusal("WORKSPACE_MUTATION_CONFLICT")
				}
				settled = true
				return mutationError("MUTATION_OUTCOME_UNKNOWN")
			}
			owned = nil
			if !m.checkedOriginal(stage, candidate, *previous, expectedHash(request.Operation)) {
				// A newer target stays in place. The displaced object/stage is retained.
				if !m.holds(parent, leaf, written) {
					settled = true
					return mutationError("MUTATION_OUTCOME_UNKNOWN")
				}
				// Exactly ONE guarded internal undo. A lost/failed ACK is final unknown.
				if err = m.fs.swap(stage, candidate, parent, leaf); err != nil {
					settled = true
					return mutationError("MUTATION_OUTCOME_UNKNOWN")
				}
				if !m.unchanged(stage, candidate, written, hash, false) {
					settled = true
					return mutationError("MUTATION_OUTCOME_UNKNOWN")
				}
				owned = &written
				// Defer may discard only this unchanged candidate and exact stage.
				return refusal("WORKSPACE_MUTATION_CONFLICT")
			}
		}
		return nil
	})
	if uncertain {
		settled = true // A broken guard acknowledgement cannot permit cleanup/replay.
	}
	if err != nil {
		return err
	}

	// Verification needed for guarded undo completed under the owner gate.
	// Successful disposal/fsync/readback need no authority reentry and stay out.
	if previous == nil {
		if !m.unchanged(stage, candidate, written, hash, true) || !m.discard(stage, candidate, written) {
			settled = true
			return mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	} else if !m.holds(parent, leaf, written) || !m.checkedOriginal(stage, candidate, *previous, expectedHash(request.Operation)) || !m.discard(stage, candidate, *previous) {
		settled = true
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	// No cleanup is repeated after any uncertain disposal/removal attempt.
	settled = true
	if !m.removeStage(parent, name, stage, directory) {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if err = m.fs.sync(parent); err != nil {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if ctx.Err() != nil || walk.check() != nil || !m.unchanged(parent, leaf, written, hash, false) {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if result != nil {
		*result = written
	}
	return nil
}
func stageName(name string) bool {
	if len(name) < 20 || len(name) > 100 {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}
func deterministicNoEffect(err error) bool {
	return errors.Is(err, unix.EEXIST) || errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) || errors.Is(err, unix.EROFS) || errors.Is(err, unix.ENOSPC) || errors.Is(err, unix.ENAMETOOLONG) || errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EINVAL)
}
func (m *Mutable) holds(parent int, name string, v fileVersion) bool {
	after, err := m.fs.lstat(parent, name)
	return err == nil && v.inode(after) && after.mode&unix.S_IFMT == unix.S_IFREG
}
func (m *Mutable) stageHeld(parent int, name string, v fileVersion) bool {
	after, err := m.fs.lstat(parent, name)
	return err == nil && v.inode(after) && after.mode&unix.S_IFMT == unix.S_IFDIR && after.mode == v.mode && after.uid == v.uid
}
func (m *Mutable) discard(parent int, name string, v fileVersion) bool {
	return m.holds(parent, name, v) && m.fs.unlink(parent, name, false) == nil
}
func (m *Mutable) removeStage(parent int, name string, fd int, v fileVersion) bool {
	opened, err := m.fs.stat(fd)
	return err == nil && opened.inode(v) && m.stageHeld(parent, name, v) && m.fs.unlink(parent, name, true) == nil
}
func (m *Mutable) unchanged(parent int, name string, written fileVersion, hash string, linked bool) bool {
	listed, err := m.fs.lstat(parent, name)
	links := uint64(1)
	if linked {
		links = 2
	}
	if err != nil || !written.candidate(listed) || listed.links != links {
		return false
	}
	fd, err := m.fs.open(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	defer m.fs.close(fd)
	before, err := m.fs.stat(fd)
	if err != nil || before != listed {
		return false
	}
	data, err := m.fs.read(fd, mutation.MaxBytes)
	if err != nil {
		return false
	}
	after, err := m.fs.stat(fd)
	path, pe := m.fs.lstat(parent, name)
	return err == nil && pe == nil && before == after && after == path && int64(len(data)) == after.size && payloadHash(data) == hash
}
func (m *Mutable) checkedOriginal(parent int, name string, previous fileVersion, expected *string) bool {
	if expected == nil {
		return false
	}
	listed, err := m.fs.lstat(parent, name)
	if err != nil || !listed.inode(previous) || !listed.regular() {
		return false
	}
	fd, err := m.fs.open(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	defer m.fs.close(fd)
	opened, err := m.fs.stat(fd)
	if err != nil || opened != listed {
		return false
	}
	data, err := m.fs.read(fd, mutation.MaxBytes)
	if err != nil {
		return false
	}
	after, err := m.fs.stat(fd)
	path, pe := m.fs.lstat(parent, name)
	return err == nil && pe == nil && opened == after && after == path && payloadHash(data) == *expected
}
