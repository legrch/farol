//go:build darwin

package boot

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOwnerGitChoicePreservedInProtectedComputerInventory(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"computer-access.json", "computer-access.lock", ".mutation-writer.lock"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "mutations"), 0700); err != nil {
		t.Fatal(err)
	}
	var stat unix.Stat_t
	if err := unix.Lstat(root, &stat); err != nil {
		t.Fatal(err)
	}
	computer := NativeRoot{Path: root, Device: uint64(stat.Dev), Inode: stat.Ino, OwnerUID: stat.Uid, Mode: 0700}
	check := func(wantChoice bool, wantError bool) {
		t.Helper()
		names, err := computerRecoveryNames(computer)
		if err != nil {
			t.Fatal(err)
		}
		_, hasChoice := names["owner-git-choice.json"]
		if hasChoice != wantChoice {
			t.Fatalf("choice presence = %v, want %v", hasChoice, wantChoice)
		}
		err = inspectExactRecoveryDirectory(context.Background(), computer, names)
		if (err != nil) != wantError {
			t.Fatalf("inventory error = %v, want error %v", err, wantError)
		}
	}
	check(false, false)
	choice := filepath.Join(root, "owner-git-choice.json")
	if err := os.WriteFile(choice, []byte(`{"schema":1,"enabled":true,"override":"/opt/homebrew/bin/git"}`), 0600); err != nil {
		t.Fatal(err)
	}
	check(true, false)
	if err := os.Remove(choice); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("computer-access.json", choice); err != nil {
		t.Fatal(err)
	}
	check(true, true)
}
