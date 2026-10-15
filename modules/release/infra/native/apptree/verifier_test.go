package apptree

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const appGolden = "bbf5c981fd972e7e74a7402cfa8c49632b9625dfb0803780cd9766ba86752998"

func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func mkdir(t *testing.T, p string) {
	t.Helper()
	must(t, os.MkdirAll(p, 0755))
	must(t, os.Chmod(p, 0755))
}
func write(t *testing.T, p string, data []byte, mode os.FileMode) {
	t.Helper()
	must(t, os.WriteFile(p, data, mode))
	must(t, os.Chmod(p, mode))
}
func raw(t *testing.T, f *os.File, fn func(int)) {
	t.Helper()
	c, e := f.SyscallConn()
	must(t, e)
	must(t, c.Control(func(fd uintptr) { fn(int(fd)) }))
}
func open(t *testing.T, p string) *os.File {
	t.Helper()
	f, e := os.Open(p)
	must(t, e)
	t.Cleanup(func() { f.Close() })
	return f
}
func code(t *testing.T, e error, want Code) {
	t.Helper()
	var typed *Error
	if !errors.As(e, &typed) || typed.Code != want {
		t.Fatalf("got %v, want %s", e, want)
	}
}
func expected(d string) Expected                                   { return Expected{d, "1.2.3-preview", strings.Repeat("a", 64)} }
func accept(context.Context, []byte, []byte, string, string) error { return nil }
func fixture(t *testing.T) (string, *os.File, *os.File) {
	t.Helper()
	parent := t.TempDir()
	app := filepath.Join(parent, "App")
	mkdir(t, app)
	mkdir(t, filepath.Join(app, "Contents"))
	mkdir(t, filepath.Join(app, "Contents/Resources"))
	mkdir(t, filepath.Join(app, "Contents/Resources/app"))
	write(t, filepath.Join(app, "Contents/Info.plist"), []byte("plist bytes"), 0644)
	write(t, filepath.Join(app, "Contents/Resources/app/build-identity.json"), []byte("{}"), 0644)
	return app, open(t, parent), open(t, app)
}
func scan(t *testing.T, p string) (*inventory, error) {
	t.Helper()
	f := open(t, p)
	s := &inventory{entries: make(map[string]entry), digest: sha256.New(), buffer: make([]byte, 1<<20)}
	s.digest.Write([]byte("farol.next.tree-digest/v2\x00"))
	var e error
	raw(t, f, func(fd int) { e = s.walk(context.Background(), fd, "", 0, false) })
	return s, e
}
func digest(t *testing.T, p string) string {
	t.Helper()
	s, e := scan(t, p)
	must(t, e)
	return hex.EncodeToString(s.digest.Sum(nil))
}
func verifier(t *testing.T, p, a *os.File, d string, identity IdentityVerifier) *Verifier {
	t.Helper()
	v, e := New(p, a, "App", expected(d), identity)
	must(t, e)
	return v
}

