//go:build darwin || linux

package results

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

type preservationFile struct {
	meta   unix.Stat_t
	digest [32]byte
}

func acquirePreservationInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits) (_ *PreservationLease, err error) {
	// This existing observation-only opener tolerates an UNKNOWN marker while
	// retaining the original physical claim. Normal writer/empty policies stay
	// unchanged; no mutable owner or poison path is constructed.
	a, err := openArchiveDisk(ctx, root)
	if err != nil {
		return nil, err
	}
	retained := false
	defer func() {
		if !retained && a.d.close() != nil {
			err = Unavailable
		}
	}()
	value, files, err := scanPreservation(ctx, a, scope, limits)
	if err != nil {
		return nil, err
	}
	recheck := func() error {
		again, current, err := scanPreservation(ctx, a, scope, limits)
		if err != nil {
			return err
		}
		if again != value || len(files) != len(current) {
			return Refused
		}
		for name, before := range files {
			after, found := current[name]
			if !found || before.digest != after.digest || !resultStable(before.meta, after.meta) {
				return Refused
			}
		}
		return nil
	}
	if err := recheck(); err != nil {
		return nil, err
	}
	retained = true
	return &PreservationLease{lifetime: &ClosedLease{verify: recheck, close: a.d.close}, value: value, ctx: ctx}, nil
}

func scanPreservation(ctx context.Context, a *archiveDisk, scope port.JournalScope, limits Limits) (PreservationInspection, map[string]preservationFile, error) {
	fail := func() (PreservationInspection, map[string]preservationFile, error) {
		return PreservationInspection{}, nil, Refused
	}
	if a.verify(ctx) != nil {
		return fail()
	}
	d := a.d
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail()
	}
	f := os.NewFile(uintptr(fd), "chat-result-preservation-inventory")
	entries, readErr := f.ReadDir(2*limits.Results + 3)
	closed := f.Close()
	if readErr != nil && readErr != io.EOF || closed != nil || len(entries) >= 2*limits.Results+3 || a.verify(ctx) != nil {
		return fail()
	}
	names := make([]string, 0, len(entries))
	masks := make(map[string]uint8)
	for _, entry := range entries {
		name := entry.Name()
		names = append(names, name)
		if name == resultClaim || name == resultUnknown {
			continue
		}
		key, kind, ok := strings.Cut(name, ".")
		if !ok || !validResultKey(key) || kind != "attempt" && kind != "commit" {
			return fail()
		}
		bit := uint8(1)
		if kind == "commit" {
			bit = 2
		}
		if masks[key]&bit != 0 {
			return fail()
		}
		masks[key] |= bit
	}
	if len(masks) > limits.Results {
		return fail()
	}
	sort.Strings(names)
	files := make(map[string]preservationFile, len(names))
	// Only hashes and physical metadata survive each bounded body read.
	type digestEntry struct {
		Name   string
		Digest [32]byte
	}
	digests := make([]digestEntry, 0, len(names))
	value := PreservationInspection{Scope: scope, Root: d.root.Identity, StorageRoot: d.identity(), ClaimDigest: sha256.Sum256(a.claim), ResultCount: len(masks), Unresolved: a.unknown}
	for _, name := range names {
		limit := port.MaxResultRecordBytes
		if name == resultClaim {
			limit = len(a.claim)
		} else if name == resultUnknown {
			limit = len("UNKNOWN")
		} else if strings.HasSuffix(name, ".commit") {
			limit = 64
		}
		raw, file, err := readPreservationFile(ctx, d, name, limit)
		if err != nil {
			return fail()
		}
		files[name] = file
		digests = append(digests, digestEntry{Name: name, Digest: file.digest})
		if name == resultClaim {
			if !bytes.Equal(raw, a.claim) {
				return fail()
			}
			continue
		}
		if name == resultUnknown {
			// A partial fence is still unresolved data, never known absence.
			continue
		}
		key, kind, _ := strings.Cut(name, ".")
		if kind == "attempt" {
			r, err := decodeResult(raw)
			if err != nil || r.Root != value.Root || r.StorageRoot != value.StorageRoot || r.Request.Binding.ProfileID != scope.ProfileID || resultKey(r.Request) != key || len(r.Request.Payload) > limits.ResultBytes || len(r.Request.Payload) > limits.TotalBytes-value.PayloadBytes {
				return fail()
			}
			value.PayloadBytes += len(r.Request.Payload)
			if masks[key] == 1 {
				value.Unresolved = true
			}
		} else {
			attempt, present := files[key+".attempt"]
			// Sorted names put attempt before commit. Commit-only or changed
			// pairs cannot become a complete canonical preservation snapshot.
			if !present || !bytes.Equal(raw, []byte(hex.EncodeToString(attempt.digest[:]))) {
				return fail()
			}
		}
	}
	_, unknownPresent := files[resultUnknown]
	if _, present := files[resultClaim]; !present || a.unknown != unknownPresent || a.verify(ctx) != nil {
		return fail()
	}
	for name, file := range files {
		var current unix.Stat_t
		if ctx.Err() != nil || unix.Fstatat(d.dir, name, &current, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(file.meta, current) {
			return fail()
		}
	}
	raw, err := json.Marshal(digests)
	if err != nil {
		return fail()
	}
	value.SnapshotDigest = sha256.Sum256(raw)
	return value, files, nil
}

// A preservation read additionally permits an empty/partial UNKNOWN marker.
// Every named descriptor is regular, private, singly linked and stable before
// and after the bounded read. No result text escapes this private scan.
func readPreservationFile(ctx context.Context, d *resultDisk, name string, limit int) ([]byte, preservationFile, error) {
	if ctx.Err() != nil || d.checkPhysical() != nil {
		return nil, preservationFile{}, Unavailable
	}
	fd, err := unix.Openat(d.dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, preservationFile{}, Refused
	}
	f := os.NewFile(uintptr(fd), "chat-result-preservation-record")
	before, statErr := resultStat(fd)
	var named unix.Stat_t
	if statErr != nil || !resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || before.Size < 0 || before.Size > int64(limit) || before.Size == 0 && name != resultUnknown || unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(before, named) {
		_ = f.Close()
		return nil, preservationFile{}, Refused
	}
	raw, readErr := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	after, statErr := resultStat(fd)
	ok := readErr == nil && statErr == nil && len(raw) == int(before.Size) && resultStable(before, after) && unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && resultStable(after, named)
	closed := f.Close()
	if !ok || closed != nil || d.checkPhysical() != nil || ctx.Err() != nil {
		return nil, preservationFile{}, Refused
	}
	return raw, preservationFile{meta: before, digest: sha256.Sum256(raw)}, nil
}
