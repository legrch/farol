//go:build darwin || linux

package lifecycle

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

var nativeLifecycleInspection = flag.Bool("chat-native-inspection", false, "run disposable native read-only Chat lifecycle inspection checks on the Lead native lane")

// Lead-lane invocation only:
// go test -count=1 -v -run '^TestNativeLifecycleInspection' ./modules/chat/infra/repos/lifecycle -args -chat-native-inspection
// These exercise real native descriptors/flock on retained disposable roots.
// They use no provider, app, subprocess or actual profile. They do not establish
// power-loss safety, cross-process locking, origin proof or owner acceptance.
func requireNativeLifecycleInspection(t *testing.T) {
	t.Helper()
	if !*nativeLifecycleInspection {
		t.Skip("requires explicit -chat-native-inspection and an available Lead native lane")
	}
}

func nativeInspectionRoot(t *testing.T) Root {
	t.Helper()
	parent, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path, err := os.MkdirTemp(parent, "farol-lifecycle-inspection-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true", path)
	var s unix.Stat_t
	if unix.Lstat(path, &s) != nil || !physical(s, unix.S_IFDIR, 0700, uint32(os.Geteuid())) {
		t.Fatal("fixture root qualification failed")
	}
	return Root{Path: path, ProfileID: scope.ProfileID, Device: uint64(s.Dev), Inode: uint64(s.Ino), OwnerUID: s.Uid}
}