func TestGoldenDigestVectors(t *testing.T) {
	// Fixed SHA256 values were generated independently with Python struct/hashlib,
	// not with this package's walker or serialization. No test invokes an oracle.
	for _, tc := range []struct {
		name, want string
		setup      func(string)
	}{
		{"empty", "a23bfdbe340ba52c5b5b69b482aec669ba591314776fbb3953153a40eadd4e7a", func(string) {}},
		{"simple", "748ef9437f840e992d0b4e1e331f9def31ebc6c622a93c3ee9c227f59b0e0aee", func(p string) {
			mkdir(t, p+"/bin")
			write(t, p+"/bin/run", []byte("hello\x00world"), 0751)
			write(t, p+"/empty", nil, 0600)
			must(t, os.Symlink("bin/run", p+"/shortcut"))
		}},
		{"unicode", "15dd0c842840bbda8d91973e3aa3d3c445df57b009b7d0936bdb07e39fb58287", func(p string) {
			for _, n := range []string{"a", "A", "é", "e\u0301", "\ue000", "\U00010000"} {
				write(t, p+"/"+n, []byte(n), 0644)
			}
		}},
		{"ambiguity-a", "5dba3f4b500dc2915ec5850d79fc4cecb0391144a15f25c491a95bfd24c95557", func(p string) { write(t, p+"/a", []byte("bc"), 0644) }},
		{"ambiguity-b", "9f78628ca6758abc2d38e78f05b143a386d632a4b25a7eaa9720c455f35ddfa0", func(p string) { write(t, p+"/ab", []byte("c"), 0644) }},
		{"special", "fabbbd9fa4dfa0eeb8bac5bd4cc3667c902c051819fcf73f6a58439a5513a538", func(p string) { write(t, p+"/run", []byte("x"), 0751|os.ModeSetuid|os.ModeSetgid) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := t.TempDir()
			tc.setup(p)
			if tc.name == "unicode" {
				entries, e := os.ReadDir(p)
				must(t, e)
				// This static vector needs six distinct raw names. Default APFS
				// may fold case/normalization; that host cannot create this fixture.
				want := map[string]bool{"a": true, "A": true, "é": true, "e\u0301": true, "\ue000": true, "\U00010000": true}
				for _, entry := range entries {
					delete(want, entry.Name())
				}
				if len(want) != 0 || len(entries) != 6 {
					t.Skip("raw-name digest fixture requires case/normalization-preserving filesystem")
				}
			}
			if got := digest(t, p); got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
			must(t, os.Chmod(p, 0700))
			if digest(t, p) != tc.want {
				t.Fatal("root mode entered digest")
			}
		})
	}
}

func TestVerifyBorrowedCustodyAndReentrancy(t *testing.T) {
	_, p, a := fixture(t)
	ctx := context.WithValue(context.Background(), struct{}{}, "original")
	var lock sync.Mutex
	calls := 0
	v := verifier(t, p, a, appGolden, func(got context.Context, info, build []byte, version, id string) error {
		if got != ctx || string(info) != "plist bytes" || string(build) != "{}" || version != "1.2.3-preview" || id != strings.Repeat("a", 64) {
			return errors.New("bad injection")
		}
		lock.Lock()
		calls++
		lock.Unlock()
		return nil
	})
	type flags struct {
		offset             int64
		status, descriptor int
	}
	state := func(f *os.File) flags {
		var s flags
		raw(t, f, func(fd int) {
			var e error
			s.offset, e = unix.Seek(fd, 0, 1)
			must(t, e)
			s.status, e = unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
			must(t, e)
			s.descriptor, e = unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
			must(t, e)
		})
		return s
	}
	// Move both borrowed directory offsets away from zero before verification.
	_, e := p.Readdirnames(1)
	must(t, e)
	_, e = a.Readdirnames(1)
	must(t, e)
	pb, ab := state(p), state(a)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Go(func() {
			o, e := v.Verify(ctx)
			if e == nil && (o.Root.Device == "" || o.Root.Inode == "" || o.Root.Mode&unix.S_IFMT != unix.S_IFDIR) {
				e = errors.New("missing observation")
			}
			errs <- e
		})
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		must(t, e)
	}
	if calls != 4 || state(p) != pb || state(a) != ab {
		t.Fatal("borrowed state changed")
	}
	bad := verifier(t, p, a, strings.Repeat("0", 64), accept)
	_, e = bad.Verify(ctx)
	code(t, e, CodeDigest)
	canceledCtx, cancel := context.WithCancel(ctx)
	cancel()
	_, e = v.Verify(canceledCtx)
	code(t, e, CodeCanceled)
	if state(p) != pb || state(a) != ab {
		t.Fatal("refusal changed borrowed state")
	}
	for _, cancelDuring := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		v := verifier(t, p, a, appGolden, func(context.Context, []byte, []byte, string, string) error {
			if cancelDuring {
				cancel()
			}
			return errors.New("private identity failure")
		})
		_, e = v.Verify(ctx)
		cancel()
		want := CodeIdentity
		if cancelDuring {
			want = CodeCanceled
		}
		code(t, e, want)
		if state(p) != pb || state(a) != ab {
			t.Fatal("identity failure changed borrowed state")
		}
	}
	_, e = v.Verify(nil)
	code(t, e, CodeInput)
}

