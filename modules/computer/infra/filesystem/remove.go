package filesystem

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"golang.org/x/sys/unix"
)

// removeExact moves one entry into an owned private stage before disposal.
// A displaced entry that is not the checked preimage is retained there and
// the operation remains unknown. This is not an atomic hash-and-delete against
// external writers with access to the staged inode or directory.
func (m *Mutable) removeExact(ctx context.Context, request port.MutationRequest, walk *mutationWalk, parent int, leaf string, previous fileVersion, expected *string) (err error) {
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
	moved := false
	cleanable := true
	defer func() {
		if !cleanable || moved {
			return
		}
		if !m.removeStage(parent, name, stage, directory) || m.fs.sync(parent) != nil {
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	}()
	const candidate = "candidate"
	uncertain, err := withMutationPublication(ctx, request, walk, func() error {
		if !m.stageHeld(parent, name, directory) {
			cleanable = false
			return mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
		current, lookupErr := m.fs.lstat(parent, leaf)
		if lookupErr != nil || current != previous {
			return refusal("WORKSPACE_MUTATION_CONFLICT")
		}
		if moveErr := m.fs.moveExclusive(parent, leaf, stage, candidate); moveErr != nil {
			if deterministicNoEffect(moveErr) {
				return refusal("WORKSPACE_MUTATION_CONFLICT")
			}
			cleanable = false
			return mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
		moved = true
		if !m.stageHeld(parent, name, directory) || !m.checkedOriginal(stage, candidate, previous, expected) {
			return mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
		return nil
	})
	if uncertain {
		cleanable = false
	}
	if uncertain || err != nil {
		return err
	}
	if checkMutation(ctx, request, walk) != nil || !m.stageHeld(parent, name, directory) || !m.checkedOriginal(stage, candidate, previous, expected) || !m.discard(stage, candidate, previous) {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if m.fs.sync(stage) != nil || !m.removeStage(parent, name, stage, directory) || m.fs.sync(parent) != nil {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if checkMutation(ctx, request, walk) != nil {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if _, lookupErr := m.fs.lstat(parent, leaf); !errors.Is(lookupErr, unix.ENOENT) {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	return nil
}
