package access

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

func TestClosedAccessInspectionNativeRetainsOriginalStateAndWriterLock(t *testing.T) {
	f := fixtureState(t)
	path := filepath.Join(f.root, stateName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	visits := 0
	if err := WithClosedInspection(context.Background(), f.root, testBinding, digest, func(ClosedInspection) error { visits++; return nil }); err == nil || visits != 0 {
		t.Fatal("active writer admitted observation")
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	err = WithClosedInspection(context.Background(), f.root, testBinding, digest, func(observed ClosedInspection) error {
		visits++
		if observed.Binding != testBinding || observed.Digest != digest || observed.Status.Revision != 0 {
			t.Fatal(observed)
		}
		if writer, err := Open(f.root, testBinding, f.clock); err == nil {
			writer.Close()
			t.Fatal("inspection released writer lock")
		}
		return nil
	})
	if err != nil || visits != 1 {
		t.Fatal(err, visits)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(raw, after) {
		t.Fatal("inspection changed stored bytes", err)
	}
}

func TestClosedAccessInspectionNativeRefusesChangedOrMissingInputs(t *testing.T) {
	for _, kind := range []string{"digest", "binding", "removed-lock", "changed-state", "changed-lock", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(f.root, stateName)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(raw)
			binding := testBinding
			if kind == "digest" {
				digest[0]++
			}
			if kind == "binding" {
				binding.OwnerID = "other"
			}
			if kind == "removed-lock" {
				if err := os.Remove(filepath.Join(f.root, lockName)); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			visits := 0
			err = WithClosedInspection(ctx, f.root, binding, digest, func(ClosedInspection) error {
				visits++
				switch kind {
				case "changed-state":
					if err := os.WriteFile(path, append(raw, ' '), 0600); err != nil {
						t.Fatal(err)
					}
				case "changed-lock":
					if err := os.WriteFile(filepath.Join(f.root, lockName), []byte("changed"), 0600); err != nil {
						t.Fatal(err)
					}
				case "cancelled":
					cancel()
				}
				return nil
			})
			if err == nil {
				t.Fatal("unsafe closed observation accepted")
			}
			if (kind == "digest" || kind == "binding" || kind == "removed-lock") && visits != 0 {
				t.Fatal("invalid selection reached callback")
			}
			if kind == "removed-lock" {
				if _, err := os.Lstat(filepath.Join(f.root, lockName)); !os.IsNotExist(err) {
					t.Fatal("observation recreated lock", err)
				}
			}
		})
	}
}