func TestInputAndClosedHandles(t *testing.T) {
	_, p, a := fixture(t)
	for _, leaf := range []string{"", ".", "..", "a/b", "a\x00b", string([]byte{0xff}), strings.Repeat("a", 256)} {
		_, e := New(p, a, leaf, expected(appGolden), accept)
		code(t, e, CodeInput)
	}
	for _, ex := range []Expected{{"", "v", strings.Repeat("a", 64)}, {appGolden, "", strings.Repeat("a", 64)}, {appGolden, string([]byte{0xff}), strings.Repeat("a", 64)}, {appGolden, strings.Repeat("𐀀", 129), strings.Repeat("a", 64)}, {appGolden, "v", strings.Repeat("A", 64)}} {
		_, e := New(p, a, "App", ex, accept)
		code(t, e, CodeInput)
	}
	_, e := New(p, a, "App", expected(appGolden), nil)
	code(t, e, CodeInput)
	_, e = New(nil, a, "App", expected(appGolden), accept)
	code(t, e, CodeInput)
	v := verifier(t, p, a, appGolden, accept)
	must(t, a.Close())
	_, e = v.Verify(context.Background())
	if e == nil {
		t.Fatal("closed app accepted")
	}
	_, e = New(p, a, "App", expected(appGolden), accept)
	code(t, e, CodeInput)
	_, e = (&Verifier{}).Verify(context.Background())
	code(t, e, CodeInput)
	var nilVerifier *Verifier
	_, e = nilVerifier.Verify(context.Background())
	code(t, e, CodeInput)
}

func TestPhysicalRootAndTypes(t *testing.T) {
	for _, kind := range []string{"wrong-root", "detached", "root-link", "unsafe-root", "unsafe-child", "fifo", "hardlink", "invalid-name", "invalid-link"} {
		t.Run(kind, func(t *testing.T) {
			app, p, a := fixture(t)
			switch kind {
			case "wrong-root":
				a = open(t, t.TempDir())
			case "detached":
				must(t, os.Rename(app, app+"-old"))
				mkdir(t, app)
			case "root-link":
				must(t, os.Rename(app, app+"-old"))
				must(t, os.Symlink("App-old", app))
			case "unsafe-root":
				must(t, os.Chmod(app, 0777))
			case "unsafe-child":
				must(t, os.Chmod(app+"/Contents", 0777))
			case "fifo":
				must(t, unix.Mkfifo(app+"/pipe", 0600))
			case "hardlink":
				must(t, os.Link(app+"/Contents/Info.plist", app+"/alias"))
			case "invalid-name":
				write(t, app+"/"+string([]byte{0xff}), nil, 0600)
			case "invalid-link":
				must(t, os.Symlink(string([]byte{0xff}), app+"/link"))
			}
			v := verifier(t, p, a, appGolden, accept)
			_, e := v.Verify(context.Background())
			if e == nil {
				t.Fatal("hostile tree accepted")
			}
		})
	}
}

