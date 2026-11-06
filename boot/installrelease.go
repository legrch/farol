package boot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
	"github.com/legrch/farol/modules/release/infra/native/helperlocks"
	"github.com/legrch/farol/modules/release/infra/native/installmove"
	"golang.org/x/sys/unix"
)

// This command is available only from the verified target backend. It owns one
// bootstrap namespace attempt; it never starts a GUI or repairs update records.
type installReleaseInput struct{ staged, manifest, installed, evidence string }
type installReleaseManifest struct {
	Schema, Repository, Version, Platform, Arch, ArtifactSha256, BuildID string
}
type installReleaseRecord struct {
	Schema, ID, Phase, Version, BuildID, Digest string
}

func runInstallReleaseSwap(args []string, out io.Writer, diagnostics io.Writer) int {
	f := flag.NewFlagSet("run-install-release-swap", flag.ContinueOnError)
	f.SetOutput(diagnostics)
	input := installReleaseInput{}
	f.StringVar(&input.staged, "staged-app", "", "private staged bundle")
	f.StringVar(&input.manifest, "manifest", "", "verified release manifest")
	f.StringVar(&input.installed, "installed", "", "canonical installation slot")
	f.StringVar(&input.evidence, "evidence", "", "private attempt evidence")
	if f.Parse(args) != nil || f.NArg() != 0 || input.installed != "/Applications/Farol.app" || input.evidence == "" || input.staged != filepath.Join(input.evidence, "staged.app") || input.manifest != filepath.Join(input.evidence, "farol-release.json") {
		fmt.Fprintln(diagnostics, "INSTALL_INPUT_INVALID")
		return 2
	}
	if err := installReleaseSwap(context.Background(), input, out); err != nil {
		fmt.Fprintln(diagnostics, err)
		return 1
	}
	return 0
}

