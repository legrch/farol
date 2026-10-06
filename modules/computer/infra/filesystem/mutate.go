package filesystem

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

func (m *Mutable) Mutate(ctx context.Context, request port.MutationRequest) (receipt *port.MutationReceipt, err error) {
	if m == nil || m.fs == nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if mutation.ValidateNative(request.Operation) != nil || !mutation.Identifier(request.Workspace.WorkspaceID, 160) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	request.Operation = request.Operation.Clone()
	if err = m.policy(request.Workspace, request.Operation.Path()); err != nil {
		return nil, err
	}
	walk, parent, err := m.root(request.Workspace)
	if err != nil {
		return nil, err
	}
	defer walk.close()
	if err = checkMutation(ctx, request, walk); err != nil {
		return nil, err
	}
	parts, _ := components(request.Operation.Path(), false, false)
	created := false
	defer func() {
		if err != nil && created {
			receipt = nil
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	}()
	for _, part := range parts[:len(parts)-1] {
		child, openErr := walk.add(parent, part)
		if openErr != nil {
			// Only proven absence permits mkdir, and only writes create parents.
			_, lookupErr := m.fs.lstat(parent, part)
			if !errors.Is(lookupErr, unix.ENOENT) || request.Operation.Kind() != mutation.WriteKind {
				return nil, openErr
			}
			if err = checkMutation(ctx, request, walk); err != nil {
				return nil, err
			}
			// A visible parent is itself a publication. Use the same selected
			// owner gate for this single mkdir, without extending it across sync,
			// directory opening or private staging IO.
			_, err = withMutationPublication(ctx, request, walk, func() error {
				if _, lookupErr := m.fs.lstat(parent, part); !errors.Is(lookupErr, unix.ENOENT) {
					return refusal("WORKSPACE_PATH_REFUSED")
				}
				if mkdirErr := m.fs.mkdir(parent, part, 0755); mkdirErr != nil {
					if deterministicNoEffect(mkdirErr) {
						return refusal("WORKSPACE_PATH_REFUSED")
					}
					return mutationError("MUTATION_OUTCOME_UNKNOWN")
				}
				created = true
				return nil
			})
			if err != nil {
				return nil, err
			}
			if err = m.fs.sync(parent); err != nil {
				return nil, mutationError("MUTATION_OUTCOME_UNKNOWN")
			}
			child, err = walk.add(parent, part)
			if err != nil {
				return nil, err
			}
		}
		parent = child
	}
	leaf := parts[len(parts)-1]
	previous, data, err := m.original(parent, leaf)
	if err != nil {
		return nil, err
	}
	var before *string
	if previous != nil {
		hash := payloadHash(data)
		before = &hash
	}
	if err = mutation.CheckPrecondition(request.Operation, before); err != nil {
		return nil, err
	}
	var payload []byte
	var replacements uint32
	switch v := request.Operation.(type) {
	case mutation.Write:
		payload = []byte(v.Content)
	case mutation.Edit:
		payload, err = editPayload(data, v.Edits)
		replacements = uint32(len(v.Edits))
		if err != nil {
			return nil, err
		}
	}
	if err = m.publish(ctx, request, walk, parent, leaf, payload, previous); err != nil {
		return nil, err
	}
	return &port.MutationReceipt{Operation: string(request.Operation.Kind()), RelativePath: request.Operation.Path(), Bytes: uint64(len(payload)), Replacements: replacements, BeforeSHA256: before, AfterSHA256: payloadHash(payload)}, nil
}
func (m *Mutable) original(parent int, leaf string) (*fileVersion, []byte, error) {
	listed, err := m.fs.lstat(parent, leaf)
	if errors.Is(err, unix.ENOENT) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if listed.mode&unix.S_IFMT == unix.S_IFLNK {
		return nil, nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if listed.mode&unix.S_IFMT != unix.S_IFREG {
		return nil, nil, refusal("WORKSPACE_NOT_A_FILE")
	}
	if !listed.regular() {
		return nil, nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if listed.size < 0 || listed.size > mutation.MaxBytes {
		return nil, nil, refusal("WORKSPACE_FILE_TOO_LARGE")
	}
	fd, err := m.fs.open(parent, leaf, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, openError(err)
	}
	defer m.fs.close(fd)
	opened, err := m.fs.stat(fd)
	if err != nil || opened != listed {
		return nil, nil, refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	data, err := m.fs.read(fd, mutation.MaxBytes)
	if err != nil {
		return nil, nil, refusal("WORKSPACE_FILE_TOO_LARGE")
	}
	after, err := m.fs.stat(fd)
	path, pe := m.fs.lstat(parent, leaf)
	if err != nil || pe != nil || after != opened || path != opened || int64(len(data)) != opened.size {
		return nil, nil, refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	return &opened, data, nil
}
