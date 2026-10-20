package execution

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	stdruntime "runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/helperprotocol"
)

// Scratch executables are tiny non-GUI Go programs built and ad-hoc signed by
// the test run. They sleep, hold no state and are only ever started by a test
// that kills the exact pid it started. Building and signing here is test-only
// setup; production derives the expected hash without any tool.
var scratch struct {
	mu    sync.Mutex
	dir   string
	built map[string]string
}

func TestMain(m *testing.M) {
	code := m.Run()
	scratch.mu.Lock()
	if scratch.dir != "" {
		_ = os.RemoveAll(scratch.dir)
	}
	scratch.mu.Unlock()
	os.Exit(code)
}

const scratchSource = `package main

import "time"

var id = "unset"

func main() { _ = id; time.Sleep(10 * time.Minute) }
`

// scratchExecutable builds, once per id and architecture, a signed executable.
// digests selects codesign digest algorithms ("" is the default).
func scratchExecutable(t *testing.T, id, arch, digests string) string {
	t.Helper()
	if stdruntime.GOOS != "darwin" {
		t.Skip("scratch Mach-O fixtures need Darwin")
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go tool unavailable")
	}
	if _, err := os.Stat("/usr/bin/codesign"); err != nil {
		t.Skip("codesign unavailable")
	}
	scratch.mu.Lock()
	defer scratch.mu.Unlock()
	if scratch.dir == "" {
		dir, err := os.MkdirTemp("", "farol-launch-scratch-")
		must(t, err)
		scratch.dir, scratch.built = dir, make(map[string]string)
	}
	key := id + "|" + arch + "|" + digests
	if path, ok := scratch.built[key]; ok {
		return path
	}
	dir := filepath.Join(scratch.dir, hex.EncodeToString([]byte(key)))
	must(t, os.Mkdir(dir, 0700))
	must(t, os.WriteFile(filepath.Join(dir, "main.go"), []byte(scratchSource), 0600))
	must(t, os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module scratch\n\ngo 1.26\n"), 0600))
	path := filepath.Join(dir, "scratch")
	build := exec.Command(goTool, "build", "-o", path, "-ldflags", "-X main.id="+id, ".")
	build.Dir = dir
	build.Env = append(os.Environ(), "GOOS=darwin", "GOARCH="+arch, "CGO_ENABLED=0", "GOFLAGS=", "GOTOOLCHAIN=local", "GOPROXY=off", "GO111MODULE=on")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("scratch build failed: %v\n%s", err, out)
	}
	signScratch(t, path, digests)
	scratch.built[key] = path
	return path
}

func signScratch(t *testing.T, path, digests string) {
	t.Helper()
	args := []string{"--force", "--sign", "-"}
	if digests != "" {
		args = append(args, "--digest-algorithm="+digests)
	}
	if out, err := exec.Command("/usr/bin/codesign", append(args, path)...).CombinedOutput(); err != nil {
		t.Fatalf("codesign failed: %v\n%s", err, out)
	}
}

func copyFile(t *testing.T, from, to string, mode os.FileMode) {
	t.Helper()
	in, err := os.Open(from)
	must(t, err)
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	must(t, err)
	_, err = io.Copy(out, in)
	must(t, err)
	must(t, out.Sync())
	must(t, out.Close())
}

// treeDigest independently reproduces the application tree digest for the
// plain files and directories of a scratch bundle. It is checked by the real
// verifier, which refuses the fixture when the two disagree.
func treeDigest(t *testing.T, root string) string {
	t.Helper()
	h := sha256.New()
	h.Write([]byte("farol.next.tree-digest/v2\x00"))
	put32 := func(n int) {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], uint32(n))
		h.Write(b[:])
	}
	var walk func(dir, prefix string)
	walk = func(dir, prefix string) {
		entries, err := os.ReadDir(dir)
		must(t, err)
		for _, entry := range entries {
			path := prefix + entry.Name()
			var st syscall.Stat_t
			must(t, syscall.Lstat(filepath.Join(dir, entry.Name()), &st))
			put32(len(path))
			h.Write([]byte(path))
			switch st.Mode & syscall.S_IFMT {
			case syscall.S_IFDIR:
				h.Write([]byte{'d'})
				put32(int(st.Mode & 07777))
				walk(filepath.Join(dir, entry.Name()), path+"/")
			case syscall.S_IFREG:
				h.Write([]byte{'f'})
				put32(int(st.Mode & 07777))
				data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
				must(t, err)
				sum := sha256.Sum256(data)
				h.Write(sum[:])
			default:
				t.Fatal("unsupported scratch entry")
			}
		}
	}
	walk(root, "")
	return hex.EncodeToString(h.Sum(nil))
}

