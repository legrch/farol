//go:build darwin && farol_native_root_scoped

package process

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Native compiler conformance only: synthetic files and loopback listeners,
// no production Qualification, grants, connector, shell, Git or process-tree
// certificate. This tests the explicitly selected path-grant contract, not the
// historical object-level credential exclusion contract.
func TestNativeRootScopedSeatbelt(t *testing.T) {
	for _, write := range []bool{false, true} {
		if !t.Run("write="+strconv.FormatBool(write), func(t *testing.T) {
			nativeRootScopedSeatbelt(t, write, false)
		}) {
			return // Preserve a failed/unknown attempt; never launch its successor.
		}
	}
}

type rootScopedProbe struct {
	Reads, Writes map[string]string
	Listeners     map[string]string
	Renames       map[string][2]string
}

type rootScopedProbeResult struct {
	Reads, Writes, Network map[string]string
	Renames                map[string]string
}

func probeFailure(err error) string {
	if err == nil {
		return "allowed"
	}
	if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
		return "denied"
	}
	// ENOENT, a timeout or a dead listener must not count as sandbox denial.
	return "unconfirmed: " + err.Error()
}

func TestNativeRootScopedProbeHelper(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "--" {
		t.Skip("only the exact native fixture invokes this helper")
	}
	var probe rootScopedProbe
	if json.Unmarshal([]byte(os.Args[len(os.Args)-1]), &probe) != nil {
		os.Exit(90)
	}
	out := rootScopedProbeResult{Reads: map[string]string{}, Writes: map[string]string{}, Network: map[string]string{}, Renames: map[string]string{}}
	for name, path := range probe.Reads {
		data, err := os.ReadFile(path)
		out.Reads[name] = probeFailure(err)
		if err == nil {
			sum := sha256.Sum256(data)
			out.Reads[name] = hex.EncodeToString(sum[:])
		}
	}
	for name, path := range probe.Writes {
		out.Writes[name] = probeFailure(os.WriteFile(path, []byte("synthetic replacement\n"), 0600))
	}
	for name, paths := range probe.Renames {
		out.Renames[name] = probeFailure(os.Rename(paths[0], paths[1]))
	}
	for network, address := range probe.Listeners {
		connection, err := net.DialTimeout(network, address, time.Second)
		out.Network[network] = probeFailure(err)
		if connection != nil {
			_ = connection.Close()
		}
	}
	if json.NewEncoder(os.Stdout).Encode(out) != nil {
		os.Exit(91)
	}
	os.Exit(0)
}

