//go:build darwin || linux

package results

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

type retiredSelection struct {
	name, original string
	root           Root
	summary        port.ArchiveSummary
}

// scan holds the selected physical profile and streams directory entries. Each
// old result namespace takes only its original read-only claim. There is no
// inventory ceiling and no open of the current writer's Chat result store.
func (a *RetiredArchive) scan(ctx context.Context, owner string, visit func(retiredSelection) error, finish func() error) (unresolved bool, err error) {
	root := a.profile
	if !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || root.Identity.Device == 0 || root.Identity.Inode == 0 || root.Identity.OwnerUID != uint32(os.Geteuid()) {
		return false, Invalid
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return false, Refused
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, Refused
	}
	f := os.NewFile(uintptr(fd), "retired-chat-profile")
	defer func() {
		if f.Close() != nil {
			err = Unavailable
		}
	}()
	before, err := resultStat(fd)
	if err != nil || !resultQualified(before, root.Identity) {
		return false, Refused
	}
	verify := func() error {
		opened, oe := resultStat(fd)
		var named unix.Stat_t
		ne := unix.Lstat(root.Path, &named)
		physical, pe := filepath.EvalSymlinks(root.Path)
		if ctx.Err() != nil || oe != nil || ne != nil || pe != nil || physical != root.Path || !resultStable(before, opened) || !resultStable(before, named) {
			return Refused
		}
		return nil
	}
	for {
		if ctx.Err() != nil {
			return false, Unavailable
		}
		entries, readErr := f.ReadDir(64)
		if readErr != nil && readErr != io.EOF {
			return false, Unavailable
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasPrefix(name, "chat-retired-") {
				continue
			}
			if !retiredName(name) {
				unresolved = true
				continue
			}
			var metadata unix.Stat_t
			if unix.Fstatat(fd, name, &metadata, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultPhysical(metadata, unix.S_IFDIR, 0700, root.Identity.OwnerUID) {
				return false, Refused
			}
			selected := Root{Path: filepath.Join(root.Path, name), ProfileID: root.ProfileID, Identity: port.JournalRoot{Device: uint64(metadata.Dev), Inode: uint64(metadata.Ino), OwnerUID: metadata.Uid}}
			page, err := NewArchive(selected).observeArchive(ctx, port.ArchiveListSelection{ProfileID: root.ProfileID, OwnerID: owner}, func(summary port.ArchiveSummary) error {
				original := summary.Key
				summary.Key = retiredKey(name, original)
				return visit(retiredSelection{name: name, original: original, root: selected, summary: summary})
			})
			if err != nil {
				return false, err
			}
			unresolved = unresolved || page.Unresolved
			var after unix.Stat_t
			if unix.Fstatat(fd, name, &after, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(metadata, after) || verify() != nil {
				return false, Refused
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	if err := verify(); err != nil {
		return false, err
	}
	if err := finish(); err != nil {
		return false, err
	}
	if err := verify(); err != nil {
		return false, err
	}
	return unresolved, nil
}

func (a *RetiredArchive) readSelected(ctx context.Context, owner string, selection retiredSelection) (*port.ArchivedReply, error) {
	reply, err := NewArchive(selection.root).ReadStoredReply(ctx, port.ArchiveReadSelection{ProfileID: a.profile.ProfileID, OwnerID: owner, Key: selection.original, Digest: selection.summary.Digest})
	if err != nil {
		return nil, err
	}
	reply.Summary.Key = retiredKey(selection.name, reply.Summary.Key)
	if reply.Summary != selection.summary {
		return nil, Refused
	}
	return reply, nil
}

func (a *RetiredArchive) ListStoredReplies(ctx context.Context, selection port.ArchiveListSelection) (*port.ArchivePage, error) {
	if !a.valid(ctx, selection.ProfileID, selection.OwnerID) || selection.After != "" && !validResultKey(selection.After) {
		return nil, Invalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	selected := make([]retiredSelection, 0, port.ArchivePageSize+1)
	page := &port.ArchivePage{Entries: []port.ArchiveSummary{}}
	unresolved, err := a.scan(ctx, selection.OwnerID, func(value retiredSelection) error {
		if value.summary.Key <= selection.After {
			return nil
		}
		for _, current := range selected {
			if current.summary.Key == value.summary.Key {
				return Refused
			}
		}
		selected = append(selected, value)
		sort.Slice(selected, func(i, j int) bool { return selected[i].summary.Key < selected[j].summary.Key })
		if len(selected) > port.ArchivePageSize+1 {
			selected = selected[:port.ArchivePageSize+1]
		}
		return nil
	}, func() error {
		if len(selected) > port.ArchivePageSize {
			selected = selected[:port.ArchivePageSize]
			page.Next = selected[len(selected)-1].summary.Key
		}
		for _, value := range selected {
			reply, err := a.readSelected(ctx, selection.OwnerID, value)
			if err != nil {
				return err
			}
			page.Entries = append(page.Entries, reply.Summary)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	page.Unresolved = unresolved
	if ctx.Err() != nil {
		return nil, Unavailable
	}
	return page, nil
}

func (a *RetiredArchive) ReadStoredReply(ctx context.Context, selection port.ArchiveReadSelection) (*port.ArchivedReply, error) {
	if !a.valid(ctx, selection.ProfileID, selection.OwnerID) || !validResultKey(selection.Key) || selection.Digest == ([32]byte{}) {
		return nil, Invalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var selected *retiredSelection
	var reply *port.ArchivedReply
	_, err := a.scan(ctx, selection.OwnerID, func(value retiredSelection) error {
		if value.summary.Key != selection.Key {
			return nil
		}
		if selected != nil || value.summary.Digest != selection.Digest {
			return Refused
		}
		selected = &value
		return nil
	}, func() error {
		if selected == nil {
			return Refused
		}
		var err error
		reply, err = a.readSelected(ctx, selection.OwnerID, *selected)
		return err
	})
	if err != nil {
		return nil, err
	}
	return reply, nil
}

var _ port.StoredReplyArchive = (*RetiredArchive)(nil)
