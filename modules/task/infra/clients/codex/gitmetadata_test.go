//go:build darwin || linux

package codex

// Synthetic filesystem metadata only: no Git command, child, provider, native
// selection or installed profile. These tests qualify only the metadata reader.
import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
	"golang.org/x/sys/unix"
)

type gitMetadataFixture struct {
	root               task.Root
	common, admin, dot string
}

func gitMetadataWrite(t *testing.T, name, value string) {
	t.Helper()
	if err := os.WriteFile(name, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func newGitMetadataFixture(t *testing.T, linked bool) gitMetadataFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	common := filepath.Join(base, "project", ".git")
	root := filepath.Dir(common)
	for _, p := range []string{filepath.Join(common, "objects"), filepath.Join(common, "refs")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	gitMetadataWrite(t, filepath.Join(common, "HEAD"), "ref: refs/heads/unborn\n")
	f := gitMetadataFixture{common: common, admin: common, dot: common}
	if linked {
		root = filepath.Join(base, "writer")
		f.admin = filepath.Join(common, "worktrees", "writer")
		if err := os.MkdirAll(f.admin, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		f.dot = filepath.Join(root, ".git")
		gitMetadataWrite(t, f.dot, "gitdir: ../project/.git/worktrees/writer\n")
		gitMetadataWrite(t, filepath.Join(f.admin, "commondir"), "../..\n")
		gitMetadataWrite(t, filepath.Join(f.admin, "gitdir"), f.dot+"\n")
		gitMetadataWrite(t, filepath.Join(f.admin, "HEAD"), "ref: refs/heads/unborn\n")
	}
	var stat unix.Stat_t
	if err := unix.Lstat(root, &stat); err != nil {
		t.Fatal(err)
	}
	f.root = task.Root{Path: root, Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(uint64(stat.Ino), 10), GitCommonDirectory: common}
	return f
}

func TestGitMetadataSupportedTopologies(t *testing.T) {
	for _, linked := range []bool{false, true} {
		t.Run(strconv.FormatBool(linked), func(t *testing.T) {
			f := newGitMetadataFixture(t, linked)
			got, err := gitCommon(context.Background(), f.root)
			if err != nil || got != f.common {
				t.Fatalf("common = %q, %v", got, err)
			}
		})
	}
	t.Run("absolute-and-relative-pointers", func(t *testing.T) {
		f := newGitMetadataFixture(t, true)
		gitMetadataWrite(t, f.dot, "gitdir: "+f.admin+"\n")
		gitMetadataWrite(t, filepath.Join(f.admin, "commondir"), f.common+"\n")
		back, err := filepath.Rel(f.admin, f.dot)
		if err != nil {
			t.Fatal(err)
		}
		gitMetadataWrite(t, filepath.Join(f.admin, "gitdir"), back+"\n")
		if got, err := gitCommon(context.Background(), f.root); err != nil || got != f.common {
			t.Fatalf("common = %q, %v", got, err)
		}
	})
	t.Run("detached-head", func(t *testing.T) {
		f := newGitMetadataFixture(t, false)
		gitMetadataWrite(t, filepath.Join(f.common, "HEAD"), strings.Repeat("a", 40)+"\n")
		if _, err := gitCommon(context.Background(), f.root); err != nil {
			t.Fatal(err)
		}
	})
}

func TestGitMetadataRefusesUnsupportedOrMalformedTopology(t *testing.T) {
	cases := map[string]func(*testing.T, *gitMetadataFixture){
		"wrong-root-identity": func(t *testing.T, f *gitMetadataFixture) { f.root.Inode = "1" },
		"wrong-common":        func(t *testing.T, f *gitMetadataFixture) { f.root.GitCommonDirectory = filepath.Dir(f.common) },
		"wrong-project": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.admin, "commondir"), "../../..\n")
		},
		"wrong-worktree-backlink": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.admin, "gitdir"), filepath.Join(filepath.Dir(f.root.Path), "foreign", ".git")+"\n")
		},
		"missing-backlink": func(t *testing.T, f *gitMetadataFixture) {
			if err := os.Remove(filepath.Join(f.admin, "gitdir")); err != nil {
				t.Fatal(err)
			}
		},
		"not-worktrees-admin": func(t *testing.T, f *gitMetadataFixture) { gitMetadataWrite(t, f.dot, "gitdir: "+f.common+"\n") },
		"nested-worktrees-admin": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, f.dot, "gitdir: "+filepath.Join(f.admin, "nested")+"\n")
		},
		"bad-prefix":    func(t *testing.T, f *gitMetadataFixture) { gitMetadataWrite(t, f.dot, f.admin+"\n") },
		"empty-pointer": func(t *testing.T, f *gitMetadataFixture) { gitMetadataWrite(t, f.dot, "gitdir: \n") },
		"multiple-lines": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, f.dot, "gitdir: "+f.admin+"\nignored\n")
		},
		"nul":       func(t *testing.T, f *gitMetadataFixture) { gitMetadataWrite(t, f.dot, "gitdir: "+f.admin+"\x00\n") },
		"oversized": func(t *testing.T, f *gitMetadataFixture) { gitMetadataWrite(t, f.dot, strings.Repeat("x", 4097)) },
		"bad-common-line": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.admin, "commondir"), "../..\nextra\n")
		},
		"common-redirect": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.common, "commondir"), "..\n")
		},
		"erased-component": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, f.dot, "gitdir: "+f.admin+"/erased/..\n")
		},
		"erased-relative-component": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, f.dot, "gitdir: ../project/.git/worktrees/erased/../writer\n")
		},
		"head-invalid": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.admin, "HEAD"), "not a Git HEAD\n")
		},
		"head-missing": func(t *testing.T, f *gitMetadataFixture) {
			if err := os.Remove(filepath.Join(f.admin, "HEAD")); err != nil {
				t.Fatal(err)
			}
		},
		"head-empty": func(t *testing.T, f *gitMetadataFixture) { gitMetadataWrite(t, filepath.Join(f.admin, "HEAD"), "") },
		"head-oversized": func(t *testing.T, f *gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.admin, "HEAD"), strings.Repeat("x", 4097))
		},
		"objects-missing": func(t *testing.T, f *gitMetadataFixture) {
			if err := os.Remove(filepath.Join(f.common, "objects")); err != nil {
				t.Fatal(err)
			}
		},
		"refs-file": func(t *testing.T, f *gitMetadataFixture) {
			p := filepath.Join(f.common, "refs")
			if err := os.Remove(p); err != nil {
				t.Fatal(err)
			}
			gitMetadataWrite(t, p, "not a directory")
		},
		"dot-symlink": func(t *testing.T, f *gitMetadataFixture) {
			if err := os.Rename(f.dot, f.dot+"-real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(f.dot+"-real", f.dot); err != nil {
				t.Fatal(err)
			}
		},
		"common-parent-symlink": func(t *testing.T, f *gitMetadataFixture) {
			p := filepath.Dir(f.common)
			if err := os.Rename(p, p+"-real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(p+"-real", p); err != nil {
				t.Fatal(err)
			}
		},
		"commondir-symlink": func(t *testing.T, f *gitMetadataFixture) {
			p := filepath.Join(f.admin, "commondir")
			if err := os.Rename(p, p+"-real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(p+"-real", p); err != nil {
				t.Fatal(err)
			}
		},
		"gitfile-hardlink": func(t *testing.T, f *gitMetadataFixture) {
			if err := os.Link(f.dot, f.dot+"-link"); err != nil {
				t.Fatal(err)
			}
		},
		"backlink-hardlink": func(t *testing.T, f *gitMetadataFixture) {
			p := filepath.Join(f.admin, "gitdir")
			if err := os.Link(p, p+"-link"); err != nil {
				t.Fatal(err)
			}
		},
		"metadata-fifo": func(t *testing.T, f *gitMetadataFixture) {
			p := filepath.Join(f.admin, "commondir")
			if err := os.Remove(p); err != nil {
				t.Fatal(err)
			}
			if err := unix.Mkfifo(p, 0600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newGitMetadataFixture(t, true)
			mutate(t, &f)
			if got, err := gitCommon(context.Background(), f.root); !errors.Is(err, task.ErrIdentity) || got != "" {
				t.Fatalf("unexpected common = %q, %v", got, err)
			}
		})
	}
	t.Run("no-ancestor-discovery", func(t *testing.T) {
		f := newGitMetadataFixture(t, false)
		child := filepath.Join(f.root.Path, "nested")
		if err := os.Mkdir(child, 0700); err != nil {
			t.Fatal(err)
		}
		var st unix.Stat_t
		if err := unix.Lstat(child, &st); err != nil {
			t.Fatal(err)
		}
		f.root.Path, f.root.Device, f.root.Inode = child, strconv.FormatUint(uint64(st.Dev), 10), strconv.FormatUint(uint64(st.Ino), 10)
		if _, err := gitCommon(context.Background(), f.root); !errors.Is(err, task.ErrIdentity) {
			t.Fatalf("ancestor accepted: %v", err)
		}
	})
}

