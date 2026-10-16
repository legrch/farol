//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"golang.org/x/sys/unix"
)

// Prior archives remain opaque historical custody. Their bytes never qualify
// current effects or authority. Bound all names and contents; do not ignore a
// hidden parent entry merely because the three current journal roots validate.
type preservedProfileInventory struct {
	root        NativeRoot
	version     unix.Stat_t
	names       map[string]uint32
	metadata    *preservedProfileMetadata
	archives    map[string]*preservedChatInventory
	chat        *preservedChatInventory
	archiveName string
}
type preservedProfileMetadata struct {
	version unix.Stat_t
	digest  [32]byte
}
type preservedChatInventory struct {
	root     NativeRoot
	version  unix.Stat_t
	files    map[string]emptyRecoveryFile
	versions map[string]unix.Stat_t
}

func preservedProfileArchiveName(name string) bool {
	if !strings.HasPrefix(name, "chat-retired-") || len(name) != 49 {
		return false
	}
	for n, c := range name[13:] {
		if n == 8 || n == 13 || n == 18 || n == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if c < '0' || c > '9' {
			if c < 'a' || c > 'f' {
				return false
			}
		}
	}
	return true
}

func preservedProfileMetadataAt(ctx context.Context, path string) (value preservedProfileMetadata, resultErr error) {
	if ctx == nil || ctx.Err() != nil {
		return value, handoff.Refused
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return value, handoff.Refused
	}
	f := os.NewFile(uintptr(fd), "preserved-profile-metadata")
	defer func() {
		if f.Close() != nil {
			resultErr = handoff.Refused
		}
	}()
	var before, after, named unix.Stat_t
	if unix.Fstat(fd, &before) != nil || uint32(before.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(before.Mode)&07777 != 0600 || before.Uid != uint32(os.Geteuid()) || before.Nlink != 1 || before.Size < 1 || before.Size > 65536 || ctx.Err() != nil {
		return value, handoff.Refused
	}
	raw, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(raw) != int(before.Size) || unix.Fstat(fd, &after) != nil || unix.Lstat(path, &named) != nil || !sameEmptyRecoveryStat(before, after) || !sameEmptyRecoveryStat(after, named) || ctx.Err() != nil {
		return value, handoff.Refused
	}
	return preservedProfileMetadata{version: before, digest: sha256.Sum256(raw)}, nil
}

func capturePreservedChatInventory(ctx context.Context, root NativeRoot) (*preservedChatInventory, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, handoff.Refused
	}
	value := &preservedChatInventory{root: root, versions: map[string]unix.Stat_t{}}
	if unix.Lstat(root.Path, &value.version) != nil {
		return nil, handoff.Refused
	}
	var err error
	value.files, err = emptyRecoveryArchiveFiles(ctx, root)
	if err != nil {
		return nil, err
	}
	for name := range value.files {
		if ctx.Err() != nil {
			return nil, handoff.Refused
		}
		var version unix.Stat_t
		if unix.Lstat(filepath.Join(root.Path, name), &version) != nil {
			return nil, handoff.Refused
		}
		value.versions[name] = version
	}
	if err := verifyPreservedChatInventory(ctx, value, root, false); err != nil {
		return nil, err
	}
	return value, nil
}

func verifyPreservedChatInventory(ctx context.Context, original *preservedChatInventory, root NativeRoot, relocated bool) error {
	if ctx == nil || ctx.Err() != nil || original == nil {
		return handoff.Refused
	}
	var version unix.Stat_t
	if unix.Lstat(root.Path, &version) != nil {
		return handoff.Refused
	}
	before := original.version
	if relocated {
		// Only the known exclusive root rename may change this directory's times.
		// Every descendant keeps its complete original physical version and bytes.
		if before.Dev != version.Dev || before.Ino != version.Ino || before.Mode != version.Mode || before.Uid != version.Uid || before.Gid != version.Gid || before.Nlink != version.Nlink || before.Size != version.Size {
			return handoff.Refused
		}
	} else if !sameEmptyRecoveryStat(before, version) {
		return handoff.Refused
	}
	current, err := emptyRecoveryArchiveFiles(ctx, root)
	if err != nil || !reflect.DeepEqual(original.files, current) {
		return handoff.Refused
	}
	for name, before := range original.versions {
		var current unix.Stat_t
		if ctx.Err() != nil || unix.Lstat(filepath.Join(root.Path, name), &current) != nil || !sameEmptyRecoveryStat(before, current) {
			return handoff.Refused
		}
	}
	var after unix.Stat_t
	if unix.Lstat(root.Path, &after) != nil || !sameEmptyRecoveryStat(version, after) || ctx.Err() != nil {
		return handoff.Refused
	}
	return nil
}

