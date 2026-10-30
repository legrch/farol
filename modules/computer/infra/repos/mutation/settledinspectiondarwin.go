//go:build darwin

package mutation

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sort"

	"golang.org/x/sys/unix"
)

type settledFile struct {
	key     string
	file    *os.File
	initial unix.Stat_t
}

type nativeSettledObservation struct {
	d           *disk
	files       []settledFile
	recordCount int
	maxBytes    int64           // optional additional fresh-history memory budget
	ctx         context.Context // optional cancellation for borrowed fresh inspection
}

func inspectSettledExisting(ctx context.Context, root Root, expected [settledRecordCount]ExpectedSettledRecord, visit func(SettledInspection) error) (*SettledInspection, error) {
	var result *SettledInspection
	err := inspectSettledNative(ctx, root, settledRecordCount, func(o settledObservation) (err error) {
		result, err = observeSettled(ctx, expected, o, visit)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func inspectInterruptedChatSettledExisting(ctx context.Context, root Root, expected [interruptedChatSettledRecordCount]ExpectedSettledRecord, visit func(InterruptedChatSettledInspection) error) (*InterruptedChatSettledInspection, error) {
	var result *InterruptedChatSettledInspection
	err := inspectSettledNative(ctx, root, interruptedChatSettledRecordCount, func(o settledObservation) (err error) {
		result, err = observeInterruptedChatSettled(ctx, expected, o, visit)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func inspectSettledNative(ctx context.Context, root Root, count int, observe func(settledObservation) error) (err error) {
	// Preserve the two named settled policies' exact inventory bounds.
	if count != settledRecordCount && count != interruptedChatSettledRecordCount {
		return settledRefusal()
	}
	return inspectBoundedNative(ctx, root, count, observe)
}

// Shared storage observation only; public policy selection remains separate.
func inspectBoundedNative(ctx context.Context, root Root, count int, observe func(settledObservation) error) (err error) {
	if ctx == nil || ctx.Err() != nil || count < 1 || count > maxPreservedRecords || observe == nil {
		return unavailable()
	}
	// Existing owner only: no O_CREAT, mkdir, repair, sync or publication.
	d, err := openNativeMode(root, false)
	if err != nil {
		return err
	}
	o := &nativeSettledObservation{d: d, recordCount: count}
	defer func() {
		var closeErr error
		for _, f := range o.files {
			closeErr = errors.Join(closeErr, f.file.Close())
		}
		closeErr = errors.Join(closeErr, d.close())
		if closeErr != nil || ctx.Err() != nil {
			err = unavailable()
		}
	}()
	return observe(o)
}

func (o *nativeSettledObservation) check() error {
	d := o.d
	if o.ctx != nil && o.ctx.Err() != nil {
		return unavailable()
	}
	if d.check() != nil {
		return unavailable()
	}
	// Ancestor path identities are pinned by d.check; the private state root,
	// mutations directory and lock must also retain their complete versions.
	for _, p := range d.pins[len(d.pins)-2:] {
		now, err := stat(p.fd)
		if err != nil || !stable(p.initial, now) {
			return unavailable()
		}
	}
	lock, err := stat(d.lock)
	if err != nil || lock.Size != 0 || !stable(d.lockIdentity, lock) {
		return unavailable()
	}
	return nil
}

func (o *nativeSettledObservation) names() ([]string, error) {
	if o.check() != nil {
		return nil, unavailable()
	}
	fd, err := unix.Openat(o.d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, unavailable()
	}
	f := os.NewFile(uintptr(fd), "settled-mutation-inventory")
	names, readErr := f.Readdirnames(o.recordCount + 1)
	// Explicit EOF qualification covers the complete bounded namespace, even
	// when Readdirnames returns its partial final batch with a nil error.
	extra, endErr := f.Readdirnames(1)
	closeErr := f.Close()
	if closeErr != nil || (readErr != nil && readErr != io.EOF) || endErr != io.EOF || len(extra) != 0 || len(names) != o.recordCount || o.check() != nil {
		return nil, unavailable()
	}
	sort.Strings(names)
	for _, key := range names {
		if !validKey(key) {
			return nil, settledRefusal()
		}
	}
	for n := 1; n < len(names); n++ {
		if names[n-1] == names[n] {
			return nil, settledRefusal()
		}
	}
	return names, nil
}

func (o *nativeSettledObservation) read(f settledFile) ([]byte, error) {
	before, err := stat(int(f.file.Fd()))
	if err != nil || !stable(f.initial, before) || !private(before, unix.S_IFREG, 0600, o.d.root.OwnerUID) || before.Size < 1 || before.Size > maxRecordBytes {
		return nil, unavailable()
	}
	// SectionReader uses fresh positioned reads without sharing an offset.
	raw, readErr := io.ReadAll(io.NewSectionReader(f.file, 0, maxRecordBytes+1))
	after, statErr := stat(int(f.file.Fd()))
	var named unix.Stat_t
	nameErr := unix.Fstatat(o.d.dir, f.key, &named, unix.AT_SYMLINK_NOFOLLOW)
	if readErr != nil || statErr != nil || nameErr != nil || len(raw) != int(before.Size) || !stable(before, after) || !stable(after, named) || o.check() != nil {
		return nil, unavailable()
	}
	return raw, nil
}

func (o *nativeSettledObservation) inventory() ([]settledBytes, error) {
	names, err := o.names()
	if err != nil {
		return nil, err
	}
	entries := make([]settledBytes, 0, len(names))
	var totalBytes int64
	for _, key := range names {
		fd, err := unix.Openat(o.d.dir, key, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, unavailable()
		}
		f := settledFile{key: key, file: os.NewFile(uintptr(fd), key)}
		// Retain even an unqualified descriptor so every exit closes exactly
		// the handles opened by this inspection, after the observation ends.
		o.files = append(o.files, f)
		f.initial, err = stat(fd)
		if err != nil {
			return nil, unavailable()
		}
		o.files[len(o.files)-1] = f
		if o.maxBytes > 0 {
			if f.initial.Size < 0 || f.initial.Size > o.maxBytes-totalBytes {
				return nil, unavailable()
			}
			totalBytes += f.initial.Size
		}
		raw, err := o.read(f)
		if err != nil {
			return nil, err
		}
		entries = append(entries, settledBytes{key: key, raw: raw})
	}
	return entries, nil
}

func (o *nativeSettledObservation) recheck(entries []settledBytes) error {
	names, err := o.names()
	if err != nil || len(o.files) != o.recordCount || len(entries) != o.recordCount {
		return unavailable()
	}
	for n, f := range o.files {
		if names[n] != f.key || entries[n].key != f.key {
			return unavailable()
		}
		raw, err := o.read(f)
		if err != nil || !bytes.Equal(raw, entries[n].raw) {
			return unavailable()
		}
	}
	// A later record read must not hide a change to an earlier pinned record.
	// Qualify all descriptor/name versions again after the fresh byte pass.
	for _, f := range o.files {
		if o.ctx != nil && o.ctx.Err() != nil {
			return unavailable()
		}
		current, err := stat(int(f.file.Fd()))
		var named unix.Stat_t
		if err != nil || !stable(f.initial, current) || unix.Fstatat(o.d.dir, f.key, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(current, named) {
			return unavailable()
		}
	}
	return o.check()
}

func (o *nativeSettledObservation) metadata() SettledInspection {
	d := o.d
	p := d.pins[len(d.pins)-1].initial
	return SettledInspection{Root: d.root, MutationsDevice: uint64(p.Dev), MutationsInode: p.Ino, LockDevice: uint64(d.lockIdentity.Dev), LockInode: d.lockIdentity.Ino}
}
