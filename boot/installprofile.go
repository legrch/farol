package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/legrch/farol/pkg/limit"
	"golang.org/x/sys/unix"
)

// An empty slot may retain a completed update profile after the app was
// removed. This admission is intentionally narrower than startup's recovery
// policy. Startup still authenticates the complete history and installed tree.
type installProfileState struct {
	fresh       bool
	fingerprint [32]byte
}

type installProfileLease struct {
	file     *os.File
	path     string
	identity os.FileInfo
}

// The replacement owner holds this fixed promotion lease before publishing
// installed-replacement.pending. Hold the same inode through placement so a
// marker cannot appear between the last profile check and the namespace move.
func acquireInstallProfileLease(profile string) (*installProfileLease, error) {
	refuse := func() (*installProfileLease, error) {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	if installPathAbsent(profile) {
		return nil, nil
	}
	if _, err := installPrivateIdentity(profile); err != nil {
		return refuse()
	}
	state := filepath.Join(profile, "farol-state")
	if _, err := installPrivateIdentity(state); err != nil {
		return refuse()
	}
	path := filepath.Join(state, "promotion.lease")
	before, err := os.Lstat(path)
	if err != nil || !installPromotionLeaseInfo(before) {
		return refuse()
	}
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return refuse()
	}
	file := os.NewFile(uintptr(fd), path)
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) || !installPromotionLeaseInfo(opened) {
		file.Close()
		return refuse()
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return refuse()
	}
	lease := &installProfileLease{file: file, path: path, identity: before}
	if lease.recheck() != nil {
		file.Close()
		return refuse()
	}
	return lease, nil
}

func installPromotionLeaseInfo(info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Uid == uint32(os.Geteuid()) && st.Nlink == 1
}