func TestFinalInventoryRejectsMutation(t *testing.T) {
	for _, kind := range []string{"same-size-restore-mtime", "truncate", "grow", "mode", "hardlink", "file-replace", "file-to-link", "file-to-fifo", "entry-add", "entry-remove", "directory-replace", "link-replace", "root-replace"} {
		t.Run(kind, func(t *testing.T) {
			app, p, a := fixture(t)
			must(t, os.Symlink("Contents", app+"/link"))
			d := digest(t, app)
			v := verifier(t, p, a, d, func(context.Context, []byte, []byte, string, string) error {
				target := app + "/Contents/Info.plist"
				switch kind {
				case "same-size-restore-mtime":
					st, e := os.Stat(target)
					must(t, e)
					write(t, target, []byte("PLIST BYTES"), 0644)
					must(t, os.Chtimes(target, st.ModTime(), st.ModTime()))
				case "truncate":
					must(t, os.Truncate(target, 0))
				case "grow":
					must(t, os.Truncate(target, 100))
				case "mode":
					must(t, os.Chmod(target, 0600))
				case "hardlink":
					must(t, os.Link(target, app+"/alias"))
				case "file-replace":
					must(t, os.Rename(target, target+"-old"))
					write(t, target, []byte("plist bytes"), 0644)
				case "file-to-link":
					must(t, os.Remove(target))
					must(t, os.Symlink("/etc/passwd", target))
				case "file-to-fifo":
					must(t, os.Remove(target))
					must(t, unix.Mkfifo(target, 0600))
				case "entry-add":
					write(t, app+"/new", nil, 0644)
				case "entry-remove":
					must(t, os.Remove(app+"/link"))
				case "directory-replace":
					must(t, os.Rename(app+"/Contents/Resources/app", app+"/Contents/Resources/old"))
					mkdir(t, app+"/Contents/Resources/app")
				case "link-replace":
					must(t, os.Remove(app+"/link"))
					must(t, os.Symlink("Contents/Resources", app+"/link"))
				case "root-replace":
					must(t, os.Rename(app, app+"-old"))
					mkdir(t, app)
				}
				return nil
			})
			_, e := v.Verify(context.Background())
			if e == nil {
				t.Fatal("mutation accepted")
			}
		})
	}
}

func TestIdentityBoundaryAndSanitizedErrors(t *testing.T) {
	app, p, a := fixture(t)
	secret := errors.New("/private/secret document content")
	v := verifier(t, p, a, appGolden, func(context.Context, []byte, []byte, string, string) error { return secret })
	_, e := v.Verify(context.Background())
	code(t, e, CodeIdentity)
	if e.Error() != "app tree: identity" || !errors.Is(e, secret) {
		t.Fatal("callback error was leaked or lost")
	}
	for _, size := range []int{0, 65536, 65537} {
		write(t, app+"/Contents/Info.plist", bytes.Repeat([]byte{'x'}, size), 0644)
		called := false
		v = verifier(t, p, a, digest(t, app), func(_ context.Context, b, _ []byte, _, _ string) error {
			called = true
			if len(b) != size {
				return secret
			}
			return nil
		})
		_, e = v.Verify(context.Background())
		if size == 65536 {
			must(t, e)
			if !called {
				t.Fatal("identity omitted")
			}
		} else {
			code(t, e, CodeIdentity)
			if called {
				t.Fatal("unbounded document callback")
			}
		}
	}
}

func TestIdentityFailureProvenance(t *testing.T) {
	for _, cancelDuring := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelDuring), func(t *testing.T) {
			_, p, a := fixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sentinel := errors.New("private native failure")
			cause := &os.PathError{Op: "identity", Path: "/private/input", Err: sentinel}
			calls := 0
			v := verifier(t, p, a, appGolden, func(got context.Context, _ []byte, _ []byte, _, _ string) error {
				calls++
				if got != ctx {
					t.Fatal("identity context changed")
				}
				if cancelDuring {
					cancel()
				}
				return cause
			})
			o, err := v.Verify(ctx)
			want := CodeIdentity
			if cancelDuring {
				want = CodeCanceled
			}
			code(t, err, want)
			var typed *os.PathError
			if calls != 1 || o != (Observation{}) || !errors.As(err, &typed) || typed != cause || !errors.Is(err, cause) || !errors.Is(err, sentinel) {
				t.Fatal("exact identity failure lost, retried or returned positive observation")
			}
			if err.Error() != "app tree: "+string(want) || errors.Is(err, context.Canceled) != cancelDuring {
				t.Fatal("outer refusal or cancellation cause changed")
			}
		})
	}
}

