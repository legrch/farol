package apptree_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
)

// Independent pinned v2 vectors were accepted by the original checked_tree
// in a one-time build-only oracle. These Go tests never launch an interpreter.
var composedTrees = []struct{ file, digest string }{
	{"oracle.xml", "aa5be957bca1b602513cc520d48ebabb39a79adfffe07ee47434fbc33f4a62bd"},
	{"oracle.bplist", "d0bd0b78217c34f9a0f86dad465ac033ec6a63cd1ba5bdeeffcac545d08bee2d"},
	{"oracle-utf16.xml", "5086cd4a28cf6b8c743cc733f7d2e9414dc5b8b080da1d5a8d8f4d45621cfe35"},
	{"oracle-uid.bplist", "ecef6399434dbe29029f2c8b84ebdd84df5aae35d67f0b3fa2ac7938d5f3082b"},
	{"oracle-padded.bplist", "448abb19d79c5e960c5760ce0a2f822a7ba17ac38d007696cdcac3ae24d008c6"},
	{"oracle-signed128.bplist", "bd644dd68b03085827b21c1af267a6ce56e6cad1e6c930dde8a35948a59af8e8"},
	{"oracle-width3.bplist", "482cfe7a3d135f1a1cce65813b3a2f1211dd943bad9679fb18ac8a2856e597f8"},
}

func appFixture(t *testing.T, name string) (*os.File, *os.File, string) {
	t.Helper()
	root := t.TempDir()
	appPath := filepath.Join(root, "Farol.app")
	for _, dir := range []string{"", "Contents", "Contents/Resources", "Contents/Resources/app"} {
		if err := os.Mkdir(filepath.Join(appPath, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []struct{ from, to string }{{name, "Contents/Info.plist"}, {"oracle.json", "Contents/Resources/app/build-identity.json"}} {
		data, err := os.ReadFile(filepath.Join("..", "appidentity", "testdata", file.from))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(appPath, file.to), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	parent, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = parent.Close() })
	app, err := os.Open(appPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return parent, app, appPath
}

func TestRealIdentityAndPhysicalTreeComposition(t *testing.T) {
	for _, tc := range composedTrees {
		t.Run(tc.file, func(t *testing.T) {
			parent, app, _ := appFixture(t, tc.file)
			v, err := apptree.New(parent, app, "Farol.app", apptree.Expected{TreeSHA256: tc.digest, Version: "1.2.3-preview.4", BuildID: strings.Repeat("a", 64)}, appidentity.Verify)
			if err != nil {
				t.Fatal(err)
			}
			observation, err := v.Verify(context.Background())
			if err != nil || observation.Root.Device == "" || observation.Root.Inode == "" {
				t.Fatalf("composition refused original oracle: %#v %v", observation, err)
			}
			if _, err := parent.Stat(); err != nil {
				t.Fatal("borrowed parent was closed")
			}
			if _, err := app.Stat(); err != nil {
				t.Fatal("borrowed app was closed")
			}
		})
	}
}

func TestDigestSuccessCannotSkipIdentityOrFinalInventory(t *testing.T) {
	for _, change := range []string{"version", "build-id", "post-identity-mutation"} {
		t.Run(change, func(t *testing.T) {
			parent, app, path := appFixture(t, composedTrees[0].file)
			expected := apptree.Expected{TreeSHA256: composedTrees[0].digest, Version: "1.2.3-preview.4", BuildID: strings.Repeat("a", 64)}
			verify := appidentity.Verify
			code := apptree.CodeIdentity
			switch change {
			case "version":
				expected.Version = "2.0.0"
			case "build-id":
				expected.BuildID = strings.Repeat("b", 64)
			case "post-identity-mutation":
				code = apptree.CodeChanged
				verify = func(ctx context.Context, info, build []byte, version, buildID string) error {
					if err := appidentity.Verify(ctx, info, build, version, buildID); err != nil {
						return err
					}
					return os.WriteFile(filepath.Join(path, "Contents/Info.plist"), []byte("changed"), 0600)
				}
			}
			v, err := apptree.New(parent, app, "Farol.app", expected, verify)
			if err != nil {
				t.Fatal(err)
			}
			observation, err := v.Verify(context.Background())
			var refusal *apptree.Error
			if !errors.As(err, &refusal) || refusal.Code != code || observation != (apptree.Observation{}) {
				t.Fatalf("incomplete verification accepted: %#v %v", observation, err)
			}
		})
	}
}
