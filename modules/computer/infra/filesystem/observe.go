package filesystem

import (
	"context"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	"golang.org/x/sys/unix"
)

// ObserveRoot reopens one already selected physical root without following any
// component link. It grants no access and returns no file content. Consumers
// must still check their current authority before and after this observation.
func ObserveRoot(ctx context.Context, selected port.Root) (port.Root, error) {
	if ctx == nil {
		return port.Root{}, refusal("WORKSPACE_INVALID_REQUEST")
	}
	if err := cancelled(ctx); err != nil {
		return port.Root{}, err
	}
	descriptor := port.Descriptor{Root: selected.Path, ApprovedRoot: selected}
	fd, err := openRoot(descriptor)
	if err != nil {
		return port.Root{}, err
	}
	defer unix.Close(fd)
	opened, err := stat(fd)
	if err != nil {
		return port.Root{}, refusal("WORKSPACE_PATH_REFUSED")
	}
	if err := cancelled(ctx); err != nil {
		return port.Root{}, err
	}
	if err := recheckRoot(descriptor, opened); err != nil {
		return port.Root{}, err
	}
	if err := cancelled(ctx); err != nil {
		return port.Root{}, err
	}
	return port.Root{
		Path: selected.Path, Device: strconv.FormatUint(uint64(opened.Dev), 10),
		Inode: strconv.FormatUint(uint64(opened.Ino), 10),
	}, nil
}