func installReleaseSwap(ctx context.Context, in installReleaseInput, out io.Writer) (result error) {
	if runtime.GOOS != "darwin" {
		return errors.New("INSTALL_PLATFORM_UNSUPPORTED")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	account, err := user.Current()
	if err != nil || account.HomeDir == "" || in.installed != "/Applications/Farol.app" {
		return errors.New("INSTALL_IDENTITY_UNAVAILABLE")
	}
	// This is not an environment-selected backend. The executable must be the
	// target image that the script just validated and extracted.
	self, err := os.Executable()
	expectedBackend := filepath.Join(in.evidence, "extracted", "Farol.app", "Contents", "Resources", "app", "farol-backend")
	selfInfo, selfErr := os.Stat(self)
	expectedInfo, expectedErr := os.Lstat(expectedBackend)
	if err != nil || selfErr != nil || expectedErr != nil || !expectedInfo.Mode().IsRegular() || !os.SameFile(selfInfo, expectedInfo) {
		return errors.New("INSTALL_TARGET_BACKEND_REQUIRED")
	}
	if err := privateInstallDirectory(in.evidence); err != nil {
		return err
	}
	m, err := readInstallManifest(in.manifest)
	if err != nil {
		return err
	}
	stageParent, err := openInstallDirectory(in.evidence)
	if err != nil {
		return err
	}
	defer stageParent.Close()
	stage, err := openInstallDirectory(in.staged)
	if err != nil {
		return err
	}
	defer stage.Close()
	apps, err := openInstallDirectory("/Applications")
	if err != nil {
		return err
	}
	defer apps.Close()
	stageID, err := installIdentity(stage)
	if err != nil {
		return err
	}
	appsID, err := installIdentity(apps)
	if err != nil {
		return err
	}
	if stageID.Device != appsID.Device {
		return errors.New("INSTALL_FILESYSTEM_MISMATCH")
	}
	verifyStage := func(ctx context.Context) error {
		v, e := apptree.New(stageParent, stage, "staged.app", apptree.Expected{TreeSHA256: m.ArtifactSha256, Version: m.Version, BuildID: m.BuildID}, appidentity.Verify)
		if e != nil {
			return e
		}
		_, e = v.Verify(ctx)
		return e
	}
	if err = verifyStage(ctx); err != nil {
		return errors.New("INSTALL_STAGED_TREE_INVALID")
	}
	if err = installSignatures(ctx, in.staged); err != nil {
		return err
	}
	// A fixed custody location survives the per-invocation temporary directory.
	// An unresolved intent from a previous process blocks every new attempt.
	cache := filepath.Join(account.HomeDir, "Library", "Caches", "io.github.legrch.farol-installer")
	if err = os.Mkdir(cache, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	if err = privateInstallDirectory(cache); err != nil {
		return err
	}
	lockFD, err := unix.Open(filepath.Join(cache, "lock"), unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	lock := os.NewFile(uintptr(lockFD), "installer-lock")
	defer lock.Close()
	lockInfo, err := lock.Stat()
	if err != nil || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm() != 0600 {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	lockStat, ok := lockInfo.Sys().(*syscall.Stat_t)
	if !ok || lockStat.Uid != uint32(os.Geteuid()) {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return errors.New("INSTALL_BUSY")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if err = checkedInstallRecord(cache); err != nil {
		return err
	}
	oldInfo, err := os.Lstat(in.installed)
	occupied := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("INSTALL_SLOT_UNAVAILABLE")
	}
	if occupied && (!oldInfo.IsDir() || oldInfo.Mode()&os.ModeSymlink != 0) {
		return errors.New("INSTALL_SLOT_INVALID")
	}
	profileRoot := filepath.Join(account.HomeDir, "Library", "Application Support", "io.github.legrch.farol")
	if !occupied {
		if err := installFreshProfileAbsent(profileRoot, in.installed); err != nil {
			return err
		}
	}
	if err := installProductionStopped(ctx); err != nil {
		return err
	}
	var updateLease, promotionLease *helperlocks.Lease
	var acceptedOld apptree.Expected
	if occupied {
		updatePath := filepath.Join(account.HomeDir, "Library", "Application Support", "io.github.legrch.farol", "installed-updates")
		statePath := filepath.Join(account.HomeDir, "Library", "Application Support", "io.github.legrch.farol", "farol-state")
		if err = settledInstallInventory(updatePath); err != nil {
			return err
		}
		lockInfo, lockErr := os.Lstat(filepath.Join(updatePath, "lock"))
		if lockErr != nil || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm() != 0600 {
			return errors.New("INSTALL_UPDATE_LOCK_UNAVAILABLE")
		}
		acceptedOld, err = acceptedInstallBuild(updatePath, profileRoot, in.installed)
		if err != nil {
			return err
		}
		update, e := openInstallDirectory(updatePath)
		if e != nil {
			return e
		}
		defer update.Close()
		state, e := openInstallDirectory(statePath)
		if e != nil {
			return e
		}
		defer state.Close()
		updateID, e := installIdentity(update)
		if e != nil {
			return e
		}
		stateID, e := installIdentity(state)
		if e != nil {
			return e
		}
		until, _ := ctx.Deadline()
		updateLease, err = helperlocks.AcquireUpdate(ctx, helperlocks.Directory{File: update, Identity: helperlocks.Identity(updateID)}, until)
		if err != nil {
			return errors.New("INSTALL_UPDATE_BUSY_OR_UNKNOWN")
		}
		defer updateLease.Close()
		promotionLease, err = helperlocks.AcquirePromotion(ctx, helperlocks.Directory{File: state, Identity: helperlocks.Identity(stateID)}, until)
		if err != nil {
			return errors.New("INSTALL_PROMOTION_BUSY_OR_UNKNOWN")
		}
		defer promotionLease.Close()
		if err = settledInstallInventory(updatePath); err != nil {
			return err
		}
	}
	var oldID installmove.Identity
	var verifyOld func(context.Context) error
	if occupied {
		old, e := openInstallDirectory(in.installed)
		if e != nil {
			return e
		}
		defer old.Close()
		oldID, err = installIdentity(old)
		if err != nil {
			return err
		}
		verifyOld = func(ctx context.Context) error {
			v, e := apptree.New(apps, old, "Farol.app", acceptedOld, appidentity.Verify)
			if e != nil {
				return e
			}
			_, e = v.Verify(ctx)
			return e
		}
		if err = verifyOld(ctx); err != nil {
			return errors.New("INSTALL_PREDECESSOR_IDENTITY_INVALID")
		}
	}
	if err = installSignatureAtSlot(ctx, occupied, in.installed); err != nil {
		return err
	}
	parentID, err := installIdentity(stageParent)
	if err != nil {
		return err
	}
	var bytes [16]byte
	if _, err = rand.Read(bytes[:]); err != nil {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	record := installReleaseRecord{Schema: "farol.bootstrap-install/1", ID: hex.EncodeToString(bytes[:]), Phase: "pending", Version: m.Version, BuildID: m.BuildID, Digest: m.ArtifactSha256}
	fence := func(ctx context.Context) error {
		if e := installProductionStopped(ctx); e != nil {
			return e
		}
		if !occupied {
			if e := installFreshProfileAbsent(profileRoot, in.installed); e != nil {
				return e
			}
		}
		if updateLease != nil {
			if e := updateLease.Verify(ctx); e != nil {
				return errors.New("INSTALL_UPDATE_LEASE_CHANGED")
			}
		}
		if promotionLease != nil {
			if e := promotionLease.Verify(ctx); e != nil {
				return errors.New("INSTALL_PROMOTION_LEASE_CHANGED")
			}
		}
		if e := verifyStage(ctx); e != nil {
			return errors.New("INSTALL_STAGED_TREE_CHANGED")
		}
		if e := installSlotIdentity(in.installed, occupied, oldID); e != nil {
			return e
		}
		if occupied {
			if e := verifyOld(ctx); e != nil {
				return errors.New("INSTALL_PREDECESSOR_CHANGED")
			}
			if e := installBundleID(ctx, in.installed); e != nil {
				return e
			}
		}
		return nil
	}
	left := installmove.Location{Parent: installmove.Directory{File: stageParent, Identity: parentID, Kind: installmove.OwnedParent}, Name: "staged.app"}
	right := installmove.Location{Parent: installmove.Directory{File: apps, Identity: appsID, Kind: installmove.SharedApplicationsParent}, Name: "Farol.app"}
	until, _ := ctx.Deadline()
	var operation *installmove.Operation
	if occupied {
		operation, err = installmove.PrepareExchange(left, right, stageID, oldID, until, fence)
	} else {
		operation, err = installmove.PrepareRename(left, right, stageID, until, fence)
	}
	if err != nil {
		return errors.New("INSTALL_SWAP_UNAVAILABLE")
	}
	if err = writeInstallRecord(cache, record); err != nil {
		return err
	}
	// The intent is durable before the one namespace effect. Any unexpected
	// failure from this point remains pending and prohibits an automatic retry.
	if err = operation.Run(ctx); err != nil {
		var failure *installmove.Failure
		if errors.As(err, &failure) && !failure.Uncertain && !failure.Internal {
			record.Phase = "refused"
			if e := writeInstallRecord(cache, record); e != nil {
				return errors.New("INSTALL_REFUSAL_RECORD_UNKNOWN")
			}
		}
		return fmt.Errorf("INSTALL_SWAP_OUTCOME_UNKNOWN_OR_REFUSED: %w", err)
	}
	if err = verifyInstalledRelease(ctx, apps, in.installed, m); err != nil {
		return err
	}
	if occupied {
		if err = os.Rename(in.staged, filepath.Join(in.evidence, "previous.app")); err != nil {
			return errors.New("INSTALL_PREDECESSOR_RETAINED_AT_STAGE_UNKNOWN")
		}
		if err = stageParent.Sync(); err != nil {
			return errors.New("INSTALL_PREDECESSOR_DURABILITY_UNKNOWN")
		}
	}
	record.Phase = "completed"
	if err = writeInstallRecord(cache, record); err != nil {
		return errors.New("INSTALL_COMPLETION_RECORD_UNKNOWN")
	}
	_, _ = fmt.Fprintln(out, "Native installation replacement completed")
	return nil
}

func installIdentity(f *os.File) (installmove.Identity, error) {
	s, err := f.Stat()
	if err != nil {
		return installmove.Identity{}, errors.New("INSTALL_IDENTITY_UNAVAILABLE")
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	if !ok {
		return installmove.Identity{}, errors.New("INSTALL_IDENTITY_UNAVAILABLE")
	}
	return installmove.Identity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(uint64(st.Ino), 10)}, nil
}

func openInstallDirectory(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("INSTALL_DIRECTORY_UNAVAILABLE")
	}
	return os.NewFile(uintptr(fd), path), nil
}
func privateInstallDirectory(path string) error {
	s, err := os.Lstat(path)
	if err != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 || s.Mode().Perm() != 0700 {
		return errors.New("INSTALL_PRIVATE_DIRECTORY_INVALID")
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Geteuid()) {
		return errors.New("INSTALL_PRIVATE_DIRECTORY_INVALID")
	}
	return nil
}
func readInstallManifest(path string) (installReleaseManifest, error) {
	var m installReleaseManifest
	s, err := os.Lstat(path)
	if err != nil || !s.Mode().IsRegular() || s.Size() > 65536 {
		return m, errors.New("INSTALL_MANIFEST_INVALID")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return m, errors.New("INSTALL_MANIFEST_INVALID")
	}
	var raw struct {
		Schema         string `json:"schema"`
		Repository     string `json:"repository"`
		Version        string `json:"version"`
		Platform       string `json:"platform"`
		Arch           string `json:"arch"`
		ArtifactSha256 string `json:"artifactSha256"`
		BuildID        string `json:"buildId"`
	}
	if json.Unmarshal(b, &raw) != nil || raw.Schema != "farol.github-release/1" || raw.Repository != "legrch/farol" || raw.Platform != "darwin" || raw.Arch != "arm64" || len(raw.ArtifactSha256) != 64 || len(raw.BuildID) != 64 || raw.Version == "" {
		return m, errors.New("INSTALL_MANIFEST_INVALID")
	}
	for _, h := range []string{raw.ArtifactSha256, raw.BuildID} {
		if _, e := hex.DecodeString(h); e != nil || h != strings.ToLower(h) {
			return m, errors.New("INSTALL_MANIFEST_INVALID")
		}
	}
	m = installReleaseManifest{raw.Schema, raw.Repository, raw.Version, raw.Platform, raw.Arch, raw.ArtifactSha256, raw.BuildID}
	return m, nil
}
func installSignatures(ctx context.Context, app string) error {
	for _, tc := range []struct {
		path   string
		ignore bool
	}{
		{filepath.Join(app, "Contents", "Resources", "app", "farol-backend"), false},
		{filepath.Join(app, "Contents", "Frameworks", "Electron Runtime.app", "Contents", "MacOS", "Electron"), true},
	} {
		args := []string{"--verify", "--strict"}
		if tc.ignore {
			args = append(args, "--ignore-resources")
		}
		args = append(args, tc.path)
		if exec.CommandContext(ctx, "/usr/bin/codesign", args...).Run() != nil {
			return errors.New("INSTALL_SIGNATURE_INVALID")
		}
	}
	return nil
}
func installSignatureAtSlot(ctx context.Context, occupied bool, path string) error {
	if !occupied {
		return nil
	}
	if err := installBundleID(ctx, path); err != nil {
		return err
	}
	return installSignatures(ctx, path)
}
func installBundleID(ctx context.Context, path string) error {
	b, err := exec.CommandContext(ctx, "/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", filepath.Join(path, "Contents", "Info.plist")).Output()
	if err != nil || strings.TrimSpace(string(b)) != "io.github.legrch.farol" {
		return errors.New("INSTALL_SLOT_IDENTITY_INVALID")
	}
	return nil
}
func installSlotIdentity(path string, occupied bool, expected installmove.Identity) error {
	s, err := os.Lstat(path)
	if !occupied {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return errors.New("INSTALL_SLOT_CHANGED")
	}
	if err != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return errors.New("INSTALL_SLOT_CHANGED")
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	if !ok || strconv.FormatUint(uint64(st.Dev), 10) != expected.Device || strconv.FormatUint(uint64(st.Ino), 10) != expected.Inode {
		return errors.New("INSTALL_SLOT_CHANGED")
	}
	return nil
}
func installFreshProfileAbsent(profile, installed string) error {
	for _, path := range []string{profile, installed + ".receipt.json", installed + ".repair.json", filepath.Join(filepath.Dir(installed), ".farol-closed-repair.json")} {
		_, err := os.Lstat(path)
		if !errors.Is(err, os.ErrNotExist) {
			return errors.New("INSTALL_FRESH_STATE_UNCONFIRMED")
		}
	}
	return nil
}

// The update and promotion locks exclude cooperative new writers. A current
// primary that already completed startup is additionally refused here. This
// inventory is conservative: an unclassified Farol backend is a refusal.
func installProductionStopped(ctx context.Context) error {
	output, err := exec.CommandContext(ctx, "/bin/ps", "-ww", "-axo", "pid=,comm=").Output()
	if err != nil || len(output) == 0 || len(output) > 4*1024*1024 {
		return errors.New("INSTALL_PROCESS_OBSERVATION_UNKNOWN")
	}
	return classifyInstallProcesses(string(output), os.Getpid())
}
func classifyInstallProcesses(output string, selfPID int) error {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		separator := strings.IndexAny(line, " \t")
		if separator < 1 {
			return errors.New("INSTALL_PROCESS_OBSERVATION_UNKNOWN")
		}
		pid, err := strconv.Atoi(line[:separator])
		name := strings.TrimSpace(line[separator:])
		if err != nil || pid < 1 || name == "" {
			return errors.New("INSTALL_PROCESS_OBSERVATION_UNKNOWN")
		}
		if pid == selfPID {
			continue
		}
		if strings.Contains(name, "/Applications/Farol.app/") || strings.Contains(name, "/launch-Farol.app/") || strings.Contains(name, "/installed-execution/") || name == "farol-backend" || name == "Farol" {
			return errors.New("INSTALL_PRODUCTION_STILL_RUNNING")
		}
	}
	return nil
}
func verifyInstalledRelease(ctx context.Context, parent *os.File, path string, m installReleaseManifest) error {
	app, err := openInstallDirectory(path)
	if err != nil {
		return errors.New("INSTALL_RESULT_UNKNOWN")
	}
	defer app.Close()
	v, err := apptree.New(parent, app, "Farol.app", apptree.Expected{TreeSHA256: m.ArtifactSha256, Version: m.Version, BuildID: m.BuildID}, appidentity.Verify)
	if err != nil {
		return errors.New("INSTALL_RESULT_UNKNOWN")
	}
	if _, err = v.Verify(ctx); err != nil {
		return errors.New("INSTALL_RESULT_UNKNOWN")
	}
	if installSignatures(ctx, path) != nil {
		return errors.New("INSTALL_RESULT_UNKNOWN")
	}
	return nil
}
func checkedInstallRecord(dir string) error {
	path := filepath.Join(dir, "current.json")
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("INSTALL_PREVIOUS_OUTCOME_UNKNOWN")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	s, err := f.Stat()
	if err != nil || !s.Mode().IsRegular() || s.Mode().Perm() != 0600 || s.Size() > 4096 {
		return errors.New("INSTALL_PREVIOUS_OUTCOME_UNKNOWN")
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Geteuid()) {
		return errors.New("INSTALL_PREVIOUS_OUTCOME_UNKNOWN")
	}
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(b) > 4096 {
		return errors.New("INSTALL_PREVIOUS_OUTCOME_UNKNOWN")
	}
	var r installReleaseRecord
	if json.Unmarshal(b, &r) != nil || r.Schema != "farol.bootstrap-install/1" || r.Phase != "completed" && r.Phase != "refused" {
		return errors.New("INSTALL_PREVIOUS_OUTCOME_UNKNOWN")
	}
	return nil
}
func writeInstallRecord(dir string, r installReleaseRecord) error {
	b, err := json.Marshal(r)
	if err != nil {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	tmp := filepath.Join(dir, "."+r.ID+".tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	if err = f.Close(); err != nil {
		return errors.New("INSTALL_CUSTODY_UNAVAILABLE")
	}
	if err = os.Rename(tmp, filepath.Join(dir, "current.json")); err != nil {
		return errors.New("INSTALL_CUSTODY_OUTCOME_UNKNOWN")
	}
	d, err := os.Open(dir)
	if err != nil {
		return errors.New("INSTALL_CUSTODY_OUTCOME_UNKNOWN")
	}
	defer d.Close()
	if d.Sync() != nil {
		return errors.New("INSTALL_CUSTODY_OUTCOME_UNKNOWN")
	}
	return nil
}
func settledInstallInventory(root string) error {
	for _, name := range []string{"ready.json", "restore-pending.json", "download-pending.json", "package-cleanup-pending.json"} {
		_, err := os.Lstat(filepath.Join(root, name))
		if !errors.Is(err, os.ErrNotExist) {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
	}
	b, err := os.ReadFile(filepath.Join(root, "last-update.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
	}
	if err == nil {
		if len(b) > 65536 {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		var receipt struct {
			Schema    string `json:"schema"`
			Phase     string `json:"phase"`
			Operation struct {
				OperationID string `json:"operationId"`
			} `json:"operation"`
			Helper struct {
				PID int `json:"pid"`
			} `json:"helper"`
		}
		if json.Unmarshal(b, &receipt) != nil || receipt.Schema != "farol.ready-update/1" || receipt.Phase != "completed" && receipt.Phase != "rolled_back" || len(receipt.Operation.OperationID) != 32 || receipt.Helper.PID < 2 {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		for _, c := range receipt.Operation.OperationID {
			if !strings.ContainsRune("0123456789abcdef", c) {
				return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
			}
		}
		binding, e := os.ReadFile(filepath.Join(root, receipt.Operation.OperationID, "slot-binding.json"))
		if e != nil || len(binding) > 65536 {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		var slot struct {
			Schema          string `json:"schema"`
			OperationID     string `json:"operationId"`
			InstallLocation string `json:"installLocation"`
		}
		if json.Unmarshal(binding, &slot) != nil || slot.Schema != "farol.installed-operation-slot/1" || slot.OperationID != receipt.Operation.OperationID || slot.InstallLocation != "shared" {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		journal, e := os.ReadFile(filepath.Join(root, receipt.Operation.OperationID, "journal.json"))
		if e != nil || len(journal) > 65536 {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		var j struct {
			Phase       string `json:"phase"`
			OperationID string `json:"operationId"`
		}
		if json.Unmarshal(journal, &j) != nil || j.Phase != receipt.Phase || j.OperationID != receipt.Operation.OperationID {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		if e = syscall.Kill(receipt.Helper.PID, 0); e == nil || !errors.Is(e, syscall.ESRCH) {
			return errors.New("INSTALL_HELPER_LIVE_OR_UNKNOWN")
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
	}
	for _, entry := range entries {
		if !entry.IsDir() || len(entry.Name()) != 32 {
			continue
		}
		b, e := os.ReadFile(filepath.Join(root, entry.Name(), "journal.json"))
		if e != nil || len(b) > 65536 {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
		var j struct {
			Phase string `json:"phase"`
		}
		if json.Unmarshal(b, &j) != nil || j.Phase != "completed" && j.Phase != "rolled_back" && j.Phase != "cancel_completed" && j.Phase != "rollback_completed" {
			return errors.New("INSTALL_UPDATE_PENDING_OR_UNKNOWN")
		}
	}
	return nil
}

func acceptedInstallBuild(root, profileRoot, installed string) (apptree.Expected, error) {
	var result apptree.Expected
	last, err := os.ReadFile(filepath.Join(root, "last-update.json"))
	if err == nil {
		if len(last) > 65536 {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
		var receipt struct {
			Phase          string `json:"phase"`
			RunningBuildID string `json:"runningBuildId"`
			Operation      struct {
				Source struct {
					Digest  string `json:"digest"`
					Version string `json:"version"`
					BuildID string `json:"buildId"`
				} `json:"source"`
				Target struct {
					Digest  string `json:"digest"`
					Version string `json:"version"`
					BuildID string `json:"buildId"`
				} `json:"target"`
			} `json:"operation"`
		}
		if json.Unmarshal(last, &receipt) != nil {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
		if receipt.Phase == "completed" {
			result = apptree.Expected{TreeSHA256: receipt.Operation.Target.Digest, Version: receipt.Operation.Target.Version, BuildID: receipt.Operation.Target.BuildID}
		} else if receipt.Phase == "rolled_back" {
			result = apptree.Expected{TreeSHA256: receipt.Operation.Source.Digest, Version: receipt.Operation.Source.Version, BuildID: receipt.Operation.Source.BuildID}
		} else {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
		if receipt.RunningBuildID != result.BuildID {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
	} else if errors.Is(err, os.ErrNotExist) {
		adopted, e := os.ReadFile(filepath.Join(root, "adopted-baseline.json"))
		if e != nil || len(adopted) > 65536 {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
		var record struct {
			Schema    string `json:"schema"`
			Slot      string `json:"slot"`
			UserData  string `json:"userData"`
			AdoptedAt string `json:"adoptedAt"`
			Manifest  struct {
				ArtifactSha256 string `json:"artifactSha256"`
				Version        string `json:"version"`
				BuildID        string `json:"buildId"`
			} `json:"manifest"`
		}
		if json.Unmarshal(adopted, &record) != nil || record.Schema != "farol.adopted-baseline/1" || record.Slot != installed || record.UserData != profileRoot || record.AdoptedAt == "" {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
		result = apptree.Expected{TreeSHA256: record.Manifest.ArtifactSha256, Version: record.Manifest.Version, BuildID: record.Manifest.BuildID}
	} else {
		return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
	}
	if len(result.TreeSHA256) != 64 || len(result.BuildID) != 64 || result.Version == "" {
		return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
	}
	for _, h := range []string{result.TreeSHA256, result.BuildID} {
		if _, e := hex.DecodeString(h); e != nil || h != strings.ToLower(h) {
			return result, errors.New("INSTALL_PREDECESSOR_IDENTITY_UNKNOWN")
		}
	}
	return result, nil
}
