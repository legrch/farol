//go:build darwin || linux

package results

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// No mutable owner, fsync, repair, fence publication or retirement path reaches
// this selected adapter. Its existing claim is opened read-only and released at
// the end of one query. A retained UNKNOWN marker remains an explicit observation.
type archiveDisk struct {
	d           *resultDisk
	claim       []byte
	unknown     bool
	unknownMeta unix.Stat_t
}

func openArchiveDisk(ctx context.Context, root Root) (_ *archiveDisk, err error) {
	if !validID(root.ProfileID) || root.Identity.Device == 0 || root.Identity.Inode == 0 || root.Identity.OwnerUID != uint32(os.Geteuid()) || !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path {
		return nil, Invalid
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return nil, Refused
	}
	d := &resultDisk{root: root, rootFD: -1, dir: -1, claim: -1}
	retained := false
	defer func() {
		if !retained && d.close() != nil {
			err = Unavailable
		}
	}()
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	d.rootFD, err = unix.Open(root.Path, flags, 0)
	if err != nil {
		return nil, Refused
	}
	d.rootMeta, err = resultStat(d.rootFD)
	if err != nil || !resultQualified(d.rootMeta, root.Identity) || d.checkRoots(false) != nil {
		return nil, Refused
	}
	d.dir, err = unix.Openat(d.rootFD, resultChild, flags, 0)
	if err != nil {
		return nil, Refused
	}
	d.dirMeta, err = resultStat(d.dir)
	if err != nil || !resultPhysical(d.dirMeta, unix.S_IFDIR, 0700, root.Identity.OwnerUID) {
		return nil, Refused
	}
	d.childIdentity = port.JournalRoot{Device: uint64(d.dirMeta.Dev), Inode: uint64(d.dirMeta.Ino), OwnerUID: d.dirMeta.Uid}
	if !validRoots(root.Identity, d.childIdentity) || d.checkRoots(true) != nil {
		return nil, Refused
	}
	d.claim, err = unix.Openat(d.dir, resultClaim, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, Refused
	}
	d.claimMeta, err = resultStat(d.claim)
	if err != nil || !resultPhysical(d.claimMeta, unix.S_IFREG, 0600, root.Identity.OwnerUID) || unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB) != nil || d.checkPhysical() != nil {
		return nil, Refused
	}
	expected, err := json.Marshal(resultClaimRecord{1, root.ProfileID, root.Identity, d.identity()})
	if err != nil {
		return nil, Invalid
	}
	raw, err := archiveFile(ctx, d, resultClaim, len(expected))
	if err != nil {
		return nil, observed(err)
	}
	if !bytes.Equal(raw, expected) {
		return nil, Refused
	}
	a := &archiveDisk{d: d, claim: raw}
	err = unix.Fstatat(d.dir, resultUnknown, &a.unknownMeta, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil {
		a.unknown = true
		if !resultPhysical(a.unknownMeta, unix.S_IFREG, 0600, root.Identity.OwnerUID) {
			return nil, Refused
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return nil, Refused
	}
	if err := a.verify(ctx); err != nil {
		return nil, observed(err)
	}
	retained = true
	return a, nil
}

func (a *archiveDisk) verify(ctx context.Context) error {
	d := a.d
	if ctx.Err() != nil || d.checkPhysical() != nil {
		return Unavailable
	}
	root, re := resultStat(d.rootFD)
	dir, de := resultStat(d.dir)
	if re != nil || de != nil || !resultStable(root, d.rootMeta) || !resultStable(dir, d.dirMeta) {
		return Refused
	}
	raw, err := archiveFile(ctx, d, resultClaim, len(a.claim))
	if err != nil {
		return observed(err)
	}
	if !bytes.Equal(raw, a.claim) {
		return Refused
	}
	var unknown unix.Stat_t
	err = unix.Fstatat(d.dir, resultUnknown, &unknown, unix.AT_SYMLINK_NOFOLLOW)
	if a.unknown {
		if err != nil || !resultStable(unknown, a.unknownMeta) {
			return Refused
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return Refused
	}
	return nil
}

// Same descriptor/name/owner/root qualification as normal result reads, selected
// independently and using physical checks only. A retained result UNKNOWN is
// never bypassed to open a writer or advertised as a known-success publication.
func archiveFile(ctx context.Context, d *resultDisk, name string, limit int) ([]byte, error) {
	if ctx.Err() != nil || d.checkPhysical() != nil {
		return nil, Unavailable
	}
	fd, err := unix.Openat(d.dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, Refused
	}
	f := os.NewFile(uintptr(fd), "chat-archive-observation")
	before, err := resultStat(fd)
	var named unix.Stat_t
	if err != nil || !resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || before.Size < 1 || before.Size > int64(limit) || unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, before) {
		_ = f.Close()
		return nil, Refused
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	after, se := resultStat(fd)
	ok := err == nil && se == nil && len(raw) == int(before.Size) && resultStable(before, after) && unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && resultStable(named, after)
	closed := f.Close()
	if !ok || closed != nil || d.checkPhysical() != nil {
		return nil, Refused
	}
	if ctx.Err() != nil {
		return nil, Unavailable // the budget ended mid-read; the bytes were not judged
	}
	return raw, nil
}

func (a *archiveDisk) record(ctx context.Context, key string) (*port.ArchivedReply, string, error) {
	raw, err := archiveFile(ctx, a.d, key+".attempt", port.MaxResultRecordBytes)
	if err != nil {
		return nil, "", err
	}
	commit, err := archiveFile(ctx, a.d, key+".commit", 64)
	if err != nil {
		return nil, "", observed(err)
	}
	digest := sha256.Sum256(raw)
	if !bytes.Equal(commit, []byte(hex.EncodeToString(digest[:]))) {
		return nil, "", Refused
	}
	r, err := decodeResult(raw)
	if err != nil || r.Root != a.d.root.Identity || r.StorageRoot != a.d.identity() || r.Request.Binding.ProfileID != a.d.root.ProfileID || resultKey(r.Request) != key {
		return nil, "", Refused
	}
	q := r.Request
	if !utf8.Valid(q.Payload) {
		return nil, q.Binding.OwnerID, nil
	}
	return &port.ArchivedReply{Summary: port.ArchiveSummary{Key: key, ProfileID: q.Binding.ProfileID, OwnerID: q.Binding.OwnerID, BackendGeneration: q.Binding.BackendGeneration, OperationID: q.Binding.OperationID, ResultID: q.Result.ID, ConversationID: q.Conversation.ProviderConversationID, RecordedOutcome: string(q.Result.Outcome), Bytes: len(q.Payload), Digest: digest}, Text: string(q.Payload)}, q.Binding.OwnerID, nil
}

func (a *Archive) listArchive(ctx context.Context, selection port.ArchiveListSelection) (result *port.ArchivePage, err error) {
	return a.observeArchive(ctx, selection, nil)
}

// A visitor streams qualified metadata to the retired namespace projection.
// It never escapes the original read-only claim or exposes unverified text.
func (a *Archive) observeArchive(ctx context.Context, selection port.ArchiveListSelection, visit func(port.ArchiveSummary) error) (result *port.ArchivePage, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	disk, err := openArchiveDisk(ctx, a.root)
	if err != nil {
		return nil, err
	}
	defer func() {
		if disk.d.close() != nil {
			result = nil
			err = Unavailable
		}
	}()
	fd, err := unix.Openat(disk.d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, Refused
	}
	f := os.NewFile(uintptr(fd), "chat-archive-directory")
	defer func() {
		if f.Close() != nil {
			result = nil
			err = Unavailable
		}
	}()
	opened, err := resultStat(fd)
	if err != nil || !resultStable(opened, disk.d.dirMeta) {
		return nil, Refused
	}
	page := &port.ArchivePage{Entries: []port.ArchiveSummary{}, Unresolved: disk.unknown}
	claimSeen := false
	for {
		if ctx.Err() != nil {
			return nil, Unavailable
		}
		entries, readErr := f.ReadDir(64)
		if readErr != nil && readErr != io.EOF {
			return nil, Unavailable
		}
		for _, entry := range entries {
			name := entry.Name()
			if name == resultClaim {
				claimSeen = true
				continue
			}
			if name == resultUnknown {
				continue
			}
			key, kind, ok := strings.Cut(name, ".")
			if !ok || !validResultKey(key) || kind != "commit" && kind != "attempt" {
				page.Unresolved = true
				continue
			}
			if kind == "attempt" {
				var commit unix.Stat_t
				if unix.Fstatat(disk.d.dir, key+".commit", &commit, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultPhysical(commit, unix.S_IFREG, 0600, a.root.Identity.OwnerUID) {
					page.Unresolved = true
				}
				continue
			}
			reply, owner, err := disk.record(ctx, key)
			if err != nil {
				return nil, err
			}
			if owner != selection.OwnerID {
				continue
			}
			if reply == nil {
				page.Unresolved = true
				continue
			}
			if key <= selection.After {
				continue
			}
			if visit != nil {
				if err := visit(reply.Summary); err != nil {
					return nil, err
				}
				continue
			}
			page.Entries = append(page.Entries, reply.Summary)
			sort.Slice(page.Entries, func(i, j int) bool { return page.Entries[i].Key < page.Entries[j].Key })
			if len(page.Entries) > port.ArchivePageSize+1 {
				page.Entries = page.Entries[:port.ArchivePageSize+1]
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	if !claimSeen {
		return nil, Refused
	}
	if len(page.Entries) > port.ArchivePageSize {
		page.Entries = page.Entries[:port.ArchivePageSize]
		page.Next = page.Entries[len(page.Entries)-1].Key
	}
	// Every exposed summary still matches its original complete pair after the
	// streaming scan. Neither directory order nor a valid commit creates an ACK.
	for _, summary := range page.Entries {
		reply, owner, err := disk.record(ctx, summary.Key)
		if err != nil {
			return nil, observed(err)
		}
		if reply == nil || owner != selection.OwnerID || reply.Summary != summary {
			return nil, Refused
		}
	}
	if err := disk.verify(ctx); err != nil {
		return nil, observed(err)
	}
	return page, nil
}

func (a *Archive) readArchive(ctx context.Context, selection port.ArchiveReadSelection) (result *port.ArchivedReply, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	disk, err := openArchiveDisk(ctx, a.root)
	if err != nil {
		return nil, err
	}
	defer func() {
		if disk.d.close() != nil {
			result = nil
			err = Unavailable
		}
	}()
	reply, owner, err := disk.record(ctx, selection.Key)
	if err != nil {
		return nil, observed(err)
	}
	if reply == nil || owner != selection.OwnerID || reply.Summary.Digest != selection.Digest {
		return nil, Refused
	}
	again, owner, err := disk.record(ctx, selection.Key)
	if err != nil {
		return nil, observed(err)
	}
	if again == nil || owner != selection.OwnerID || *again != *reply {
		return nil, Refused
	}
	if err := disk.verify(ctx); err != nil {
		return nil, observed(err)
	}
	return reply, nil
}

// observed keeps an unavailable observation (an ended budget or a store that
// could not be read) distinct from a refusal of the bytes that were judged.
// Durable reference: missing or busy storage is unavailable; invalid committed
// pairs refuse.
func observed(err error) error {
	if errors.Is(err, Unavailable) {
		return Unavailable
	}
	return Refused
}