func (lease *installProfileLease) recheck() error {
	if lease == nil {
		return nil
	}
	current, err := os.Lstat(lease.path)
	if err != nil || !os.SameFile(lease.identity, current) || !installPromotionLeaseInfo(current) {
		return errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	return nil
}

type installBuild struct {
	Digest  string `json:"digest"`
	Version string `json:"version"`
	BuildID string `json:"buildId"`
}
type installOperation struct {
	ID     string       `json:"operationId"`
	Source installBuild `json:"source"`
	Target installBuild `json:"target"`
}
type installSavedUpdate struct {
	Schema          string           `json:"schema"`
	Handle          string           `json:"handle"`
	ObservedAt      string           `json:"observedAt"`
	Notes           string           `json:"notes,omitempty"`
	DownloadID      string           `json:"downloadId,omitempty"`
	ArchiveReleased *bool            `json:"archiveReleased,omitempty"`
	Phase           string           `json:"phase"`
	RunningBuildID  string           `json:"runningBuildId"`
	Operation       installOperation `json:"operation"`
	Manifest        struct {
		Schema           string `json:"schema"`
		Repository       string `json:"repository"`
		Channel          string `json:"channel"`
		Product          string `json:"product"`
		BundleID         string `json:"bundleId"`
		Version          string `json:"version"`
		BuildVersion     string `json:"buildVersion"`
		SourceCommit     string `json:"sourceCommit"`
		SourceTreeDigest string `json:"sourceTreeDigest"`
		BuildID          string `json:"buildId"`
		ArtifactSha256   string `json:"artifactSha256"`
		ArchiveSha256    string `json:"archiveSha256"`
		ArchiveName      string `json:"archiveName"`
		ArchiveSize      int64  `json:"archiveSize"`
		Platform         string `json:"platform"`
		Arch             string `json:"arch"`
		Signing          string `json:"signing"`
		Notarized        bool   `json:"notarized"`
		SourceDirty      bool   `json:"sourceDirty"`
	} `json:"manifest"`
	Helper *struct {
		PID          int     `json:"pid"`
		ProcessStart *string `json:"processStart"`
	} `json:"helper"`
}
type installJournal struct {
	Schema      string       `json:"schema"`
	Phase       string       `json:"phase"`
	OperationID string       `json:"operationId"`
	Source      installBuild `json:"source"`
	Target      installBuild `json:"target"`
}

func installStableVersion(version string) bool {
	_, ok := parseInstallVersion(version)
	return ok
}
func parseInstallVersion(version string) ([3]uint64, bool) {
	var parts [3]uint64
	items := strings.Split(version, ".")
	if len(items) != 3 {
		return parts, false
	}
	for i, item := range items {
		value, err := strconv.ParseUint(item, 10, 64)
		if err != nil || strconv.FormatUint(value, 10) != item {
			return parts, false
		}
		parts[i] = value
	}
	return parts, true
}
func installBuildVersion(value string) bool {
	if len(value) == 0 || len(value) > 9 {
		return false
	}
	n, err := strconv.ParseUint(value, 10, 64)
	return err == nil && n > 0 && strconv.FormatUint(n, 10) == value
}
func compareInstallVersion(a, b string) (int, bool) {
	left, ok := parseInstallVersion(a)
	right, valid := parseInstallVersion(b)
	if !ok || !valid {
		return 0, false
	}
	for i := range left {
		if left[i] < right[i] {
			return -1, true
		}
		if left[i] > right[i] {
			return 1, true
		}
	}
	return 0, true
}
func installDigest(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
func validInstallBuild(value installBuild) bool {
	return installDigest(value.Digest) && installDigest(value.BuildID) && installStableVersion(value.Version)
}
func installPathAbsent(path string) bool {
	_, err := os.Lstat(path)
	return errors.Is(err, os.ErrNotExist)
}
func installPrivateIdentity(path string) (string, error) {
	if privateInstallDirectory(path) != nil {
		return "", errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || canonical != path {
		return "", errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	return fmt.Sprintf("%d:%d:%d:%d", st.Dev, st.Ino, st.Uid, info.Mode().Perm()), nil
}
func installPrivateFile(path string, maximum int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode().Perm() != 0600 || before.Size() > maximum {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	st, ok := before.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Geteuid()) || st.Nlink != 1 {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	openedStat, openedOK := opened.Sys().(*syscall.Stat_t)
	if !openedOK || openedStat.Nlink != 1 {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	data, err := limit.Read(f, maximum)
	if err != nil {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	after, afterErr := f.Stat()
	named, namedErr := os.Lstat(path)
	if afterErr != nil || namedErr != nil || !os.SameFile(before, after) || !os.SameFile(before, named) || after.Size() != before.Size() || named.Size() != before.Size() {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	afterStat, afterOK := after.Sys().(*syscall.Stat_t)
	namedStat, namedOK := named.Sys().(*syscall.Stat_t)
	if !afterOK || !namedOK || afterStat.Nlink != 1 || namedStat.Nlink != 1 || afterStat.Uid != st.Uid || namedStat.Uid != st.Uid || after.Mode() != before.Mode() || named.Mode() != before.Mode() {
		return nil, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	return data, nil
}
func installHelperExited(ctx context.Context, pid int) bool {
	if pid < 2 {
		return false
	}
	output, err := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=").CombinedOutput()
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == 1 && len(output) == 0
}

func inspectInstallProfile(ctx context.Context, profile, installed string, candidate installReleaseManifest) (installProfileState, error) {
	return inspectInstallProfileWithHelper(ctx, profile, installed, candidate, installHelperExited)
}

func inspectInstallProfileWithHelper(ctx context.Context, profile, installed string, candidate installReleaseManifest, helperExited func(context.Context, int) bool) (installProfileState, error) {
	refuse := func() (installProfileState, error) {
		return installProfileState{}, errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	for _, path := range []string{installed + ".receipt.json", installed + ".repair.json", filepath.Join(filepath.Dir(installed), ".farol-closed-repair.json")} {
		if !installPathAbsent(path) {
			return refuse()
		}
	}
	if !installPathAbsent(filepath.Join(profile, "farol-state", "installed-replacement.pending")) {
		return refuse()
	}
	if installPathAbsent(profile) {
		return installProfileState{fresh: true}, nil
	}
	profileID, err := installPrivateIdentity(profile)
	if err != nil {
		return refuse()
	}
	root := filepath.Join(profile, "installed-updates")
	rootID, err := installPrivateIdentity(root)
	if err != nil {
		return refuse()
	}
	for _, name := range []string{"ready.json", "restore-pending.json", "download-pending.json", "package-cleanup-pending.json"} {
		if !installPathAbsent(filepath.Join(root, name)) {
			return refuse()
		}
	}
	savedBytes, err := installPrivateFile(filepath.Join(root, "last-update.json"), 65536)
	if err != nil {
		return refuse()
	}
	var saved installSavedUpdate
	if json.Unmarshal(savedBytes, &saved) != nil || !installSavedReceipt(savedBytes, saved) || saved.Schema != "farol.ready-update/1" || saved.Phase != "completed" || saved.Operation.ID == "" || len(saved.Operation.ID) != 32 || !validInstallBuild(saved.Operation.Source) || !validInstallBuild(saved.Operation.Target) || saved.RunningBuildID != saved.Operation.Target.BuildID || saved.Manifest.Schema != "farol.github-release/1" || saved.Manifest.Version != saved.Operation.Target.Version || saved.Manifest.BuildID != saved.Operation.Target.BuildID || saved.Manifest.ArtifactSha256 != saved.Operation.Target.Digest || !installBuildVersion(saved.Manifest.BuildVersion) || saved.Helper == nil || saved.Helper.ProcessStart == nil || *saved.Helper.ProcessStart == "" || !helperExited(ctx, saved.Helper.PID) {
		return refuse()
	}
	for _, c := range saved.Operation.ID {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return refuse()
		}
	}
	comparison, valid := compareInstallVersion(candidate.Version, saved.Operation.Target.Version)
	if !valid || comparison < 0 {
		return refuse()
	}
	if comparison == 0 {
		if candidate.BuildID != saved.Operation.Target.BuildID || candidate.ArtifactSha256 != saved.Operation.Target.Digest || candidate.BuildVersion != saved.Manifest.BuildVersion {
			return refuse()
		}
	} else {
		currentBuild, _ := strconv.ParseUint(saved.Manifest.BuildVersion, 10, 64)
		nextBuild, err := strconv.ParseUint(candidate.BuildVersion, 10, 64)
		if err != nil || nextBuild <= currentBuild {
			return refuse()
		}
	}
	opDir := filepath.Join(root, saved.Operation.ID)
	opID, err := installPrivateIdentity(opDir)
	if err != nil {
		return refuse()
	}
	journalBytes, err := installPrivateFile(filepath.Join(opDir, "journal.json"), 65536)
	if err != nil {
		return refuse()
	}
	var journal installJournal
	if json.Unmarshal(journalBytes, &journal) != nil || !installSavedJournal(journalBytes, journal) || journal.Schema != "farol.installed-update-journal/1" || journal.Phase != "completed" || journal.OperationID != saved.Operation.ID || journal.Source != saved.Operation.Source || journal.Target != saved.Operation.Target {
		return refuse()
	}
	bindingBytes, err := installPrivateFile(filepath.Join(opDir, "slot-binding.json"), 8192)
	if err != nil {
		return refuse()
	}
	ordered := func(value installBuild) any {
		return struct {
			BuildID string `json:"buildId"`
			Digest  string `json:"digest"`
			Version string `json:"version"`
		}{value.BuildID, value.Digest, value.Version}
	}
	expected, _ := json.Marshal(struct {
		InstallLocation string `json:"installLocation"`
		OperationID     string `json:"operationId"`
		Schema          string `json:"schema"`
		Source          any    `json:"source"`
		Target          any    `json:"target"`
	}{"shared", saved.Operation.ID, "farol.installed-operation-slot/1", ordered(saved.Operation.Source), ordered(saved.Operation.Target)})
	if !bytes.Equal(bindingBytes, append(expected, '\n')) {
		return refuse()
	}
	adoptedBytes := []byte("absent")
	adoptedPath := filepath.Join(root, "adopted-baseline.json")
	if !installPathAbsent(adoptedPath) {
		adoptedBytes, err = installPrivateFile(adoptedPath, 65536)
		if err != nil || !installAdoptedBaseline(adoptedBytes, profile, candidate) {
			return refuse()
		}
	}
	for _, item := range []struct{ path, identity string }{{profile, profileID}, {root, rootID}, {opDir, opID}} {
		again, err := installPrivateIdentity(item.path)
		if err != nil || again != item.identity {
			return refuse()
		}
	}
	// A second observation at the native fence must see the same selected
	// directories and exact relevant records, not merely another valid profile.
	fingerprint := sha256.New()
	for _, item := range [][]byte{[]byte(profileID), []byte(rootID), []byte(opID), savedBytes, journalBytes, bindingBytes, adoptedBytes} {
		fingerprint.Write([]byte{0})
		fingerprint.Write(item)
	}
	var state installProfileState
	copy(state.fingerprint[:], fingerprint.Sum(nil))
	return state, nil
}

func recheckInstallProfile(ctx context.Context, profile, installed string, candidate installReleaseManifest, original installProfileState) error {
	return recheckInstallProfileWithHelper(ctx, profile, installed, candidate, original, installHelperExited)
}

func recheckInstallProfileWithHelper(ctx context.Context, profile, installed string, candidate installReleaseManifest, original installProfileState, helperExited func(context.Context, int) bool) error {
	current, err := inspectInstallProfileWithHelper(ctx, profile, installed, candidate, helperExited)
	if err != nil || current != original {
		return errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
	}
	return nil
}
