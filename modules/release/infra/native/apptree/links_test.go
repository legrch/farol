package apptree

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestLinkTextPolicyBoundary(t *testing.T) {
	for _, size := range []int{maxLink, maxLink + 1} {
		raw := bytes.Repeat([]byte{'x'}, size)
		got, e := linkText(raw)
		if size == maxLink {
			must(t, e)
			if got != string(raw) {
				t.Fatal("link text changed")
			}
		} else {
			code(t, e, CodeLimit)
		}
	}
	for _, raw := range [][]byte{nil, []byte("/absolute"), {0xff}, {'x', 0, 'y'}} {
		_, e := linkText(raw)
		code(t, e, CodeLink)
	}
}

func dir() entry               { return entry{stat: fingerprint{mode: unix.S_IFDIR}} }
func file() entry              { return entry{stat: fingerprint{mode: unix.S_IFREG}} }
func link(target string) entry { return entry{stat: fingerprint{mode: unix.S_IFLNK}, link: target} }
func TestInventoryLinkGraph(t *testing.T) {
	for _, tc := range []struct {
		name    string
		entries map[string]entry
		valid   bool
	}{
		{"framework", map[string]entry{"Framework": dir(), "Framework/Versions": dir(), "Framework/Versions/A": dir(), "Framework/Versions/A/Library": file(), "Framework/Versions/Current": link("A"), "Framework/Library": link("Versions/Current/Library")}, true},
		{"dotdot", map[string]entry{"a": dir(), "a/f": file(), "safe": file(), "x": link("a/../safe")}, true},
		{"dangling", map[string]entry{"x": link("missing")}, false},
		{"escape", map[string]entry{"x": link("../outside")}, false},
		{"root", map[string]entry{"x": link(".")}, false},
		{"self-cycle", map[string]entry{"x": link("x")}, false},
		{"two-cycle", map[string]entry{"x": link("y"), "y": link("x")}, false},
		{"file-intermediate", map[string]entry{"f": file(), "x": link("f/../f")}, false},
		{"file-dot", map[string]entry{"f": file(), "x": link("f/.")}, false},
		{"directory", map[string]entry{"d": dir(), "x": link("d/")}, true},
		{"component-before-dotdot", map[string]entry{"a": dir(), "Contents": dir(), "safe": file(), "a/b": link("../Contents"), "x": link("a/b/../../safe")}, false},
		{"raw-case", map[string]entry{"File": file(), "x": link("file")}, false},
		{"raw-normalization", map[string]entry{"é": file(), "x": link("e\u0301")}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := inventory{entries: tc.entries}
			e := s.links(context.Background())
			if tc.valid {
				must(t, e)
			} else {
				code(t, e, CodeLink)
			}
		})
	}
	for _, n := range []int{40, 41} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			s := inventory{entries: map[string]entry{"end": file()}}
			for i := n - 1; i >= 0; i-- {
				target := "end"
				if i < n-1 {
					target = fmt.Sprint(i + 1)
				}
				s.entries[fmt.Sprint(i)] = link(target)
			}
			e := s.links(context.Background())
			if n == 40 {
				must(t, e)
			} else {
				code(t, e, CodeLink)
			}
		})
	}
}

func TestPhysicalFrameworkAndAbsoluteLink(t *testing.T) {
	app, p, a := fixture(t)
	mkdir(t, app+"/Framework")
	mkdir(t, app+"/Framework/Versions")
	mkdir(t, app+"/Framework/Versions/A")
	write(t, app+"/Framework/Versions/A/Library", []byte("vendor"), 0755)
	must(t, os.Symlink("A", app+"/Framework/Versions/Current"))
	must(t, os.Symlink("Versions/Current/Library", app+"/Framework/Library"))
	v := verifier(t, p, a, digest(t, app), accept)
	_, e := v.Verify(context.Background())
	must(t, e)
	must(t, os.Symlink("/etc/passwd", app+"/outside"))
	_, e = v.Verify(context.Background())
	code(t, e, CodeLink)
}

func TestRetainedPathLimitNative(t *testing.T) {
	root := open(t, t.TempDir())
	raw(t, root, func(fd int) {
		current, e := unix.Openat(fd, ".", dirFlags, 0)
		must(t, e)
		// Long physical paths are made descriptor-relative, without host PATH_MAX
		// assumptions. There are fewer than 100000 entries and fewer than128 dirs.
		component := strings.Repeat("d", 128)
		for range 64 {
			must(t, unix.Mkdirat(current, component, 0755))
			next, e := unix.Openat(current, component, dirFlags, 0)
			must(t, e)
			must(t, unix.Close(current))
			current = next
		}
		for i := range 8200 {
			f, e := unix.Openat(current, fmt.Sprintf("f%04d", i), unix.O_CREAT|unix.O_WRONLY|unix.O_CLOEXEC, 0600)
			must(t, e)
			must(t, unix.Close(f))
		}
		must(t, unix.Close(current))
		s := inventory{entries: make(map[string]entry), digest: sha256.New(), buffer: make([]byte, 1<<20)}
		code(t, s.walk(context.Background(), fd, "", 0, false), CodeLimit)
	})
}

func TestGraphCancellation(t *testing.T) {
	s := inventory{entries: map[string]entry{"end": file()}}
	for i := range maxEntries - 1 {
		s.entries[fmt.Sprint(i)] = link("end")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(time.Millisecond, cancel)
	defer timer.Stop()
	code(t, s.links(ctx), CodeCanceled)
}