func TestCancellationAfterIdentityAndFreshVerification(t *testing.T) {
	app, p, a := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	v := verifier(t, p, a, appGolden, func(context.Context, []byte, []byte, string, string) error { cancel(); return nil })
	o, e := v.Verify(ctx)
	code(t, e, CodeCanceled)
	if o != (Observation{}) {
		t.Fatal("successful callback cancellation returned positive observation")
	}
	v = verifier(t, p, a, appGolden, accept)
	_, e = v.Verify(context.Background())
	must(t, e)
	write(t, app+"/Contents/Info.plist", []byte("new bytes!!"), 0644)
	_, e = v.Verify(context.Background())
	code(t, e, CodeDigest)
}

func TestLimitsAndStreaming(t *testing.T) {
	if maxEntries != 100000 || maxBytes != 1<<30 || maxDepth != 128 || maxRetained != 64<<20 || maxLink != 4096 || maxDocument != 65536 {
		t.Fatal("production bounds changed")
	}
	s := inventory{retained: maxRetained - 1}
	must(t, s.retain(1))
	code(t, s.retain(1), CodeLimit)
	p := t.TempDir()
	write(t, p+"/large", bytes.Repeat([]byte{42}, 3*(1<<20)+17), 0644)
	first := digest(t, p)
	write(t, p+"/large", bytes.Repeat([]byte{43}, 3*(1<<20)+17), 0644)
	if first == digest(t, p) {
		t.Fatal("stream content omitted")
	}
	f, e := os.OpenFile(p+"/large", os.O_WRONLY, 0)
	must(t, e)
	must(t, f.Truncate(maxBytes+1))
	must(t, f.Close())
	_, e = scan(t, p)
	code(t, e, CodeLimit)
	// Exact depth boundary: root at depth zero; a file below depth128 is legal.
	p = t.TempDir()
	deep := p
	for range maxDepth {
		deep += "/d"
		mkdir(t, deep)
	}
	write(t, deep+"/f", nil, 0644)
	_, e = scan(t, p)
	must(t, e)
	mkdir(t, deep+"/d")
	_, e = scan(t, p)
	code(t, e, CodeLimit)
}

