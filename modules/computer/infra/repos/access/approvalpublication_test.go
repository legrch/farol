package access

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Real disposable Store/disk; current-consent withdrawal and lost guard replies
// are controlled. This does not prove an Electron or external connector journey.
func TestApprovalPublicationRefusalLeavesOriginalStateKnown(t *testing.T) {
	for _, mode := range []string{"withdrawn", "missing-publish", "nil-guard"} {
		t.Run(mode, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			before := status(t, f.store)
			path := filepath.Join(f.root, stateName)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			renewed := f.approval.Clone()
			renewed.ExpiresAt = renewed.ExpiresAt.Add(time.Hour)
			guard := func(func() error) error {
				if mode == "withdrawn" {
					return errors.New("current consent withdrawn")
				}
				return nil
			}
			if mode == "nil-guard" {
				guard = nil
			}
			err = f.store.UpdateApprovalWithPublication(context.Background(), before.Revision, renewed, guard)
			if err == nil || OutcomeUnknown(err) || f.store.poisoned || status(t, f.store) != before {
				t.Fatal("known refusal changed state or fenced observation", err)
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(raw, after) {
				t.Fatal("withdrawn approval was published", err)
			}
			entries, err := os.ReadDir(f.root)
			if err != nil || len(entries) != 2 {
				t.Fatal("approval staging residue", entries, err)
			}
		})
	}
}

func TestApprovalPublicationDoesNotHoldGuardDuringDurability(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	revision := status(t, f.store).Revision
	renewed := f.approval.Clone()
	renewed.ExpiresAt = renewed.ExpiresAt.Add(time.Hour)
	inGuard, calls, syncs := false, 0, 0
	f.store.disk.syncDirectory = func(fd int) error {
		if inGuard {
			t.Fatal("durability held current authority guard")
		}
		syncs++
		return unix.Fsync(fd)
	}
	err := f.store.UpdateApprovalWithPublication(context.Background(), revision, renewed, func(publish func() error) error {
		inGuard = true
		defer func() { inGuard = false }()
		calls++
		return publish()
	})
	if err != nil || calls != 1 || syncs != 1 || status(t, f.store).Revision != revision+1 ||
		!f.store.current.Approval.ExpiresAt.Equal(renewed.ExpiresAt) {
		t.Fatal("guarded approval publication not acknowledged", calls, syncs, err)
	}
}

func TestApprovalPublicationLostOrRepeatedReplyRemainsUnknown(t *testing.T) {
	for _, mode := range []string{"lost-reply", "double-publish", "durability"} {
		t.Run(mode, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			renewed := f.approval.Clone()
			renewed.ExpiresAt = renewed.ExpiresAt.Add(time.Hour)
			if mode == "durability" {
				f.store.disk.syncDirectory = func(int) error { return unix.EIO }
			}
			err := f.store.UpdateApprovalWithPublication(context.Background(), status(t, f.store).Revision, renewed, func(publish func() error) error {
				if err := publish(); err != nil {
					return err
				}
				switch mode {
				case "lost-reply":
					return errors.New("guard response lost after publication")
				case "double-publish":
					_ = publish()
				}
				return nil
			})
			if !OutcomeUnknown(err) || !f.store.poisoned {
				t.Fatal("publication uncertainty became known", err)
			}
			if _, err = f.store.Status(context.Background()); err == nil {
				t.Fatal("uncertain Store enabled observation")
			}
		})
	}
}