func TestGitMetadataRechecksHeldDescriptorsAndBytes(t *testing.T) {
	cases := map[string]func(*testing.T, gitMetadataFixture){
		"root-renamed": func(t *testing.T, f gitMetadataFixture) {
			if err := os.Rename(f.root.Path, f.root.Path+"-moved"); err != nil {
				t.Fatal(err)
			}
		},
		"root-replaced": func(t *testing.T, f gitMetadataFixture) {
			if err := os.Rename(f.root.Path, f.root.Path+"-moved"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(f.root.Path, 0700); err != nil {
				t.Fatal(err)
			}
		},
		"common-renamed": func(t *testing.T, f gitMetadataFixture) {
			if err := os.Rename(f.common, f.common+"-moved"); err != nil {
				t.Fatal(err)
			}
		},
		"metadata-replaced": func(t *testing.T, f gitMetadataFixture) {
			if err := os.Rename(f.dot, f.dot+"-moved"); err != nil {
				t.Fatal(err)
			}
			gitMetadataWrite(t, f.dot, "gitdir: "+f.admin+"\n")
		},
		"metadata-rewritten": func(t *testing.T, f gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.admin, "commondir"), "../../other\n")
		},
		"common-redirect-introduced": func(t *testing.T, f gitMetadataFixture) {
			gitMetadataWrite(t, filepath.Join(f.common, "commondir"), "..\n")
		},
		"hardlink-introduced": func(t *testing.T, f gitMetadataFixture) {
			if err := os.Link(f.dot, f.dot+"-late-link"); err != nil {
				t.Fatal(err)
			}
		},
		"same-size-restored-mtime": func(t *testing.T, f gitMetadataFixture) {
			p := filepath.Join(f.admin, "HEAD")
			st, err := os.Stat(p)
			if err != nil {
				t.Fatal(err)
			}
			gitMetadataWrite(t, p, "ref: refs/heads/change\n")
			if err := os.Chtimes(p, st.ModTime(), st.ModTime()); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newGitMetadataFixture(t, true)
			r := newGitMetadataReader(context.Background())
			defer r.close()
			if _, err := r.resolve(f.root); err != nil {
				t.Fatal(err)
			}
			mutate(t, f)
			if err := r.verify(); !errors.Is(err, task.ErrIdentity) {
				t.Fatalf("changed metadata accepted: %v", err)
			}
		})
	}
}

