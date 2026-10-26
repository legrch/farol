//go:build darwin && farol_native_root_scoped

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Synthetic HOME only, through the actual Seatbelt compiler and kernel. This
// proves four read-only literals, not live Git/connector or owner config access.
func TestNativeRootScopedUserGitSettings(t *testing.T) {
	for _, approved := range []bool{false, true} {
		if !t.Run(strconv.FormatBool(approved), func(t *testing.T) {
			base, err := os.MkdirTemp("/private/tmp", "farol-git-settings-")
			if err != nil {
				t.Fatal(err)
			}
			scratch, err := os.MkdirTemp("/private/tmp", "farol-git-settings-scratch-")
			if err != nil {
				t.Fatal(err)
			}
			accepted := false
			t.Cleanup(func() {
				if accepted {
					_ = os.RemoveAll(base)
					_ = os.RemoveAll(scratch)
				} else {
					t.Logf("retain disposable native evidence: %s %s", base, scratch)
				}
			})
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			identity := func(name string) authority.RootIdentity {
				var s syscall.Stat_t
				must(syscall.Lstat(name, &s))
				return authority.RootIdentity{Device: strconv.FormatUint(uint64(s.Dev), 10), Inode: strconv.FormatUint(s.Ino, 10)}
			}
			hash := func(name string) string {
				raw, err := os.ReadFile(name)
				must(err)
				digest := sha256.Sum256(raw)
				return hex.EncodeToString(digest[:])
			}
			home, root := filepath.Join(base, "home"), filepath.Join(base, "workspace")
			must(os.MkdirAll(filepath.Join(home, ".config/git"), 0700))
			must(os.Mkdir(root, 0700))
			probe := rootScopedProbe{Reads: map[string]string{}, Writes: map[string]string{}}
			original := map[string]string{}
			for _, name := range []string{".gitconfig", ".config/git/config", ".config/git/ignore", ".config/git/attributes", "private.txt", ".config/git/unapproved"} {
				file := filepath.Join(home, name)
				must(os.WriteFile(file, []byte("synthetic Git settings fixture\n"), 0600))
				probe.Reads[name], probe.Writes[name], original[name] = file, file, hash(file)
			}
			image, err := os.Executable()
			must(err)
			image, err = filepath.EvalSymlinks(image)
			must(err)
			s, command := rootScopedFixture(t)
			s.Home, s.Scratch, s.ScratchIdentity = home, scratch, identity(scratch)
			s.MechanismSHA256 = hash(seatbeltExecutable)
			s.Executables = []ExecutablePin{{Path: image, SHA256: hash(image)}}
			s.UserGitSettings = approved
			s.Snapshot.Approval.Workspaces[0].GitHistoryApproved = approved
			s.Snapshot.Approval.Workspaces[0].Root = root
			s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(root)
			s.Snapshot.Participant.Grant.Workspaces[0].Root = root
			command.Root, command.Cwd, command.RootIdentity = root, root, identity(root)
			command.Executable, command.ExecutableSHA256 = image, s.Executables[0].SHA256
			command.Environment = seatbeltEnvironment(s, command.Write)
			plan, err := compileSeatbelt(s, command)
			must(err)
			payload, err := json.Marshal(probe)
			must(err)
			args := append(append([]string(nil), plan.arguments...), image, "-test.run=^TestNativeRootScopedProbeHelper$", "--", string(payload))
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			child := exec.CommandContext(ctx, seatbeltExecutable, args...)
			child.Env, child.Dir, child.WaitDelay = command.Environment, root, time.Second
			var stdout, stderr bytes.Buffer
			child.Stdout, child.Stderr = &stdout, &stderr
			if err := child.Run(); err != nil {
				t.Fatalf("native result unconfirmed; no retry: %v %s", err, stderr.String())
			}
			var observed rootScopedProbeResult
			must(json.Unmarshal(stdout.Bytes(), &observed))
			for name, file := range probe.Reads {
				want := "denied"
				if approved && name != "private.txt" && name != ".config/git/unapproved" {
					want = original[name]
				}
				if observed.Reads[name] != want || observed.Writes[name] != "denied" || hash(file) != original[name] {
					t.Fatalf("Git literal %s: read %q want %q, write %q", name, observed.Reads[name], want, observed.Writes[name])
				}
			}
			accepted = true
		}) {
			return
		}
	}
}