func nativeInspectionFixture(t *testing.T, value record) (Root, []byte) {
	t.Helper()
	root := nativeInspectionRoot(t)
	value.Root = root.identity()
	if value.Retirement != nil {
		w := port.CopyRetirement(*value.Retirement)
		w.Root = root.identity()
		value.Retirement = &w
	}
	raw := inspectionEncode(t, value)
	for name, content := range map[string][]byte{claimName: {}, snapshotName: raw} {
		if err := os.WriteFile(filepath.Join(root.Path, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root, raw
}

type nativeInspectionEntry struct {
	Stat   unix.Stat_t
	Digest [32]byte
}

// Fingerprint fixture entries without opening symlinks, FIFOs or directories.
// Access timestamps are omitted: kernel read-atime policy is not file mutation.
func nativeInspectionInventory(t *testing.T, path string) map[string]nativeInspectionEntry {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	result := make(map[string]nativeInspectionEntry, len(entries))
	for _, e := range entries {
		name := filepath.Join(path, e.Name())
		var s unix.Stat_t
		if unix.Lstat(name, &s) != nil {
			t.Fatal("fixture inventory stat failed")
		}
		entry := nativeInspectionEntry{Stat: s}
		if uint32(s.Mode)&unix.S_IFMT == unix.S_IFREG {
			raw, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			entry.Digest = sha256.Sum256(raw)
		}
		result[e.Name()] = entry
	}
	return result
}

func assertNativeInspectionInventory(t *testing.T, before, after map[string]nativeInspectionEntry) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatal("inspection created/deleted entries")
	}
	for name, entry := range before {
		now, ok := after[name]
		if !ok || !stable(entry.Stat, now.Stat) || entry.Digest != now.Digest {
			t.Fatal("inspection changed fixture entry", name)
		}
	}
}

func TestNativeLifecycleInspectionReadOnlyMetadataAndNoAuthority(t *testing.T) {
	requireNativeLifecycleInspection(t)
	for _, name := range []string{"empty_first", "admitted", "empty_successor", "recorded_retirement", "unknown_send"} {
		if !t.Run(name, func(t *testing.T) {
			value := inspectionEmptyRecord()
			switch name {
			case "admitted":
				value.Writes = []port.JournalWrite{admissionWrite(t)}
			case "empty_successor":
				value.Incarnations = []string{"old-backend", scope.BackendGeneration}
			case "recorded_retirement":
				value.Retirement = &port.RetirementWrite{Scope: scope, Root: fixtureRoot, Revision: 1, Turns: []port.RetirementTurn{}}
			case "unknown_send":
				value = inspectionUnknownRecord(t)
			}
			root, raw := nativeInspectionFixture(t, value)
			// Hidden staging is outside this API. Even a successful empty-snapshot
			// diagnostic must leave this evidence intact and grant no unused claim.
			if err := os.WriteFile(filepath.Join(root.Path, ".fixture-hidden-staging"), []byte("fixture-staging-fence"), 0600); err != nil {
				t.Fatal(err)
			}
			before := nativeInspectionInventory(t, root.Path)
			got, err := Inspect(context.Background(), root, inspectionLimits)
			want, pureErr := inspectRecord(raw, root, inspectionLimits)
			if err != nil || pureErr != nil || !reflect.DeepEqual(got, want) {
				t.Fatal("native metadata differs from exact canonical snapshot", got, err, pureErr)
			}
			assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
			// Ordinary construction remains fenced; recorded retirement/emptiness
			// cannot stand in for the live owner's proof.
			if r, err := New(context.Background(), root, inspectionLimits); r != nil || !errors.Is(err, Refused) {
				t.Fatal("inspection relaxed generic construction", err)
			}
			next := port.JournalScope{ProfileID: root.ProfileID, BackendGeneration: "next"}
			if r, err := NewAfterRetirement(context.Background(), root, next, inspectionLimits, nil); r != nil || !errors.Is(err, Invalid) {
				t.Fatal("inspection replaced origin proof", err)
			}
			assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
			// Inspection released its lock, while retaining the exact permanent claim.
			d, err := openInspectionDisk(context.Background(), root)
			if err != nil {
				t.Fatal("inspection leaked its lock", err)
			}
			if err := d.close(); err != nil {
				t.Fatal(err)
			}
		}) {
			t.Fatal("native inspection failed; stop and retain fixture evidence")
		}
	}
}

func TestNativeLifecycleInspectionRejectsActiveOwnerNonblocking(t *testing.T) {
	requireNativeLifecycleInspection(t)
	root := nativeInspectionRoot(t)
	r, err := New(context.Background(), root, inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for _, opened := range []bool{false, true} {
		if opened {
			if _, err := r.OpenFresh(context.Background(), scope); err != nil {
				t.Fatal(err)
			}
		}
		before := nativeInspectionInventory(t, root.Path)
		got, err := Inspect(context.Background(), root, inspectionLimits)
		assertInspectionDiagnostic(t, got, err, Refused, InspectionClaimLock)
		// Only this fixture knows it holds a writer. The reason itself proves
		// neither a live owner nor permission to retry or replace the claim.
		if !errors.Is(err, unix.EWOULDBLOCK) {
			t.Fatal("original flock cause lost", err)
		}
		assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if got, err := Inspect(context.Background(), root, inspectionLimits); err != nil || got == nil || !got.EmptyFirstIncarnation || got.Retirement != nil {
		t.Fatal("closed snapshot classification invented retirement", got, err)
	}
}

func TestNativeLifecycleInspectionRejectsHostileEntriesAndBounds(t *testing.T) {
	requireNativeLifecycleInspection(t)
	cases := []string{
		"missing_claim", "missing_snapshot", "claim_symlink", "snapshot_symlink", "claim_hardlink", "snapshot_hardlink",
		"claim_fifo", "snapshot_fifo", "claim_directory", "snapshot_directory", "claim_mode", "snapshot_mode",
		"missing_root", "root_mode", "root_symlink", "ancestor_symlink", "root_identity", "owner_identity", "relative_root", "unclean_root",
		"wrong_profile", "stored_root", "crossed_scope", "empty_bytes", "noncanonical", "byte_overflow", "record_overflow",
	}
	for _, name := range cases {
		if !t.Run(name, func(t *testing.T) {
			value := inspectionEmptyRecord()
			if name == "record_overflow" {
				value = inspectionUnknownRecord(t)
			}
			root, raw := nativeInspectionFixture(t, value)
			physicalPath := root.Path
			limits := inspectionLimits
			entry := snapshotName
			if len(name) >= 6 && name[:6] == "claim_" || name == "missing_claim" {
				entry = claimName
			}
			path := filepath.Join(root.Path, entry)
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "missing_claim", "missing_snapshot":
				must(os.Rename(path, path+".retained"))
			case "claim_symlink", "snapshot_symlink":
				must(os.Rename(path, path+".retained"))
				must(os.Symlink(path+".retained", path))
			case "claim_hardlink", "snapshot_hardlink":
				must(os.Link(path, path+".linked"))
			case "claim_fifo", "snapshot_fifo":
				must(os.Rename(path, path+".retained"))
				must(unix.Mkfifo(path, 0600))
			case "claim_directory", "snapshot_directory":
				must(os.Rename(path, path+".retained"))
				must(os.Mkdir(path, 0700))
			case "claim_mode", "snapshot_mode":
				must(os.Chmod(path, 0640))
			case "root_mode":
				must(os.Chmod(root.Path, 0750))
			case "missing_root":
				root.Path = filepath.Join(physicalPath, "missing-root")
			case "root_symlink":
				root.Path = filepath.Join(root.Path, "root-alias")
				must(os.Symlink(physicalPath, root.Path))
			case "ancestor_symlink":
				must(os.Mkdir(filepath.Join(root.Path, "child"), 0700))
				alias := filepath.Join(root.Path, "parent-alias")
				must(os.Symlink(physicalPath, alias))
				var s unix.Stat_t
				must(unix.Lstat(filepath.Join(physicalPath, "child"), &s))
				root.Path, root.Device, root.Inode = filepath.Join(alias, "child"), uint64(s.Dev), uint64(s.Ino)
			case "root_identity":
				root.Inode++
			case "owner_identity":
				root.OwnerUID++
			case "relative_root":
				root.Path = "relative-fixture"
			case "unclean_root":
				root.Path += "/."
			case "wrong_profile":
				root.ProfileID = "another-profile"
			case "stored_root", "crossed_scope":
				stored, err := decode(raw, limits)
				must(err)
				if name == "stored_root" {
					stored.Root.Inode++
				} else {
					stored.Scope.ProfileID = "another-profile"
				}
				must(os.WriteFile(path, inspectionEncode(t, stored), 0600))
			case "empty_bytes":
				must(os.WriteFile(path, nil, 0600))
			case "noncanonical":
				must(os.WriteFile(path, append(raw, ' '), 0600))
			case "byte_overflow":
				limits.Bytes = len(raw) - 1
			case "record_overflow":
				limits.Records = 1
			}
			before := nativeInspectionInventory(t, physicalPath)
			got, err := Inspect(context.Background(), root, limits)
			code, reason := Unavailable, InspectionSnapshotRead
			switch name {
			case "missing_claim", "claim_symlink":
				code, reason = Refused, InspectionClaimOpen
			case "claim_hardlink", "claim_fifo", "claim_directory", "claim_mode":
				code, reason = Refused, InspectionClaimMetadata
			case "missing_root", "root_symlink", "ancestor_symlink":
				code, reason = Refused, InspectionRootRoute
			case "root_mode":
				code, reason = Refused, InspectionRootMetadata
			case "root_identity":
				code, reason = Refused, InspectionRootIdentity
			case "owner_identity", "relative_root", "unclean_root":
				code, reason = Invalid, InspectionRootInvalid
			case "wrong_profile", "crossed_scope":
				code, reason = Refused, InspectionSnapshotProfileMismatch
			case "stored_root":
				code, reason = Refused, InspectionSnapshotRootMismatch
			case "noncanonical", "record_overflow":
				code, reason = Invalid, InspectionSnapshotInvalid
			}
			diagnostic := assertInspectionDiagnostic(t, got, err, code, reason)
			if name == "missing_claim" || name == "missing_snapshot" || name == "missing_root" {
				if !errors.Is(diagnostic, os.ErrNotExist) {
					t.Fatal("available original missing-entry cause lost", err)
				}
			}
			assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, physicalPath))
		}) {
			t.Fatal("native refusal failed; stop and retain fixture evidence")
		}
	}
}

