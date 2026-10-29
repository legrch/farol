//go:build darwin

package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Disposable native filesystem only; no connector, user profile or live data.
func TestNativeScratchReadRetainsRealCustody(t *testing.T) {
	for _, scenario := range []string{"stable", "closed-file", "closed-directory", "replace-file", "replace-directory"} {
		t.Run(scenario, func(t *testing.T) {
			d := fixture(t)
			const run = "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(run)
			dir := filepath.Join(d.Root, leaf)
			file := filepath.Join(dir, "check.txt")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte("known\n"), 0600); err != nil {
				t.Fatal(err)
			}
			dirID, fileID := scratchReadIdentity(t, dir), scratchReadIdentity(t, file)
			dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			f, err := unix.Open(file, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				_ = unix.Close(dfd)
				t.Fatal(err)
			}
			dirHold := &scratchDirectoryCustody{fd: dfd, identity: dirID, uid: uint32(os.Getuid())}
			fileHold := &scratchFileCustody{fd: f, identity: fileID, uid: uint32(os.Getuid())}
			t.Cleanup(func() { _ = dirHold.Close(); _ = fileHold.Close() })
			binding := port.ScratchReadBinding{RunID: run, Directory: dirID, File: fileID, DirectoryHold: dirHold, FileHold: fileHold}
			w := New(d.Root + "-home")
			w.afterRead = func() {
				switch scenario {
				case "closed-file":
					if err := fileHold.Close(); err != nil {
						t.Fatal(err)
					}
				case "closed-directory":
					if err := dirHold.Close(); err != nil {
						t.Fatal(err)
					}
				case "replace-file":
					if err := os.Rename(file, file+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(file, []byte("known\n"), 0600); err != nil {
						t.Fatal(err)
					}
				case "replace-directory":
					if err := os.Rename(dir, dir+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(dir, 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(file, []byte("known\n"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			out, err := w.ReadScratch(context.Background(), port.ReadRequest{Workspace: d, RelativePath: leaf + "/check.txt"}, binding)
			if scenario == "stable" {
				if err != nil || out == nil || out.Text != "known\n" {
					t.Fatal("stable original read failed", out, err)
				}
			} else if err == nil || out != nil {
				t.Fatal("lost custody or replacement disclosed", out, err)
			}
		})
	}
}
