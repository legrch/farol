//go:build darwin

package mutation_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestHistoryNativePreservesPreparedBytes(t *testing.T) {
	root, _, _ := nativeProcessFixture(t)
	r := openProcessRepository(t, root)
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000099", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "workspace", ComputerGeneration: 7, Version: 2}
	state, err := domain.RestoreSelfTest(b, domain.Prepared, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.AdmitSelfTest(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(filepath.Join(root.Path, "mutations"))
	if err != nil || len(files) != 1 {
		t.Fatal("missing record", err)
	}
	path := filepath.Join(root.Path, "mutations", files[0].Name())
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := r.ListSelfTests(context.Background(), "owner", "profile", "computer")
	if err != nil || len(entries) != 1 || entries[0].Binding != b || entries[0].Phase != domain.Prepared {
		t.Fatal("history", entries, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("record changed", err)
	}
}
