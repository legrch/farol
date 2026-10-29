package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

type scratchReadHold struct{ identity mutation.DirectoryIdentity }

func (h scratchReadHold) Check(id mutation.DirectoryIdentity) error {
	if id != h.identity {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	return nil
}
func (scratchReadHold) Close() error { return nil }

func scratchReadIdentity(t *testing.T, path string) mutation.DirectoryIdentity {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	return mutation.DirectoryIdentity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}
}

func TestScratchReadBindsOpenedFileAndDirectory(t *testing.T) {
	for _, scenario := range []string{"stable", "file-replaced", "directory-replaced", "file-replaced-before", "file-symlink", "hold-mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			d := fixture(t)
			const run = "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(run)
			dir := filepath.Join(d.Root, leaf)
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(dir, "check.txt")
			if err := os.WriteFile(file, []byte("known\n"), 0600); err != nil {
				t.Fatal(err)
			}
			dirID, fileID := scratchReadIdentity(t, dir), scratchReadIdentity(t, file)
			binding := port.ScratchReadBinding{RunID: run, Directory: dirID, File: fileID, DirectoryHold: scratchReadHold{dirID}, FileHold: scratchReadHold{fileID}}
			w := New(d.Root + "-home")
			switch scenario {
			case "hold-mismatch":
				binding.FileHold = scratchReadHold{dirID}
			case "file-replaced-before", "file-symlink":
				if err := os.Rename(file, file+".old"); err != nil {
					t.Fatal(err)
				}
				if scenario == "file-symlink" {
					if err := os.Symlink("check.txt.old", file); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(file, []byte("known\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "file-replaced":
				w.afterRead = func() {
					if err := os.Rename(file, file+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(file, []byte("known\n"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			case "directory-replaced":
				w.afterRead = func() {
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
					t.Fatal("original file not read", out, err)
				}
			} else if out != nil || err == nil {
				t.Fatal("replacement or lost custody disclosed", out, err)
			}
		})
	}
}

func TestScratchListAndSearchRejectReplacement(t *testing.T) {
	for _, action := range []string{"list", "search"} {
		for _, replace := range []bool{false, true} {
			t.Run(action+"/"+strconv.FormatBool(replace), func(t *testing.T) {
				d := fixture(t)
				const run = "00000000-0000-4000-8000-000000000001"
				leaf := mutation.ScratchPath(run)
				dir, path := filepath.Join(d.Root, leaf), filepath.Join(d.Root, leaf, "check.txt")
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("known\n"), 0600); err != nil {
					t.Fatal(err)
				}
				dirID, fileID := scratchReadIdentity(t, dir), scratchReadIdentity(t, path)
				binding := port.ScratchReadBinding{RunID: run, Directory: dirID, File: fileID, DirectoryHold: scratchReadHold{dirID}, FileHold: scratchReadHold{fileID}}
				w := New(d.Root + "-home")
				if replace {
					w.afterRead = func() {
						if err := os.Rename(path, path+".old"); err != nil {
							t.Fatal(err)
						}
						if err := os.WriteFile(path, []byte("known\n"), 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
				if action == "list" {
					out, err := w.ListScratch(context.Background(), port.ListRequest{Workspace: d, RelativePath: leaf}, binding)
					if replace && (err == nil || out != nil) || !replace && (err != nil || out == nil || len(out.Entries) != 1 || out.Entries[0] != "check.txt") {
						t.Fatal("list mismatch", out, err)
					}
				} else {
					out, err := w.SearchScratch(context.Background(), port.SearchRequest{Workspace: d, RelativePath: leaf + "/check.txt", Pattern: "known"}, binding)
					if replace && (err == nil || out != nil) || !replace && (err != nil || out == nil || len(out.Matches) != 1 || out.Matches[0].Path != leaf+"/check.txt") {
						t.Fatal("search mismatch", out, err)
					}
				}
			})
		}
	}
}