// Deterministic fixture mutation at the first post-read context checkpoint.
// This exercises real files/descriptors, without production injection hooks,
// mutation goroutines, subprocesses or timing-dependent race expectations.
type nativeInspectionMutationContext struct {
	context.Context
	mutate func()
}

func (c *nativeInspectionMutationContext) Err() error {
	if f := c.mutate; f != nil {
		c.mutate = nil
		f()
	}
	return c.Context.Err()
}

func TestNativeLifecycleInspectionRejectsChangingBytesAndCancellation(t *testing.T) {
	requireNativeLifecycleInspection(t)
	for _, name := range []string{"changed_bytes", "same_bytes_replacement", "same_inode_restoration", "claim_changed", "claim_replaced", "snapshot_mode", "snapshot_hardlink", "root_replaced", "cancelled"} {
		if !t.Run(name, func(t *testing.T) {
			root, raw := nativeInspectionFixture(t, inspectionEmptyRecord())
			d, err := openInspectionDisk(context.Background(), root)
			if err != nil {
				t.Fatal(err)
			}
			defer d.close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			checkpoint := &nativeInspectionMutationContext{Context: ctx, mutate: func() {
				path := filepath.Join(root.Path, snapshotName)
				switch name {
				case "changed_bytes":
					stored, err := decode(raw, inspectionLimits)
					must(err)
					stored.Incarnations = []string{"earlier", scope.BackendGeneration}
					must(os.WriteFile(path, inspectionEncode(t, stored), 0600))
				case "same_bytes_replacement":
					must(os.Rename(path, path+".retained"))
					must(os.WriteFile(path, raw, 0600))
				case "same_inode_restoration":
					must(os.WriteFile(path, bytes.Repeat([]byte{'x'}, len(raw)), 0600))
					must(os.WriteFile(path, raw, 0600))
					// Force a distinct timestamp without relying on host resolution.
					changed := []unix.Timespec{unix.NsecToTimespec(1), unix.NsecToTimespec(1)}
					must(unix.UtimesNano(path, changed))
				case "claim_changed":
					must(os.WriteFile(filepath.Join(root.Path, claimName), []byte("fixture-change"), 0600))
				case "claim_replaced":
					claim := filepath.Join(root.Path, claimName)
					must(os.Rename(claim, claim+".retained"))
					must(os.WriteFile(claim, nil, 0600))
				case "snapshot_mode":
					must(os.Chmod(path, 0640))
				case "snapshot_hardlink":
					must(os.Link(path, path+".linked"))
				case "root_replaced":
					must(os.Rename(root.Path, root.Path+".retained"))
					must(os.Mkdir(root.Path, 0700))
				case "cancelled":
					cancel()
				}
			}}
			got, err := inspectLockedSnapshot(checkpoint, d, inspectionLimits)
			wantCode, reason := Unavailable, InspectionSnapshotChanged
			switch name {
			case "cancelled":
				wantCode, reason = Cancelled, InspectionCancelled
			case "claim_replaced", "snapshot_mode", "snapshot_hardlink", "root_replaced":
				// disk.read has already classified these refusals. Do not infer
				// an unavailable syscall cause or a finer reason inside it.
				reason = InspectionSnapshotRead
			}
			assertInspectionDiagnostic(t, got, err, wantCode, reason)
			if name == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatal("original cancellation cause lost", err)
			}
		}) {
			t.Fatal("native stability check failed; stop and retain fixture evidence")
		}
	}
}

