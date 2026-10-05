//go:build darwin || linux

package results

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// Every native test owns only disposable t.TempDir roots. No application,
// browser, provider, subprocess, installed identity or shared runtime is used.
func nativeResultRoot(t *testing.T) Root {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	chat := filepath.Join(path, "chat")
	if err := os.Mkdir(chat, 0700); err != nil {
		t.Fatal(err)
	}
	var s unix.Stat_t
	if err := unix.Lstat(chat, &s); err != nil {
		t.Fatal(err)
	}
	return Root{Path: chat, ProfileID: "profile", Identity: port.JournalRoot{Device: uint64(s.Dev), Inode: uint64(s.Ino), OwnerUID: s.Uid}}
}
func nativeResultOwner(t *testing.T, root Root, scope port.JournalScope, limits Limits, mode string) *Native {
	t.Helper()
	n, err := NewNative(context.Background(), context.Background(), root, scope, limits, mode)
	if err != nil {
		t.Fatal("native constructor", err)
	}
	t.Cleanup(func() {
		if err := n.Close(); err != nil {
			t.Error("native close", err)
		}
	})
	return n
}
func nativeResultRetain(t *testing.T, n *Native, q port.RetainRequest) *port.RetainReceipt {
	t.Helper()
	r, err := n.Retain(context.Background(), q)
	if err != nil {
		t.Fatal("native retain", err)
	}
	return r
}
func TestNativeResultCreateOpenExclusiveClaimAndHistoricalRead(t *testing.T) {
	root := nativeResultRoot(t)
	child := filepath.Join(root.Path, resultChild)
	if n, err := NewNative(context.Background(), context.Background(), root, scopeFixture(), TextLimits(), "open"); n != nil || !errors.Is(err, Refused) {
		t.Fatal("open created missing storage", err)
	}
	if _, err := os.Lstat(child); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("open changed missing child", err)
	}
	n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "create")
	q := conversationResultFixture()
	r := nativeResultRetain(t, n, q)
	if !r.Publication.Valid() || r.Publication.Root != root.Identity {
		t.Fatal("native publication invalid")
	}
	var s unix.Stat_t
	if err := unix.Lstat(child, &s); err != nil {
		t.Fatal(err)
	}
	if !resultQualified(s, r.Publication.StorageRoot) {
		t.Fatal("physical storage root differs")
	}
	for _, mode := range []string{"create", "open"} {
		if other, err := NewNative(context.Background(), context.Background(), root, scopeFixture(), TextLimits(), mode); other != nil || !errors.Is(err, Refused) {
			t.Fatal("existing/live child admitted", mode, err)
		}
	}
	duplicate, err := n.Retain(context.Background(), q)
	if err != nil || *duplicate != *r {
		t.Fatal("live exact duplicate", err)
	}
	entries, err := os.ReadDir(child)
	if err != nil || len(entries) != 3 {
		t.Fatal("unexpected native inventory", err)
	}
	for _, entry := range entries {
		if entry.Name() != resultClaim && (!strings.HasPrefix(entry.Name(), resultKey(q)+".") || strings.Contains(entry.Name(), q.Binding.OperationID)) {
			t.Fatal("raw ID/content entered filename")
		}
		var meta unix.Stat_t
		if err := unix.Lstat(filepath.Join(child, entry.Name()), &meta); err != nil || !resultPhysical(meta, unix.S_IFREG, 0600, root.Identity.OwnerUID) {
			t.Fatal("record/claim physical mode", err)
		}
	}
	request, err := n.Read(context.Background(), resultReadFixture(r))
	if err != nil || request.Conversation != q.Conversation || !bytes.Equal(request.Payload, q.Payload) {
		t.Fatal("native readback", err)
	}
	request.Payload[0] = 'X'
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	nextScope := scopeFixture()
	nextScope.BackendGeneration = "successor"
	next := nativeResultOwner(t, root, nextScope, TextLimits(), "open")
	original, err := next.Read(context.Background(), resultReadFixture(r))
	if err != nil || original.Binding != q.Binding || !bytes.Equal(original.Payload, q.Payload) {
		t.Fatal("historical exact read lost", err)
	}
	if _, err := next.Retain(context.Background(), q); !errors.Is(err, Mismatch) {
		t.Fatal("old scope retained", err)
	}
	newQ := q
	newQ.Binding.BackendGeneration = nextScope.BackendGeneration
	newQ.Binding.OperationID = "new-operation"
	nativeResultRetain(t, next, newQ)
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
	// Reloading even the same scope cannot mint a known successful retry.
	reload := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "open")
	if _, err := reload.Retain(context.Background(), q); !errors.Is(err, Unknown) {
		t.Fatal("reload promoted valid bytes into success", err)
	}
	if err := reload.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := NewNative(context.Background(), context.Background(), root, nextScope, TextLimits(), "open"); reopened != nil || !errors.Is(err, Unknown) {
		t.Fatal("unknown marker failed across reopen", err)
	}
}
func TestNativeResultBoundsAcrossLifetimesNoEviction(t *testing.T) {
	root := nativeResultRoot(t)
	limits := Limits{Results: 2, ResultBytes: 4, TotalBytes: 5}
	n := nativeResultOwner(t, root, scopeFixture(), limits, "create")
	q := requestFixture()
	q.Payload = []byte{0, 255, 1, 2}
	r := nativeResultRetain(t, n, q)
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	scope := scopeFixture()
	scope.BackendGeneration = "next"
	next := nativeResultOwner(t, root, scope, limits, "open")
	newQ := q
	newQ.Binding.BackendGeneration = "next"
	newQ.Payload = []byte{1, 2}
	if _, err := next.Retain(context.Background(), newQ); !errors.Is(err, Capacity) {
		t.Fatal("old bytes escaped capacity", err)
	}
	newQ.Payload = nil
	nativeResultRetain(t, next, newQ)
	newQ.Binding.OperationID = "third"
	if _, err := next.Retain(context.Background(), newQ); !errors.Is(err, Capacity) {
		t.Fatal("empty record escaped count", err)
	}
	if _, err := next.Read(context.Background(), resultReadFixture(r)); err != nil {
		t.Fatal("capacity evicted result", err)
	}
}
func TestNativeResultInvalidModesAndPhysicalRootRefuseWithoutRepair(t *testing.T) {
	root := nativeResultRoot(t)
	for _, mode := range []string{"", "OPEN", "repair"} {
		if n, err := NewNative(context.Background(), context.Background(), root, scopeFixture(), TextLimits(), mode); n != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid mode accepted", err)
		}
	}
	wrong := root
	wrong.Identity.Inode++
	if n, err := NewNative(context.Background(), context.Background(), wrong, scopeFixture(), TextLimits(), "create"); n != nil || !errors.Is(err, Refused) {
		t.Fatal("wrong root admitted", err)
	}
	alias := filepath.Join(filepath.Dir(root.Path), "alias")
	if err := os.Symlink(root.Path, alias); err != nil {
		t.Fatal(err)
	}
	wrong = root
	wrong.Path = alias
	if n, err := NewNative(context.Background(), context.Background(), wrong, scopeFixture(), TextLimits(), "create"); n != nil || !errors.Is(err, Refused) {
		t.Fatal("symlink root admitted", err)
	}
	if err := os.Chmod(root.Path, 0755); err != nil {
		t.Fatal(err)
	}
	if n, err := NewNative(context.Background(), context.Background(), root, scopeFixture(), TextLimits(), "create"); n != nil || !errors.Is(err, Refused) {
		t.Fatal("public root admitted", err)
	}
	meta, err := os.Lstat(root.Path)
	if err != nil || meta.Mode().Perm() != 0755 {
		t.Fatal("mode repaired", err)
	}
	if _, err := os.Lstat(filepath.Join(root.Path, resultChild)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid root changed storage", err)
	}
}
func TestNativeResultOpenNeverRepairsClaimOrStorage(t *testing.T) {
	for _, kind := range []string{"missing-child", "missing-claim", "empty-claim", "claim-mode", "claim-link", "child-mode", "child-symlink", "profile"} {
		t.Run(kind, func(t *testing.T) {
			root := nativeResultRoot(t)
			n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "create")
			if err := n.Close(); err != nil {
				t.Fatal(err)
			}
			child := filepath.Join(root.Path, resultChild)
			claim := filepath.Join(child, resultClaim)
			scope := scopeFixture()
			switch kind {
			case "missing-child":
				if err := os.Rename(child, child+"-preserved"); err != nil {
					t.Fatal(err)
				}
			case "missing-claim":
				if err := os.Rename(claim, claim+"-preserved"); err != nil {
					t.Fatal(err)
				}
			case "empty-claim":
				if err := os.WriteFile(claim, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "claim-mode":
				if err := os.Chmod(claim, 0644); err != nil {
					t.Fatal(err)
				}
			case "claim-link":
				if err := os.Link(claim, filepath.Join(filepath.Dir(root.Path), "claim-link")); err != nil {
					t.Fatal(err)
				}
			case "child-mode":
				if err := os.Chmod(child, 0755); err != nil {
					t.Fatal(err)
				}
			case "child-symlink":
				if err := os.Rename(child, child+"-preserved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(child+"-preserved", child); err != nil {
					t.Fatal(err)
				}
			case "profile":
				root.ProfileID = "other"
				scope.ProfileID = "other"
			}
			if opened, err := NewNative(context.Background(), context.Background(), root, scope, TextLimits(), "open"); opened != nil || err == nil {
				t.Fatal("broken/rebound store admitted", err)
			}
			switch kind {
			case "missing-child":
				if _, err := os.Lstat(child); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("child recreated", err)
				}
			case "missing-claim":
				if _, err := os.Lstat(claim); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("claim recreated", err)
				}
			case "empty-claim":
				raw, err := os.ReadFile(claim)
				if err != nil || len(raw) != 0 {
					t.Fatal("claim repaired", err)
				}
			case "claim-mode":
				meta, err := os.Lstat(claim)
				if err != nil || meta.Mode().Perm() != 0644 {
					t.Fatal("claim mode repaired", err)
				}
			case "child-mode":
				meta, err := os.Lstat(child)
				if err != nil || meta.Mode().Perm() != 0755 {
					t.Fatal("child mode repaired", err)
				}
			}
		})
	}
}
func TestNativeResultCorruptIncompleteUnexpectedInventoryFences(t *testing.T) {
	for _, kind := range []string{"orphan-attempt", "orphan-commit", "malformed", "commit-digest", "unexpected", "unknown", "attempt-mode", "commit-mode", "attempt-hardlink", "attempt-symlink", "attempt-fifo"} {
		t.Run(kind, func(t *testing.T) {
			root := nativeResultRoot(t)
			n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "create")
			q := requestFixture()
			nativeResultRetain(t, n, q)
			if err := n.Close(); err != nil {
				t.Fatal(err)
			}
			child := filepath.Join(root.Path, resultChild)
			attempt := filepath.Join(child, resultKey(q)+".attempt")
			commit := filepath.Join(child, resultKey(q)+".commit")
			preserve := filepath.Join(filepath.Dir(root.Path), "preserved-file")
			switch kind {
			case "orphan-attempt":
				if err := os.Rename(commit, preserve); err != nil {
					t.Fatal(err)
				}
			case "orphan-commit":
				if err := os.Rename(attempt, preserve); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				if err := os.WriteFile(attempt, []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
			case "commit-digest":
				if err := os.WriteFile(commit, []byte(strings.Repeat("0", 64)), 0600); err != nil {
					t.Fatal(err)
				}
			case "unexpected":
				if err := os.WriteFile(filepath.Join(child, "unexpected"), []byte("x"), 0600); err != nil {
					t.Fatal(err)
				}
			case "unknown":
				if err := os.WriteFile(filepath.Join(child, resultUnknown), []byte("UNKNOWN"), 0600); err != nil {
					t.Fatal(err)
				}
			case "attempt-mode":
				if err := os.Chmod(attempt, 0644); err != nil {
					t.Fatal(err)
				}
			case "commit-mode":
				if err := os.Chmod(commit, 0644); err != nil {
					t.Fatal(err)
				}
			case "attempt-hardlink":
				if err := os.Link(attempt, preserve); err != nil {
					t.Fatal(err)
				}
			case "attempt-symlink":
				if err := os.Rename(attempt, preserve); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(preserve, attempt); err != nil {
					t.Fatal(err)
				}
			case "attempt-fifo":
				if err := os.Rename(attempt, preserve); err != nil {
					t.Fatal(err)
				}
				if err := unix.Mkfifo(attempt, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if opened, err := NewNative(context.Background(), context.Background(), root, scopeFixture(), TextLimits(), "open"); opened != nil || !errors.Is(err, Unknown) {
				t.Fatal("corruption accepted/repaired", err)
			}
			if _, err := os.Lstat(claimPath(root)); err != nil {
				t.Fatal("claim removed", err)
			}
		})
	}
}
func claimPath(root Root) string { return filepath.Join(root.Path, resultChild, resultClaim) }
func TestNativeResultPhysicalReplacementFencesLiveOwner(t *testing.T) {
	for _, kind := range []string{"root", "child", "claim"} {
		t.Run(kind, func(t *testing.T) {
			root := nativeResultRoot(t)
			n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "create")
			r := nativeResultRetain(t, n, requestFixture())
			path := root.Path
			switch kind {
			case "child":
				path = filepath.Join(root.Path, resultChild)
			case "claim":
				path = claimPath(root)
			}
			if err := os.Rename(path, path+"-preserved"); err != nil {
				t.Fatal(err)
			}
			if kind == "claim" {
				if err := os.WriteFile(path, []byte("replacement"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := n.Read(context.Background(), resultReadFixture(r)); !errors.Is(err, Unknown) {
				t.Fatal("physical replacement returned bytes", err)
			}
			if _, err := n.Retain(context.Background(), requestFixture()); !errors.Is(err, Unknown) {
				t.Fatal("replacement unfenced owner", err)
			}
			// The adapter must not redirect its UNKNOWN marker into a replacement root.
			replacement := filepath.Join(root.Path, resultChild, resultUnknown)
			if kind == "child" {
				replacement = filepath.Join(path, resultUnknown)
			}
			if _, err := os.Lstat(replacement); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("marker written into unqualified replacement", err)
			}
		})
	}
}
func TestNativeResultLateFenceAfterKnownCommitPersistsAndClosePreserves(t *testing.T) {
	root := nativeResultRoot(t)
	n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "create")
	q := requestFixture()
	r := nativeResultRetain(t, n, q)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := n.Fence(cancelled); err != nil {
		t.Fatal("late fence", err)
	}
	marker := filepath.Join(root.Path, resultChild, resultUnknown)
	raw, err := os.ReadFile(marker)
	if err != nil || string(raw) != "UNKNOWN" {
		t.Fatal("marker not durable readback", err)
	}
	var before unix.Stat_t
	if err := unix.Lstat(marker, &before); err != nil {
		t.Fatal(err)
	}
	if err := n.Fence(context.Background()); err != nil {
		t.Fatal(err)
	}
	var after unix.Stat_t
	if err := unix.Lstat(marker, &after); err != nil || !resultStable(before, after) {
		t.Fatal("fence rewrote marker", err)
	}
	if _, err := n.Read(context.Background(), resultReadFixture(r)); !errors.Is(err, Unknown) {
		t.Fatal("late outcome returned bytes", err)
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{resultClaim, resultUnknown, resultKey(q) + ".attempt", resultKey(q) + ".commit"} {
		if _, err := os.Lstat(filepath.Join(root.Path, resultChild, name)); err != nil {
			t.Fatal("close removed evidence", err)
		}
	}
	if opened, err := NewNative(context.Background(), context.Background(), root, scopeFixture(), TextLimits(), "open"); opened != nil || !errors.Is(err, Unknown) {
		t.Fatal("late marker reopened", err)
	}
}