func TestGitMetadataClosesOwnedDescriptors(t *testing.T) {
	f := newGitMetadataFixture(t, true)
	r := newGitMetadataReader(context.Background())
	if _, err := r.resolve(f.root); err != nil {
		r.close()
		t.Fatal(err)
	}
	files := make([]*os.File, 0, len(r.held))
	for _, held := range r.held {
		files = append(files, held.file)
	}
	r.close()
	for _, file := range files {
		if _, err := file.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("descriptor still open: %v", err)
		}
	}
	if err := r.verify(); !errors.Is(err, task.ErrIdentity) {
		t.Fatalf("closed reader accepted: %v", err)
	}
}

func TestGitMetadataDoesNotBindUnrelatedDirectoryEntries(t *testing.T) {
	f := newGitMetadataFixture(t, true)
	r := newGitMetadataReader(context.Background())
	defer r.close()
	if _, err := r.resolve(f.root); err != nil {
		t.Fatal(err)
	}
	// A sibling affects parent times/link count, not any selected path or file.
	if err := os.Mkdir(filepath.Join(filepath.Dir(f.root.Path), "unrelated"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := r.verify(); err != nil {
		t.Fatalf("unrelated entry changed selection: %v", err)
	}
}

func TestGitMetadataCancellation(t *testing.T) {
	f := newGitMetadataFixture(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := gitCommon(ctx, f.root); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled = %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	r := newGitMetadataReader(ctx)
	defer r.close()
	if _, err := r.resolve(f.root); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := r.verify(); !errors.Is(err, context.Canceled) {
		t.Fatalf("late cancellation = %v", err)
	}
	if _, err := gitCommon(nil, f.root); !errors.Is(err, task.ErrIdentity) {
		t.Fatalf("nil context = %v", err)
	}
}
