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
	{"oracle.xml", "6fffca33b1a4831aecd152a758c4b819e7cc60a844afda73b906b874a8d3f6f3"},
	{"oracle.bplist", "5655e32d0fd60f4acc2347182e9a779ab89266ecd8f970d78132233996e6e60f"},
	{"oracle-utf16.xml", "d4a4b6f152d0ecc8d293b582f4d0308af27bd1ee18e844e7eaf3f52bc838f689"},
	{"oracle-uid.bplist", "f7a5e9e74fe0b87f85cb43afe77a9effefdfa400ceed479626291690cc116062"},
	{"oracle-padded.bplist", "2ae1df67c9cc3d7cafb82bfb9ed325bf7232a27b18a1f24124d623239128d46a"},
	{"oracle-signed128.bplist", "99085c303becc021ceabe945f9d0b68e5952a5ee59d2b835da8cd4d1d055b2c7"},
	{"oracle-width3.bplist", "727b301b3e3faa2e90eb6d83a352a723773647490782ba472993bcf30e506178"},
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
			var identityCode appidentity.Code
			switch change {
			case "version":
				expected.Version = "2.0.0"
				identityCode = appidentity.BundleMismatch
			case "build-id":
				expected.BuildID = strings.Repeat("b", 64)
				identityCode = appidentity.BuildMismatch
			case "post-identity-mutation":
				code = apptree.CodeChanged
				verify = func(ctx context.Context, info, build []byte, version, buildID string) error {
					if err := appidentity.Verify(ctx, info, build, version, buildID); err != nil {
						return err
					}
					return os.WriteFile(filepath.Join(path, "Contents/Info.plist"), []byte("changed"), 0600)
				}
			}
			var identityCause error
			identityVerify := verify
			verify = func(ctx context.Context, info, build []byte, version, buildID string) error {
				identityCause = identityVerify(ctx, info, build, version, buildID)
				return identityCause
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
			if identityCode != "" {
				var identityFailure *appidentity.Error
				if err.Error() != "app tree: identity" || !errors.As(err, &identityFailure) || identityFailure.Code != identityCode || identityFailure != identityCause || !errors.Is(err, identityCause) {
					t.Fatal("real identity mismatch provenance lost or outer refusal changed")
				}
			}
		})
	}
}
