//go:build darwin && farol_native_root_scoped && farol_native_mount_boundaries

package process

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// This is a release-blocking native experiment, not installed Shell acceptance.
// Only disposable disk images are mounted. The owner volumes are never touched.
// A topology snapshot is insufficient if a later mount remains accessible.
func TestNativeMountBoundaryIsolationDuringExecution(t *testing.T) {
	for _, filesystem := range []string{"HFS+", "APFS"} {
		for _, write := range []bool{false, true} {
			if !t.Run(fmt.Sprintf("%s/write=%t", filesystem, write), func(t *testing.T) { nativeMountBoundaryCase(t, filesystem, write) }) {
				return
			}
		}
	}
}
func nativeMountBoundaryCase(t *testing.T, filesystem string, write bool) {
	base, err := os.MkdirTemp("/private/tmp", "farol-mount-boundary-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("retained synthetic fixture: %s", base)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(base, "workspace")
	scratch, err := os.MkdirTemp("/private/tmp", "farol-mount-scratch-")
	must(err)
	t.Logf("retained synthetic scratch: %s", scratch)
	known, late := filepath.Join(root, "blocked"), filepath.Join(root, "late")
	for _, path := range []string{root, known, late} {
		must(os.Mkdir(path, 0700))
	}
	runDisk := func(args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/usr/bin/hdiutil", args...)
		cmd.WaitDelay = time.Second
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("owned disk image operation unconfirmed; do not replay: %v: %s", err, out)
		}
	}
	attached := map[string]bool{}
	attach := func(name, target, filesystem string) {
		t.Helper()
		image := filepath.Join(base, name+".dmg")
		runDisk("create", "-size", "64m", "-fs", filesystem, "-volname", "FarolBoundary", "-type", "UDIF", image)
		runDisk("attach", "-nobrowse", "-noautoopen", "-mountpoint", target, image)
		attached[target] = true
		t.Cleanup(func() {
			if attached[target] {
				runDisk("detach", target)
				attached[target] = false
			}
		})
		var rootFS, mountedFS syscall.Statfs_t
		must(syscall.Statfs(root, &rootFS))
		must(syscall.Statfs(target, &mountedFS))
		if rootFS.Fsid == mountedFS.Fsid {
			t.Fatal("fixture did not produce a different mounted filesystem")
		}
	}
	execSource := filepath.Join(base, "execute.c")
	executable := filepath.Join(base, "execute")
	must(os.WriteFile(execSource, []byte("int main(void) { return 0; }\n"), 0600))
	compileContext, cancelCompile := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelCompile()
	compile := exec.CommandContext(compileContext, "/usr/bin/clang", "-o", executable, execSource)
	compile.WaitDelay = time.Second
	if output, err := compile.CombinedOutput(); err != nil {
		t.Fatalf("compile fixture executable: %v %s", err, output)
	}
	executableBytes, err := os.ReadFile(executable)
	must(err)
	seed := func(dir string) {
		t.Helper()
		must(os.WriteFile(filepath.Join(dir, "canary"), []byte("synthetic mounted data\n"), 0600))
		must(os.WriteFile(filepath.Join(dir, "execute"), executableBytes, 0700))
	}
	seed(root)
	must(os.Symlink(known, filepath.Join(root, "known-alias")))
	must(os.Symlink(late, filepath.Join(root, "late-alias")))
	must(os.Symlink(root, filepath.Join(root, "ordinary-alias")))
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
	image, err := os.Executable()
	must(err)
	image, err = filepath.EvalSymlinks(image)
	must(err)
	s, command := rootScopedFixture(t)
	s.Home, s.Scratch, s.ScratchIdentity = root, scratch, identity(scratch)
	s.MechanismSHA256 = hash(seatbeltExecutable)
	s.Executables = []ExecutablePin{{Path: image, SHA256: hash(image)}, {Path: "/bin/sh", SHA256: hash("/bin/sh")}}
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(root)
	s.MountDenials = []string{known}
	s.RootVolumeOnly = true
	command.Root, command.Cwd, command.RootIdentity = root, root, identity(root)
	command.Executable, command.ExecutableSHA256 = image, hash(image)
	command.Args = []string{"-test.run=^TestNativeMountBoundaryProbeHelper$", "--", root}
	command.Input = nil
	command.Write = write
	command.Environment = seatbeltEnvironment(s, write)
	plan, err := compileSeatbelt(s, command)
	must(err)
	attach("known", known, filesystem)
	seed(known)
	args := append(append(append([]string(nil), plan.arguments...), image), command.Args...)
	child := exec.Command(seatbeltExecutable, args...)
	child.Dir, child.Env, child.WaitDelay = root, command.Environment, time.Second
	stdout, err := child.StdoutPipe()
	must(err)
	stdin, err := child.StdinPipe()
	must(err)
	var stderr bytes.Buffer
	child.Stderr = &stderr
	must(child.Start())
	stopped := false
	defer func() {
		if !stopped {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	reader := bufio.NewReader(stdout)
	ready := make(chan string, 1)
	go func() {
		line, err := reader.ReadString('\n')
		if err != nil {
			ready <- "error: " + err.Error()
			return
		}
		ready <- line
	}()
	select {
	case line := <-ready:
		if line != "READY\n" {
			t.Fatalf("helper not ready: %q %s", line, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("original helper readiness unknown; no replay")
	}
	t.Logf("confined helper running before late mount: pid=%d profile=%s image=%s", child.Process.Pid, plan.digest, command.ExecutableSHA256)
	attach("late", late, filesystem)
	seed(late)
	readProbe := func(phase string) map[string]string {
		t.Helper()
		_, err = stdin.Write([]byte("probe\n"))
		must(err)
		line := make(chan string, 1)
		go func() {
			value, e := reader.ReadString('\n')
			if e != nil {
				line <- ""
			} else {
				line <- value
			}
		}()
		var observation string
		select {
		case observation = <-line:
		case <-time.After(5 * time.Second):
			t.Fatal("original probe unknown; no replay")
		}
		must(os.WriteFile(filepath.Join(base, phase+".json"), []byte(observation), 0600))
		var got map[string]string
		must(json.Unmarshal([]byte(observation), &got))
		for _, label := range []string{"known", "firmlink", "symlink", "late", "late-firmlink", "late-symlink"} {
			for _, op := range []string{"read", "write", "exec"} {
				if got[label+"-"+op] != "denied" {
					t.Errorf("%s %s %s: %q; require kernel denial", phase, label, op, got[label+"-"+op])
				}
			}
		}
		for _, label := range []string{"ordinary", "ordinary-firmlink", "ordinary-symlink"} {
			for _, op := range []string{"read", "write", "exec"} {
				want := "allowed"
				if op == "write" && !write {
					want = "denied"
				}
				if got[label+"-"+op] != want {
					t.Errorf("%s %s %s: %q, want %s", phase, label, op, got[label+"-"+op], want)
				}
			}
		}
		t.Logf("%s observations: %s", phase, observation)
		return got
	}
	readProbe("late-mount")
	runDisk("detach", late)
	attached[late] = false
	attach("replacement", late, filesystem)
	seed(late)
	readProbe("replacement-mount")
	must(stdin.Close())

	result := make(chan []byte, 1)
	go func() {
		var out bytes.Buffer
		_, err := out.ReadFrom(reader)
		if err != nil {
			result <- nil
			return
		}
		result <- out.Bytes()
	}()
	var observation []byte
	select {
	case observation = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("original native probe result unknown; no replay")
	}
	err = child.Wait()
	stopped = true
	if err != nil {
		t.Fatalf("original confined helper failed: %v %s", err, stderr.String())
	}
	if len(observation) != 0 {
		t.Fatalf("unexpected trailing helper output: %q", observation)
	}
}

func TestNativeMountBoundaryProbeHelper(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "--" {
		t.Skip("only the exact native fixture invokes this helper")
	}
	root := os.Args[len(os.Args)-1]
	fmt.Println("READY")
	reader := bufio.NewReader(os.Stdin)
	for {
		if _, err := reader.ReadString('\n'); err != nil {
			os.Exit(0)
		}
		out := map[string]string{}
		for label, dir := range map[string]string{
			"ordinary": root, "ordinary-firmlink": dataVolumePath + root, "ordinary-symlink": filepath.Join(root, "ordinary-alias"),
			"known": filepath.Join(root, "blocked"), "firmlink": dataVolumePath + filepath.Join(root, "blocked"), "symlink": filepath.Join(root, "known-alias"),
			"late": filepath.Join(root, "late"), "late-firmlink": dataVolumePath + filepath.Join(root, "late"), "late-symlink": filepath.Join(root, "late-alias"),
		} {
			_, err := os.ReadFile(filepath.Join(dir, "canary"))
			out[label+"-read"] = probeFailure(err)
			out[label+"-write"] = probeFailure(os.WriteFile(filepath.Join(dir, "written"), []byte("synthetic write\n"), 0600))
			out[label+"-exec"] = probeFailure(exec.Command(filepath.Join(dir, "execute")).Run())
		}
		if json.NewEncoder(os.Stdout).Encode(out) != nil {
			os.Exit(92)
		}
	}
}
