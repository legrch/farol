//go:build linux || darwin

package installcopy_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
	"github.com/legrch/farol/modules/release/infra/native/installcopy"
	"golang.org/x/sys/unix"
)

// Existing independently pinned checked_tree vectors from the original helper
// are reused here. The test copies inert files; it never launches an app or an
// interpreter, publishes a namespace, acquires admission or selects a helper.
func TestCopyRequiresIndependentExpectedTreeAndIdentity(t *testing.T) {
	for _, vector := range []struct{ file, digest string }{
		{"oracle.xml", "aa5be957bca1b602513cc520d48ebabb39a79adfffe07ee47434fbc33f4a62bd"},
		{"oracle.bplist", "d0bd0b78217c34f9a0f86dad465ac033ec6a63cd1ba5bdeeffcac545d08bee2d"},
	} {
		t.Run(vector.file, func(t *testing.T) {
			parentPath, sourcePath, targetPath := copyFixture(t, vector.file)
			parent, source, target := openFixture(t, parentPath), openFixture(t, sourcePath), openFixture(t, targetPath)
			expected := apptree.Expected{TreeSHA256: vector.digest, Version: "1.2.3-preview.4", BuildID: strings.Repeat("a", 64)}
			sourceVerifier := treeVerifier(t, parent, source, "Farol.app", expected)
			original, err := sourceVerifier.Verify(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			fences := 0
			op, err := installcopy.Prepare(copyDirectory(t, source), copyDirectory(t, target), time.Now().Add(time.Minute), func(ctx context.Context) error {
				fences++
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("copy fence lost original deadline")
				}
				_, err := sourceVerifier.Verify(ctx)
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			if err = op.Run(context.Background()); err != nil || fences != 2 {
				t.Fatalf("copy/fences: %v %d", err, fences)
			}
			targetVerifier := treeVerifier(t, parent, target, "launch-Farol.app", expected)
			copied, err := targetVerifier.Verify(context.Background())
			if err != nil || copied.Root.Device == "" || copied.Root.Inode == "" || copied.Root == original.Root {
				t.Fatalf("copied image not independently verified: %#v %v", copied, err)
			}
			wrong := expected
			wrong.BuildID = strings.Repeat("b", 64)
			observation, err := treeVerifier(t, parent, target, "launch-Farol.app", wrong).Verify(context.Background())
			var identityFailure *appidentity.Error
			if observation != (apptree.Observation{}) || !errors.As(err, &identityFailure) || identityFailure.Code != appidentity.BuildMismatch {
				t.Fatal("copy success bypassed independently expected build identity")
			}
			if err = os.WriteFile(filepath.Join(targetPath, "Contents", "Info.plist"), []byte("changed after copy"), 0600); err != nil {
				t.Fatal(err)
			}
			observation, err = targetVerifier.Verify(context.Background())
			var refusal *apptree.Error
			if observation != (apptree.Observation{}) || !errors.As(err, &refusal) || refusal.Code != apptree.CodeDigest {
				t.Fatal("copy success accepted subsequently changed image")
			}
			var consumed *installcopy.Failure
			if !errors.As(op.Run(context.Background()), &consumed) || !consumed.Uncertain {
				t.Fatal("failed final verification allowed copy replay")
			}
		})
	}
}

func TestCopiedLiteralLinkStillNeedsTreeAuthorization(t *testing.T) {
	parentPath, sourcePath, targetPath := copyFixture(t, "oracle.xml")
	if err := os.Symlink("../outside", filepath.Join(sourcePath, "literal")); err != nil {
		t.Fatal(err)
	}
	parent, source, target := openFixture(t, parentPath), openFixture(t, sourcePath), openFixture(t, targetPath)
	// A successful copy does not prove the source or grant link authority. The
	// owner must supply that proof and run complete final tree verification.
	op, err := installcopy.Prepare(copyDirectory(t, source), copyDirectory(t, target), time.Now().Add(time.Minute), func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err = op.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	text, err := os.Readlink(filepath.Join(targetPath, "literal"))
	if err != nil || text != "../outside" {
		t.Fatal("literal link was followed or rewritten")
	}
	expected := apptree.Expected{TreeSHA256: strings.Repeat("0", 64), Version: "1.2.3-preview.4", BuildID: strings.Repeat("a", 64)}
	observation, err := treeVerifier(t, parent, target, "launch-Farol.app", expected).Verify(context.Background())
	var refusal *apptree.Error
	if observation != (apptree.Observation{}) || !errors.As(err, &refusal) || refusal.Code != apptree.CodeLink {
		t.Fatal("successful literal copying granted escaping link authority")
	}
}

func copyFixture(t *testing.T, plist string) (parent, source, target string) {
	t.Helper()
	parent = t.TempDir()
	source, target = filepath.Join(parent, "Farol.app"), filepath.Join(parent, "launch-Farol.app")
	for _, path := range []string{source, target, filepath.Join(source, "Contents"), filepath.Join(source, "Contents/Resources"), filepath.Join(source, "Contents/Resources/app")} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []struct{ from, to string }{{plist, "Contents/Info.plist"}, {"oracle.json", "Contents/Resources/app/build-identity.json"}} {
		data, err := os.ReadFile(filepath.Join("..", "appidentity", "testdata", file.from))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(source, file.to), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return
}

func openFixture(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func copyDirectory(t *testing.T, file *os.File) installcopy.Directory {
	t.Helper()
	var stat unix.Stat_t
	raw, err := file.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var inner error
	if err = raw.Control(func(fd uintptr) { inner = unix.Fstat(int(fd), &stat) }); err != nil || inner != nil {
		t.Fatalf("fixture identity: %v %v", err, inner)
	}
	return installcopy.Directory{File: file, Identity: installcopy.Identity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10)}}
}

func treeVerifier(t *testing.T, parent, app *os.File, leaf string, expected apptree.Expected) *apptree.Verifier {
	t.Helper()
	v, err := apptree.New(parent, app, leaf, expected, appidentity.Verify)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
