package boot

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type selfTestReadNative struct {
	port.Workspace
	calls int
	after func()
}

func TestSelfTestReadFilePolicyComposition(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owners, err := newComputerReaders(root + "-home")
	if err != nil {
		t.Fatal(err)
	}
	const run = "00000000-0000-4000-8000-000000000001"
	leaf := state.ScratchPath(run)
	dir, file := filepath.Join(root, leaf), filepath.Join(root, leaf, "check.txt")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(selfTestFileAfter), 0600); err != nil {
		t.Fatal(err)
	}
	identity := func(path string) state.DirectoryIdentity {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		st := info.Sys().(*syscall.Stat_t)
		return state.DirectoryIdentity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}
	}
	rootID, dirID, fileID := identity(root), identity(dir), identity(file)
	binding := port.ScratchReadBinding{RunID: run, Directory: dirID, File: fileID, DirectoryHold: &fileWorkspaceHold{}, FileHold: &fileWorkspaceHold{}}
	for _, policy := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		request := port.ReadRequest{Workspace: port.Descriptor{WorkspaceID: "work", Root: root, ApprovedRoot: port.Root{Path: root, Device: rootID.Device, Inode: rootID.Inode}, FilePolicy: policy}, RelativePath: leaf + "/check.txt"}
		out, err := owners.ReadScratch(context.Background(), request, binding)
		if err != nil || out == nil || out.Text != selfTestFileAfter {
			t.Fatal("selected file policy did not read", policy, out, err)
		}
	}
}

func TestSelfTestReadKeepsCustodyUntilCancelledCallReturns(t *testing.T) {
	s, run, _, _ := selfTestFileFixture(t)
	run.scratchIdentity = state.DirectoryIdentity{Device: "1", Inode: "10"}
	run.scratchCustody = &fileWorkspaceHold{}
	run.fixtureFileIdentity = state.DirectoryIdentity{Device: "1", Inode: "20"}
	run.fixtureCustody = &fileWorkspaceHold{}
	run.fixtureFileHash = selfTestFileHash(selfTestFileAfter)
	run.fixtureEditStarted, run.fixtureOperation = true, "original-edit"
	entered, release := make(chan struct{}), make(chan struct{})
	native := &selfTestReadNative{Workspace: s.current.route.workspace, after: func() { close(entered); <-release }}
	s.current.route.workspace = native
	readDone := make(chan struct{})
	go func() { _, _ = run.readFixture(context.Background(), s, s.current, "read-call"); close(readDone) }()
	<-entered
	s.mutations.closeSelfTestStageAdmission()
	joined := make(chan struct{})
	waiting := make(chan struct{})
	go func() { close(waiting); s.mutations.waitSelfTestStage(); close(joined) }()
	<-waiting
	select {
	case <-joined:
		t.Fatal("released custody while read was active")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("cancelled read did not join")
	}
	<-readDone
}

func (n *selfTestReadNative) ReadScratch(_ context.Context, request port.ReadRequest, binding port.ScratchReadBinding) (*port.ReadResponse, error) {
	n.calls++
	if request.RelativePath != state.ScratchPath(binding.RunID)+"/check.txt" || binding.DirectoryHold.Check(binding.Directory) != nil || binding.FileHold.Check(binding.File) != nil {
		return nil, computerUnavailable()
	}
	if n.after != nil {
		n.after()
	}
	return &port.ReadResponse{Text: selfTestFileAfter, Bytes: uint64(len(selfTestFileAfter)), SHA256: selfTestFileHash(selfTestFileAfter)}, nil
}

// Real connector and authority owners, injected native workspace and journal.
// Native custody is separately tested on a disposable filesystem.
func TestSelfTestReadUsesCurrentLeaseAndOriginalCustody(t *testing.T) {
	for _, scenario := range []string{"success", "withdraw", "missing-custody"} {
		t.Run(scenario, func(t *testing.T) {
			s, run, _, _ := selfTestFileFixture(t)
			run.scratchIdentity = state.DirectoryIdentity{Device: "1", Inode: "10"}
			run.scratchCustody = &fileWorkspaceHold{}
			run.fixtureFileIdentity = state.DirectoryIdentity{Device: "1", Inode: "20"}
			run.fixtureCustody = &fileWorkspaceHold{}
			run.fixtureFileHash = selfTestFileHash(selfTestFileAfter)
			run.fixtureEditStarted, run.fixtureOperation = true, "original-edit"
			native := &selfTestReadNative{Workspace: s.current.route.workspace}
			s.current.route.workspace = native
			if scenario == "withdraw" {
				native.after = func() {
					s.current.guard.mu.Lock()
					s.current.guard.closed = true
					s.current.guard.mu.Unlock()
				}
			}
			if scenario == "missing-custody" {
				run.fixtureCustody = nil
			}
			out, err := run.readFixture(context.Background(), s, s.current, "read-call")
			if scenario == "success" {
				if err != nil || out == nil || out.Text != selfTestFileAfter || native.calls != 1 {
					t.Fatal("current read failed", out, err)
				}
			} else if err == nil || out != nil || (scenario == "missing-custody" && native.calls != 0) {
				t.Fatal("unqualified read disclosed", out, err, native.calls)
			}
			if run.active {
				t.Fatal("read did not release run fence")
			}
		})
	}
}