func TestNativeLifecycleInspectionDiagnosticClaimRoute(t *testing.T) {
	requireNativeLifecycleInspection(t)
	root, _ := nativeInspectionFixture(t, inspectionEmptyRecord())
	before := nativeInspectionInventory(t, root.Path)
	// Change only this disposable fixture at the existing post-root checkpoint.
	// openInspectionDisk must refuse its final route check and close its own
	// descriptors synchronously. This injects no Close failure.
	var mutationErr error
	checkpoint := &nativeInspectionMutationContext{Context: context.Background(), mutate: func() {
		mutationErr = os.Rename(root.Path, root.Path+".retained")
		if mutationErr == nil {
			mutationErr = os.Mkdir(root.Path, 0700)
		}
	}}
	d, err := openInspectionDisk(checkpoint, root)
	// Report fixture setup failures only after openInspectionDisk has returned
	// through its synchronous cleanup, or after closing an unexpected result.
	if d != nil {
		if closed := d.close(); closed != nil {
			t.Fatal("fixture disk cleanup failed", closed)
		}
	}
	if mutationErr != nil {
		t.Fatal("fixture route mutation failed", mutationErr)
	}
	if d != nil {
		t.Fatal("changed route returned a disk")
	}
	diagnostic := assertInspectionDiagnostic(t, nil, err, Refused, InspectionClaimRoute)
	if !errors.Is(diagnostic.cause, Unavailable) {
		t.Fatal("actual classified route-check cause lost", err)
	}
	assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path+".retained"))
}