func nativeRootScopedSeatbelt(t *testing.T, write bool, protectImages bool, aliases ...string) {
	t.Helper()
	base, err := os.MkdirTemp("/private/tmp", "farol-root-policy-")
	if err != nil {
		t.Fatal(err)
	}
	scratch, err := os.MkdirTemp("/private/tmp", "farol-root-scratch-")
	if err != nil {
		t.Fatal(err)
	}
	accepted := false
	t.Cleanup(func() {
		if !accepted {
			t.Logf("retain native evidence: %s %s; do not replay", base, scratch)
			return
		}
		for _, path := range []string{base, scratch} {
			if err := os.RemoveAll(path); err != nil {
				t.Error(err)
			}
		}
	})
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	identity := func(path string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(path)
		must(err)
		id := info.Sys().(*syscall.Stat_t)
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(id.Dev), 10), Inode: strconv.FormatUint(id.Ino, 10)}
	}
	hash := func(path string) string {
		t.Helper()
		data, err := os.ReadFile(path)
		must(err)
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	root, home, secondary := filepath.Join(base, "workspace"), filepath.Join(base, "home"), filepath.Join(base, "read-only")
	for _, dir := range []string{root, home, secondary, filepath.Join(root, ".git"), filepath.Join(root, ".codex")} {
		must(os.Mkdir(dir, 0700))
	}
	probe := rootScopedProbe{Reads: map[string]string{}, Writes: map[string]string{}, Listeners: map[string]string{}}
	for name, path := range map[string]string{
		"env": filepath.Join(root, ".env"), "git": filepath.Join(root, ".git/config"),
		"npm": filepath.Join(root, ".npmrc"), "agent": filepath.Join(root, ".codex/config.toml"),
		"outside": filepath.Join(base, "outside.txt"), "home": filepath.Join(home, "private.txt"),
		"secondary": filepath.Join(secondary, "read.txt"),
	} {
		must(os.WriteFile(path, []byte("synthetic "+name+"\n"), 0600))
		probe.Reads[name] = path
	}
	probe.Reads["outside-symlink"] = filepath.Join(root, "outside-link")
	probe.Reads["outside-hardlink"] = filepath.Join(root, "outside-hardlink")
	must(os.Symlink(probe.Reads["outside"], probe.Reads["outside-symlink"]))
	must(os.Link(probe.Reads["outside"], probe.Reads["outside-hardlink"]))
	if identity(probe.Reads["outside"]) != identity(probe.Reads["outside-hardlink"]) {
		t.Fatal("hardlink fixture does not share the outside inode")
	}
	baseline := map[string]string{}
	for name, path := range probe.Reads {
		baseline[name] = hash(path) // All targets exist and are readable before confinement.
	}
	for name, dir := range map[string]string{"workspace": root, "secondary": secondary, "outside": base, "scratch": scratch} {
		probe.Writes[name] = filepath.Join(dir, "write-probe")
		must(os.WriteFile(probe.Writes[name], []byte("synthetic baseline\n"), 0600))
	}
	for network, address := range map[string]string{"tcp4": "127.0.0.1:0", "tcp6": "[::1]:0"} {
		listener, err := net.Listen(network, address)
		must(err)
		t.Cleanup(func() { _ = listener.Close() })
		probe.Listeners[network] = listener.Addr().String()
		connection, err := net.DialTimeout(network, listener.Addr().String(), time.Second)
		must(err)
		must(connection.Close()) // Live listeners remain owned until after the child.
	}
	image, err := os.Executable()
	must(err)
	image, err = filepath.EvalSymlinks(image)
	must(err)
	s, command := rootScopedFixture(t)
	s.Home, s.Scratch, s.ScratchIdentity = home, scratch, identity(scratch)
	s.MechanismSHA256 = hash(seatbeltExecutable)
	s.Executables = []ExecutablePin{{Path: image, SHA256: hash(image)}}
	if protectImages {
		// Synthetic owner-owned app-shaped image inside the writable root.
		container := filepath.Join(root, "Applications")
		app := filepath.Join(container, "Farol.app")
		must(os.Mkdir(container, 0700))
		must(os.Mkdir(app, 0700))
		protected := filepath.Join(app, "backend")
		must(os.WriteFile(protected, []byte("synthetic baseline\n"), 0700))
		s.ProtectedImages = []ExecutablePin{{protected, hash(protected)}}
		probe.Writes["protected-image"] = protected
		probe.Renames = map[string][2]string{
			"app-parent":  {app, app + "-moved"},
			"apps-parent": {container, container + "-moved"},
		}
	}
	policyRoot := root
	if len(aliases) != 0 {
		if len(aliases) != 1 || !protectImages {
			t.Fatal("invalid native alias fixture")
		}
		logical, err := os.Stat(root)
		must(err)
		physical, err := os.Stat(dataVolumePath + root)
		must(err)
		if !os.SameFile(logical, physical) {
			t.Fatal("selected APFS spellings are not the same physical root")
		}
		switch aliases[0] {
		case "physical-root":
			policyRoot = dataVolumePath + root
			for name, paths := range probe.Renames {
				probe.Renames[name] = [2]string{dataVolumePath + paths[0], dataVolumePath + paths[1]}
			}
		case "physical-image":
			s.ProtectedImages[0].Path = dataVolumePath + s.ProtectedImages[0].Path
		default:
			t.Fatal("unknown native alias fixture")
		}
	}
	s.Snapshot.Participant.Grant.Workspaces[0].Root = policyRoot
	s.Snapshot.Approval.Workspaces[0].Root = policyRoot
	s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(root)
	addRootScope(&s, "secondary", secondary, authority.ReadAccess)
	s.Snapshot.Approval.Workspaces[1].RootIdentity = identity(secondary)
	command.Root, command.Cwd, command.RootIdentity = policyRoot, policyRoot, identity(root)
	command.Executable, command.ExecutableSHA256 = image, s.Executables[0].SHA256
	payload, err := json.Marshal(probe)
	must(err)
	command.Args, command.Input, command.Write = []string{"-test.run=^TestNativeRootScopedProbeHelper$", "--", string(payload)}, nil, write
	command.Environment = seatbeltEnvironment(s, write)
	plan, err := compileSeatbelt(s, command)
	must(err)
	arguments := append(append(append([]string(nil), plan.arguments...), image), command.Args...)
	child := exec.Command(seatbeltExecutable, arguments...)
	child.Env, child.Dir, child.WaitDelay = command.Environment, command.Cwd, time.Second
	var stdout, stderr bytes.Buffer
	child.Stdout, child.Stderr = &stdout, &stderr
	must(child.Start())
	t.Logf("single native path-policy attempt: imageSHA256=%s profileSHA256=%s retainedPID=%d", command.ExecutableSHA256, plan.digest, child.Process.Pid)
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("original native child failed: %v; diagnostic=%s", err, stderr.String())
		}
	case <-time.After(5 * time.Second):
		// One exact owning-handle stop, never a numeric PID/group lookup or retry.
		stopErr := child.Process.Kill()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		t.Fatalf("native result unconfirmed; retain original attempt; stop=%v", stopErr)
	}
	var out rootScopedProbeResult
	must(json.Unmarshal(stdout.Bytes(), &out))
	for name, expected := range baseline {
		if name == "outside" || name == "outside-symlink" || name == "home" {
			expected = "denied"
		}
		// The allowed hardlink is intentionally readable under path grants.
		if out.Reads[name] != expected {
			t.Fatalf("read %s: got %q want %q", name, out.Reads[name], expected)
		}
	}
	for name, path := range probe.Writes {
		expected, text := "denied", "synthetic baseline\n"
		if name == "scratch" || name == "workspace" && write {
			expected, text = "allowed", "synthetic replacement\n"
		}
		data, err := os.ReadFile(path)
		must(err)
		if out.Writes[name] != expected || string(data) != text {
			t.Fatalf("write %s differs from permission and independent readback", name)
		}
	}
	for network := range probe.Listeners {
		if out.Network[network] != "denied" {
			t.Fatalf("network %s not denied by permission: %q", network, out.Network[network])
		}
	}
	for name := range probe.Renames {
		if out.Renames[name] != "denied" {
			t.Fatalf("protected image ancestor rename %s: %q", name, out.Renames[name])
		}
	}
	accepted = true
	t.Log("native path reads/writes and IPv4/IPv6 denial verified; allowed hardlink exposes the same outside inode; no object secrecy or process-tree claim")
}

// A fresh writable-root fixture also protects an owner-owned app image and its
// namespace. Ordinary workspace writes remain allowed. No production activation.
func TestNativeRootScopedProtectedImages(t *testing.T) {
	nativeRootScopedSeatbelt(t, true, true)
}

func TestNativeRootScopedProtectedImageAPFSAliases(t *testing.T) {
	for _, spelling := range []string{"physical-root", "physical-image"} {
		if !t.Run(spelling, func(t *testing.T) { nativeRootScopedSeatbelt(t, true, true, spelling) }) {
			return // Preserve any failed or unknown original attempt, without a successor.
		}
	}
}
