//go:build darwin

package mutation

import (
	"context"
	"io"
	"os"
	"slices"

	"golang.org/x/sys/unix"
)

// This is a resource budget, not permission to remove retained history.
// All record descriptors remain open through the final observation.
const freshInventoryBytes = 64 * 1024 * 1024

func closeFreshFiles(ctx context.Context, files []settledFile, closeFile func(*os.File) error) error {
	failed := false
	for _, file := range files {
		if closeFile(file.file) != nil {
			failed = true
		}
	}
	if failed || ctx.Err() != nil {
		return unavailable()
	}
	return nil
}

// InspectFreshProcesses borrows this already-held writer lock and existing
// record reader. It performs no recovery, PID lookup, write or state transition.
// The fresh-history bound and final byte/root checks remain.
func (r *Repository) InspectFreshProcesses(ctx context.Context, selection SettledSelection) (bool, error) {
	return r.inspectProcessHistory(ctx, selection, 0, freshInventoryBytes, func(entries []settledBytes, selection SettledSelection) (bool, error) {
		return qualifyProcessHistoryBoundedContext(ctx, entries, selection, len(entries))
	})
}

// InspectStagingProcesses is read-only and borrows the same writer and pinned
// inventory. Eligibility is a snapshot, not an admission or process fence.
func (r *Repository) InspectStagingProcesses(ctx context.Context, selection SettledSelection) (bool, error) {
	return r.inspectProcessHistory(ctx, selection, maxPreservedRecords, freshInventoryBytes, qualifyStagingHistory)
}

func (r *Repository) inspectProcessHistory(ctx context.Context, selection SettledSelection, maxEntries int, maxBytes int64, qualify func([]settledBytes, SettledSelection) (bool, error)) (unknown bool, err error) {
	if r == nil || ctx == nil || maxBytes <= 0 {
		return false, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(ctx); err != nil {
		return false, err
	}
	d, ok := r.disk.(*disk)
	if !ok {
		return false, unavailable()
	}
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, unavailable()
	}
	f := os.NewFile(uintptr(fd), "retained-process-inventory")
	var names []string
	var namesBytes uint64
	var readErr error
	for {
		if ctx.Err() != nil {
			readErr = unavailable()
			break
		}
		var batch []string
		batch, readErr = f.Readdirnames(256)
		for _, name := range batch {
			namesBytes += uint64(len(name)) + 512
			if namesBytes > freshInventoryBytes || (maxEntries > 0 && len(names) >= maxEntries) {
				readErr = unavailable()
				break
			}
			names = append(names, name)
		}
		if readErr != nil {
			break
		}
	}
	closeErr := f.Close()
	if closeErr != nil || readErr != io.EOF {
		return false, unavailable()
	}
	// Borrow the same descriptors. Capture current versions after the writer's
	// own allowed lock creation; identity/mode continuity was checked by ready.
	copy := *d
	copy.pins = slices.Clone(d.pins)
	for n := len(copy.pins) - 2; n < len(copy.pins); n++ {
		copy.pins[n].initial, err = stat(copy.pins[n].fd)
		if err != nil {
			return false, unavailable()
		}
	}
	observation := &nativeSettledObservation{d: &copy, recordCount: len(names), maxBytes: maxBytes, ctx: ctx}
	defer func() {
		if closeFreshFiles(ctx, observation.files, (*os.File).Close) != nil {
			err = unavailable()
		}
	}()
	entries, err := observation.inventory()
	if err != nil {
		return false, err
	}
	unknown, err = qualify(entries, selection)
	if err != nil {
		return false, err
	}
	if observation.recheck(entries) != nil || ctx.Err() != nil {
		return unknown, unavailable()
	}
	return unknown, nil
}
