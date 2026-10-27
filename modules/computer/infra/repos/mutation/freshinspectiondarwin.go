//go:build darwin

package mutation

import (
	"context"
	"io"
	"os"
	"slices"

	"golang.org/x/sys/unix"
)

// InspectFreshProcesses borrows this already-held writer lock and existing
// record reader. It performs no recovery, PID lookup, write or state transition.
// The existing 128-record inspection bound and final byte/root checks remain.
func (r *Repository) InspectFreshProcesses(ctx context.Context, selection SettledSelection) (unknown bool, err error) {
	if r == nil || ctx == nil {
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
	names, readErr := f.Readdirnames(maxPreservedRecords + 1)
	extra, endErr := f.Readdirnames(1)
	closeErr := f.Close()
	if closeErr != nil || readErr != nil && readErr != io.EOF || endErr != io.EOF || len(extra) != 0 || len(names) > maxPreservedRecords {
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
	observation := &nativeSettledObservation{d: &copy, recordCount: len(names)}
	defer func() {
		for _, file := range observation.files {
			if file.file.Close() != nil {
				err = unavailable()
			}
		}
	}()
	entries, err := observation.inventory()
	if err != nil {
		return false, err
	}
	unknown, err = qualifyFreshProcessHistory(entries, selection)
	if err != nil {
		return false, err
	}
	if observation.recheck(entries) != nil || ctx.Err() != nil {
		return false, unavailable()
	}
	return unknown, nil
}
