//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	chatrepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"golang.org/x/sys/unix"
)

var nativeStateInspectionEnabled = flag.Bool("native-state-inspection", false, "run disposable native state inspection composition on the Lead lane")

// Real parser, profile qualification, journal bytes and kernel locks. No app,
// child, network, provider or actual profile; not a packaged executable witness.
func TestNativeStateInspectionCommand(t *testing.T) {
	if !*nativeStateInspectionEnabled {
		t.Skip("requires explicit -native-state-inspection and the native lane")
	}
	parent, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(parent, "farol-native-state-inspection-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true", root)
	for _, name := range []string{"computer", "computer/mutations", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	physical := func(name string) unix.Stat_t {
		t.Helper()
		var value unix.Stat_t
		if err := unix.Lstat(name, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	p, c, m := physical(root), physical(filepath.Join(root, "chat")), physical(filepath.Join(root, "computer"))
	journal, err := chatrepo.New(context.Background(), chatrepo.Root{Path: filepath.Join(root, "chat"), ProfileID: "inspection-profile", Device: uint64(c.Dev), Inode: c.Ino, OwnerUID: c.Uid}, chatrepo.Limits{Bytes: 1048576, Records: 4096})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := journal.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := journal.OpenFresh(context.Background(), chatport.JournalScope{ProfileID: "inspection-profile", BackendGeneration: "original-backend"}); err != nil {
		t.Fatal(err)
	}
	mutations, err := mutationrepo.New(context.Background(), mutationrepo.Root{Path: filepath.Join(root, "computer"), Device: uint64(m.Dev), Inode: m.Ino, OwnerUID: m.Uid})
	if err != nil {
		t.Fatal(err)
	}
	if err := mutations.Close(); err != nil {
		t.Fatal(err)
	}
	args := []string{"inspect-native-state", "--profile", "inspection-profile", "--profile-root", root, "--profile-device", strconv.FormatUint(uint64(p.Dev), 10), "--profile-inode", strconv.FormatUint(p.Ino, 10), "--expected-build", BuildID}
	var output, diagnostics bytes.Buffer
	run := func() int {
		output.Reset()
		diagnostics.Reset()
		return Run(args, io.NopCloser(bytes.NewReader(nil)), inspectionBufferCloser{&output}, &diagnostics)
	}
	if code := run(); code != 1 || output.Len() != 0 {
		t.Fatal("live Chat owner was inspected", code)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	snapshot := filepath.Join(root, "chat", "chat-lifecycle.json")
	before, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if code := run(); code != 0 || diagnostics.Len() != 0 {
		t.Fatal("closed component inspection failed", code, diagnostics.String())
	}
	var got nativeStateInspection
	if json.Unmarshal(output.Bytes(), &got) != nil || got.BuildID != BuildID || got.ProfileID != "inspection-profile" || got.BackendGeneration != "original-backend" || got.ChatWriteCount != 0 || got.ChatTurnCount != 0 || got.ChatRetirement || got.ChatIncarnations != 1 || got.RecoveryAuthorized {
		t.Fatal("inspection changed identity or supplied recovery authority", output.String())
	}
	after, err := os.ReadFile(snapshot)
	digest := sha256.Sum256(before)
	if err != nil || !bytes.Equal(before, after) || got.ChatSnapshotSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatal("inspection changed canonical snapshot", err)
	}
	if err := os.WriteFile(filepath.Join(root, "computer", "mutations", ".retained-unknown.tmp"), []byte("unknown staging"), 0600); err != nil {
		t.Fatal(err)
	}
	if code := run(); code != 1 || output.Len() != 0 {
		t.Fatal("nonempty mutation store or staging was omitted", code)
	}
}

type inspectionBufferCloser struct{ *bytes.Buffer }

func (inspectionBufferCloser) Close() error { return nil }