// writeBundle installs a scratch application bundle whose only executable is a
// copy of exe. Identity documents are the original-helper vectors, which pass
// the real identity policy for version 1.2.3-preview.4.
func writeBundle(t *testing.T, path, exe string) {
	t.Helper()
	for _, dir := range []string{"Contents/MacOS", "Contents/Resources/app"} {
		must(t, os.MkdirAll(filepath.Join(path, dir), 0700))
	}
	for _, document := range []struct{ from, to string }{{"oracle.xml", "Contents/Info.plist"}, {"oracle.json", "Contents/Resources/app/build-identity.json"}} {
		data, err := os.ReadFile(filepath.Join("..", "appidentity", "testdata", document.from))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(path, document.to), data, 0600))
	}
	copyFile(t, exe, filepath.Join(path, "Contents/MacOS/Sleeper"), 0700)
}

// relaunchFixture is a disposable slot-mode install: the real journal at
// launch_requested, a scratch bundle that passes the real tree and identity
// verification, and the protocol-built relaunch arguments.
type relaunchFixture struct {
	*compositionFixture
	app  string
	self port.HelperSelfIdentity
}

func newRelaunchFixture(t *testing.T, platform launchPlatform, exe string) *relaunchFixture {
	t.Helper()
	f := newCompositionFixtureAt(t, t.TempDir())
	app := filepath.Join(f.config.Files.Applications.Name(), "Farol.app")
	writeBundle(t, app, exe)
	nonce := make([]byte, 8)
	_, err := rand.Read(nonce)
	must(t, err)
	request := f.config.Request
	request.Schema, request.Action, request.Home = "farol.installed-update/1", "apply", f.root
	build := func(digest string) port.HelperBuild {
		return port.HelperBuild{Digest: digest, Version: "1.2.3-preview.4", BuildID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	}
	request.Source = build("aa5be957bca1b602513cc520d48ebabb39a79adfffe07ee47434fbc33f4a62bd")
	request.Target = build(treeDigest(t, app))
	request.Drain = port.HelperDrain{Status: "reconciled", AcceptedSource: request.Source.BuildID, AcceptedTarget: request.Target.BuildID}
	request.PID, request.ProcessStart, request.WaitSeconds = 123, "symbolic-process-start", 30
	must(t, f.repo.Close())
	f.owner.request, f.config.Request = request, request
	f.repo = f.open(t)
	f.config.Journal = f.repo
	f.put(t, f.encoded(t, "launch_requested"))
	rf := &relaunchFixture{compositionFixture: f, app: app,
		self: port.HelperSelfIdentity{PID: int64(os.Getpid()), ProcessStart: "scratch-" + hex.EncodeToString(nonce)}}
	f.config.MeasureSelf = func(context.Context, time.Time) (port.HelperSelfIdentity, error) { return rf.self, nil }
	f.config.RelaunchArguments = func(_ context.Context, self port.HelperSelfIdentity, captured *string) ([]string, error) {
		hint, err := helperprotocol.JSONCodec{}.Relaunch(port.HelperRelaunchHint{OperationID: request.OperationID, Action: request.Action, Phase: "completed", BuildID: request.Target.BuildID, Helper: self})
		if err != nil {
			return nil, err
		}
		return []string{"/usr/bin/open", "-a", app, "--args", "--farol-installed-update-relaunch=" + string(hint)}, nil
	}
	f.config.launch = platform
	return rf
}

// launch runs the self measurement and the one LaunchTarget call. It returns
// the method's own result and the scope's retained result separately.
func (f *relaunchFixture) launch(t *testing.T) (method, scope error) {
	t.Helper()
	scope = f.with(context.Background(), func(native port.HelperRecoveryRuntime) error {
		effects := native.(port.HelperRelaunchEffects)
		self, err := effects.SelfIdentity(context.Background())
		if err != nil {
			t.Fatal("self measurement", err)
		}
		method = effects.LaunchTarget(context.Background(), self, nil)
		return method
	})
	return method, scope
}

func (f *relaunchFixture) phase(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.path, "journal.json"))
	must(t, err)
	var wire struct{ Phase string }
	must(t, json.Unmarshal(data, &wire))
	return wire.Phase
}

// scratchUniversal returns a signed two-slice executable (arm64, amd64) and the
// code-directory hash of each slice in file order, as the signing tool reports.
func scratchUniversal(t *testing.T) (string, [][20]byte) {
	t.Helper()
	if _, err := os.Stat("/usr/bin/lipo"); err != nil {
		t.Skip("lipo unavailable")
	}
	arm := scratchExecutable(t, "golden", "arm64", "")
	intel := scratchExecutable(t, "golden", "amd64", "")
	scratch.mu.Lock()
	path := filepath.Join(scratch.dir, "universal")
	scratch.mu.Unlock()
	if _, err := os.Stat(path); err != nil {
		if out, err := exec.Command("/usr/bin/lipo", "-create", arm, intel, "-output", path).CombinedOutput(); err != nil {
			t.Fatalf("lipo failed: %v\n%s", err, out)
		}
		signScratch(t, path, "")
	}
	return path, [][20]byte{codesignCDHash(t, path, "arm64"), codesignCDHash(t, path, "x86_64")}
}