func TestDirectoryEntryLimit(t *testing.T) {
	p := t.TempDir()
	for i := range maxEntries {
		f, e := os.OpenFile(filepath.Join(p, fmt.Sprintf("%06d", i)), os.O_CREATE|os.O_WRONLY, 0600)
		must(t, e)
		must(t, f.Close())
	}
	f := open(t, p)
	raw(t, f, func(fd int) {
		got, e := list(context.Background(), fd, maxEntries)
		must(t, e)
		if len(got) != maxEntries {
			t.Fatal(len(got))
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(time.Millisecond, cancel)
	defer timer.Stop()
	raw(t, f, func(fd int) { _, e := list(ctx, fd, maxEntries); code(t, e, CodeCanceled) })
	write(t, p+"/extra", nil, 0600)
	raw(t, f, func(fd int) { _, e := list(context.Background(), fd, maxEntries); code(t, e, CodeLimit) })
}

func TestCancellationDuringLargeRead(t *testing.T) {
	// Repeated 1MiB reads of a disposable sparse regular file give cancellation a
	// real native read loop; this asserts bounded return, not race exclusion.
	p := t.TempDir()
	path := p + "/large"
	write(t, path, nil, 0600)
	must(t, os.Truncate(path, maxBytes))
	f := open(t, p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var e error
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := f.SyscallConn()
		if err != nil {
			e = err
			return
		}
		controlErr := c.Control(func(fd uintptr) {
			s := inventory{buffer: make([]byte, 1<<20)}
			st, err := named(ctx, int(fd), "large")
			if err != nil {
				e = err
				return
			}
			_, e = s.read(ctx, int(fd), "large", st, nil)
		})
		if controlErr != nil {
			e = controlErr
		}
	}()
	// Context cancellation is independent of production code or mutable hooks.
	time.AfterFunc(time.Millisecond, cancel)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation stalled")
	}
	code(t, e, CodeCanceled)
}

func TestNamedHeldReplacementsBeforeRead(t *testing.T) {
	for _, replacement := range []string{"regular", "fifo", "symlink"} {
		t.Run(replacement, func(t *testing.T) {
			p := t.TempDir()
			write(t, p+"/file", []byte("original"), 0600)
			f := open(t, p)
			raw(t, f, func(fd int) {
				before, e := named(context.Background(), fd, "file")
				must(t, e)
				must(t, os.Rename(p+"/file", p+"/old"))
				switch replacement {
				case "regular":
					write(t, p+"/file", []byte("original"), 0600)
				case "fifo":
					must(t, unix.Mkfifo(p+"/file", 0600))
				case "symlink":
					must(t, os.Symlink("/etc/passwd", p+"/file"))
				}
				s := inventory{buffer: make([]byte, 1<<20)}
				_, e = s.read(context.Background(), fd, "file", before, nil)
				if e == nil {
					t.Fatal("crossed read accepted")
				}
			})
		})
	}
}

func TestVendorOwnershipDoesNotExpandDirectoryPolicy(t *testing.T) {
	if unix.Geteuid() != 0 {
		t.Skip("cross-UID fixture requires disposable chown privilege")
	}
	app, p, a := fixture(t)
	write(t, app+"/vendor", []byte("vendor bytes"), 0666)
	must(t, os.Chown(app+"/vendor", 65534, 65534))
	v := verifier(t, p, a, digest(t, app), accept)
	_, e := v.Verify(context.Background())
	must(t, e)
	must(t, os.Chown(app+"/Contents/Info.plist", 65534, 65534))
	v = verifier(t, p, a, digest(t, app), accept)
	_, e = v.Verify(context.Background())
	code(t, e, CodeIdentity)
	must(t, os.Chown(app+"/Contents", 65534, 65534))
	_, e = v.Verify(context.Background())
	code(t, e, CodeType)
}

func TestNativeLinkLengthBound(t *testing.T) {
	p := t.TempDir()
	target := "d" + strings.Repeat("/.", 2047)
	if e := os.Symlink(target, p+"/link"); e != nil {
		if errors.Is(e, unix.ENAMETOOLONG) {
			t.Skip("host symlink storage limit below 4095 bytes")
		}
		t.Fatal(e)
	}
	raw(t, open(t, p), func(fd int) {
		got, e := readLink(context.Background(), fd, "link")
		must(t, e)
		if got != target {
			t.Fatal("link truncated")
		}
	})
}

func TestEnumeratedSiblingsReserveGlobalBudget(t *testing.T) {
	p := t.TempDir()
	mkdir(t, p+"/a")
	mkdir(t, p+"/z")
	write(t, p+"/a/file", nil, 0600)
	// Two slots remain. Both root names must consume them before descent, so the
	// child file is refused before it can be retained, hashed or recursively read.
	s := inventory{count: maxEntries - 2, entries: make(map[string]entry), digest: sha256.New(), buffer: make([]byte, 1<<20)}
	raw(t, open(t, p), func(fd int) { code(t, s.walk(context.Background(), fd, "", 0, false), CodeLimit) })
	if s.count != maxEntries || len(s.entries) != 0 {
		t.Fatal("unreserved ancestor names")
	}
}

func TestVendorModesDoNotExpandDirectoryPolicy(t *testing.T) {
	app, p, a := fixture(t)
	write(t, app+"/vendor", []byte("vendor bytes"), 0666)
	v := verifier(t, p, a, digest(t, app), accept)
	_, e := v.Verify(context.Background())
	must(t, e)
}

func TestAggregateByteBudgetBoundary(t *testing.T) {
	p := t.TempDir()
	write(t, p+"/file", []byte("0123456789"), 0600)
	for _, used := range []int64{maxBytes - 10, maxBytes - 9} {
		s := inventory{bytes: used, entries: make(map[string]entry), digest: sha256.New(), buffer: make([]byte, 1<<20)}
		raw(t, open(t, p), func(fd int) {
			e := s.walk(context.Background(), fd, "", 0, false)
			if used == maxBytes-10 {
				must(t, e)
				if s.bytes != maxBytes {
					t.Fatal("wrong aggregate byte count")
				}
			} else {
				code(t, e, CodeLimit)
			}
		})
	}
}