func capturePreservedProfileInventory(ctx context.Context, in preservedProfileInspectionInput, chat NativeRoot) (*preservedProfileInventory, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, handoff.Refused
	}
	value := &preservedProfileInventory{root: NativeRoot{Path: in.Profile.Root, ProfileID: in.Profile.ProfileID, Device: in.Profile.Device, Inode: in.Profile.Inode, OwnerUID: chat.OwnerUID, Mode: 0700}, names: map[string]uint32{"computer": unix.S_IFDIR, "chat": unix.S_IFDIR, "task": unix.S_IFDIR}, archives: map[string]*preservedChatInventory{}, archiveName: "chat-retired-" + in.Selection.OperationID}
	if unix.Lstat(in.Profile.Root, &value.version) != nil {
		return nil, handoff.Refused
	}
	fd, err := unix.Open(in.Profile.Root, profileOpenFlags, 0)
	if err != nil {
		return nil, handoff.Refused
	}
	f := os.NewFile(uintptr(fd), "preserved-profile-inventory")
	names, readErr := f.Readdirnames(13)
	more, endErr := f.Readdirnames(1)
	closeErr := f.Close()
	if readErr != nil && readErr != io.EOF || len(names) > 12 || len(more) != 0 || endErr != io.EOF || closeErr != nil || ctx.Err() != nil {
		return nil, handoff.Refused
	}
	for _, name := range names {
		if name == "computer" || name == "chat" || name == "task" {
			continue
		}
		if name == "profile.json" {
			metadata, err := preservedProfileMetadataAt(ctx, filepath.Join(in.Profile.Root, name))
			if err != nil {
				return nil, err
			}
			value.metadata = &metadata
			value.names[name] = unix.S_IFREG
			continue
		}
		if !preservedProfileArchiveName(name) || name == value.archiveName || len(value.archives) >= 8 {
			return nil, handoff.Refused
		}
		var st unix.Stat_t
		path := filepath.Join(in.Profile.Root, name)
		if unix.Lstat(path, &st) != nil || uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR || uint32(st.Mode)&07777 != 0700 || st.Uid != chat.OwnerUID || uint64(st.Dev) != chat.Device {
			return nil, handoff.Refused
		}
		archive, err := capturePreservedChatInventory(ctx, NativeRoot{Path: path, ProfileID: in.Profile.ProfileID, Device: uint64(st.Dev), Inode: st.Ino, OwnerUID: st.Uid, Mode: 0700})
		if err != nil {
			return nil, err
		}
		value.archives[name] = archive
		value.names[name] = unix.S_IFDIR
	}
	value.chat, err = capturePreservedChatInventory(ctx, chat)
	if err != nil {
		return nil, err
	}
	if err := verifyPreservedProfileInventory(ctx, value, nil); err != nil {
		return nil, err
	}
	return value, nil
}

func verifyPreservedProfileInventory(ctx context.Context, original *preservedProfileInventory, preserved *emptyRecoveryPreservation) error {
	if ctx == nil || ctx.Err() != nil || original == nil {
		return handoff.Refused
	}
	expected := make(map[string]uint32, len(original.names)+1)
	for name, kind := range original.names {
		expected[name] = kind
	}
	if preserved != nil {
		if filepath.Dir(preserved.Archive.Path) != original.root.Path || filepath.Base(preserved.Archive.Path) != original.archiveName {
			return handoff.Refused
		}
		expected[original.archiveName] = unix.S_IFDIR
	}
	if err := inspectExactRecoveryDirectory(ctx, original.root, expected); err != nil {
		return err
	}
	var version unix.Stat_t
	if unix.Lstat(original.root.Path, &version) != nil {
		return handoff.Refused
	}
	before := original.version
	if preserved == nil {
		if !sameEmptyRecoveryStat(before, version) {
			return handoff.Refused
		}
	} else if before.Dev != version.Dev || before.Ino != version.Ino || before.Mode != version.Mode || before.Uid != version.Uid || before.Gid != version.Gid || version.Nlink != before.Nlink+1 {
		return handoff.Refused
	}
	if original.metadata != nil {
		current, err := preservedProfileMetadataAt(ctx, filepath.Join(original.root.Path, "profile.json"))
		if err != nil || current.digest != original.metadata.digest || !sameEmptyRecoveryStat(original.metadata.version, current.version) {
			return handoff.Refused
		}
	}
	for _, archive := range original.archives {
		if err := verifyPreservedChatInventory(ctx, archive, archive.root, false); err != nil {
			return err
		}
	}
	root := original.chat.root
	if preserved != nil {
		root = preserved.Archive
	}
	if err := verifyPreservedChatInventory(ctx, original.chat, root, preserved != nil); err != nil {
		return err
	}
	var after unix.Stat_t
	if unix.Lstat(original.root.Path, &after) != nil || !sameEmptyRecoveryStat(version, after) || ctx.Err() != nil {
		return handoff.Refused
	}
	return nil
}
