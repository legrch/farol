package boot

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	nativeprocess "github.com/legrch/farol/modules/computer/infra/process"
)

// CPU composition evidence: real connector admission, lease and compiler;
// synthetic platform support/scratch and a qualification that always refuses.
// No filesystem, watchdog, process, package or live connector is exercised.
type shellNeverQualified struct{}

func (shellNeverQualified) Qualify(context.Context, nativeprocess.Command) error {
	return errors.New("CPU fixture cannot launch")
}

type shellFactoryFixture struct {
	factory       *connectorShellFactory
	lease         *execution.Lease
	connector     *computerConnector
	access        *connectorJournalFixture
	native        *connectorProcessNativeDouble
	allocations   int
	preparations  int
	command       nativeprocess.Command
	policy        nativeprocess.SeatbeltSelection
	invocation    processsvc.Invocation
	beforePrepare func()
}

func newShellFactoryFixture(t *testing.T) *shellFactoryFixture {
	t.Helper()
	s, access, _, native, launch := connectorProcessFixture(t)
	access.approval.FilePolicy = authority.RootScopedFiles
	access.PutApproval(access.approval)
	s.root.publication.approval = access.approval.Clone()
	selectConnectorProcessSlot(t, s, access, launch, "shell")
	lease, err := s.current.route.admit(context.Background(), authority.Shell)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &shellFactoryFixture{lease: lease, connector: s, access: access, native: native}
	pin := func(path string) nativeprocess.ExecutablePin {
		return nativeprocess.ExecutablePin{Path: path, SHA256: strings.Repeat("a", 64)}
	}
	f := &connectorShellFactory{lifetime: context.Background(), clock: access.clock, config: connectorShellConfig{
		runtimeID: "shell-runtime", home: "/Users/owner", support: nativeprocess.RootScopedPlatformSupport{
			Backend: pin("/app/Farol.app/Contents/Resources/backend"), Watchdog: pin("/app/Farol.app/Contents/MacOS/helper"),
			Mechanism: pin("/usr/bin/sandbox-exec"), Executables: []nativeprocess.ExecutablePin{pin("/bin/bash"), pin("/usr/bin/git")},
			ProtectedBundle: &nativeprocess.ProtectedBundle{Path: "/app/Farol.app", Identity: authority.RootIdentity{Device: "1", Inode: "8"}},
		}}}
	f.scratch = func(ctx context.Context) (connectorShellScratch, error) {
		if !native.unlocked() {
			t.Fatal("scratch allocation under an owner lock")
		}
		deadline, ok := ctx.Deadline()
		if !ok || deadline != lease.Deadline() {
			t.Fatal("preparation did not retain the original deadline")
		}
		fixture.allocations++
		return connectorShellScratch{path: "/private/tmp/farol-shell-cpu", identity: authority.RootIdentity{Device: "1", Inode: "9"}}, nil
	}
	f.prepare = func(ctx context.Context, command nativeprocess.Command, policy nativeprocess.SeatbeltSelection, invocation processsvc.Invocation) (processsvc.Selected, error) {
		if !native.unlocked() {
			t.Fatal("preparation under an owner lock")
		}
		fixture.preparations++
		fixture.command, fixture.policy, fixture.invocation = command, policy, invocation.Clone()
		if fixture.beforePrepare != nil {
			fixture.beforePrepare()
		}
		compiler, err := nativeprocess.NewSeatbelt(policy, shellNeverQualified{})
		if err != nil {
			return nil, err
		}
		command.Environment = compiler.Environment(command.Write)
		preparer, err := nativeprocess.NewPreparer(f.config.runtimeID, command, compiler, f.clock)
		if err != nil {
			return nil, err
		}
		return preparer.Prepare(ctx, invocation)
	}
	fixture.factory = f
	return fixture
}

func shellFactoryRequest() connectorShellRequest {
	return connectorShellRequest{WorkspaceID: "work", RelativeCwd: "src", Command: "printf '%s' test", Stdin: "synthetic input\x00\n"}
}

func TestConnectorShellFactoryUsesOriginalLeaseAndPolicy(t *testing.T) {
	f := newShellFactoryFixture(t)
	request := shellFactoryRequest()
	deadline := f.lease.Deadline()
	selected, observer, err := f.factory.selectShell(context.Background(), f.lease, request)
	if err != nil || selected == nil || observer == nil {
		t.Fatal("selection refused", err)
	}
	if f.allocations != 1 || f.preparations != 1 || f.native.spawns != 0 || f.native.journal.reserves != 0 || f.lease.Deadline() != deadline {
		t.Fatal("selection dispatched, reserved or renewed")
	}
	if f.command.Root != "/disposable" || f.command.Cwd != "/disposable/src" || f.command.RootIdentity != (authority.RootIdentity{Device: "1", Inode: "2"}) ||
		f.command.Executable != "/bin/bash" || f.command.Environment != nil || f.policy.FilePolicy != authority.RootScopedFiles ||
		f.policy.Network != authority.NoNetwork || f.policy.Git != nativeprocess.RootScopedGit || f.policy.Scratch != "/private/tmp/farol-shell-cpu" {
		t.Fatal("crossed root-owned inputs")
	}
	if f.invocation.RuntimeID != "shell-runtime" || f.invocation.SessionID != f.lease.Binding().SessionID || f.invocation.ModelID != "chatgpt" ||
		f.invocation.AdmissionID != f.policy.Snapshot.Participant.Grant.AuthorityID ||
		!reflect.DeepEqual(f.invocation.Arguments, []string{"--noprofile", "--norc", "-c", request.Command}) || string(f.invocation.Input) != request.Stdin {
		t.Fatal("invocation did not preserve exact selected input")
	}
	f.access.approval.Workspaces[0].Root = "/changed"
	if f.policy.Snapshot.Approval.Workspaces[0].Root != "/disposable" || selected.Seal().Root != "/disposable" {
		t.Fatal("captured policy aliases mutable approval")
	}
}

func TestConnectorShellFactoryRefusesInvalidInputBeforeAllocation(t *testing.T) {
	for _, change := range []func(*connectorShellRequest){
		func(r *connectorShellRequest) { r.WorkspaceID = "unknown" },
		func(r *connectorShellRequest) { r.RelativeCwd = "../outside" },
		func(r *connectorShellRequest) { r.RelativeCwd = "/outside" },
		func(r *connectorShellRequest) { r.RelativeCwd = strings.Repeat("a", 4097) },
		func(r *connectorShellRequest) { r.Command = "" },
		func(r *connectorShellRequest) { r.Command = "bad\x00command" },
		func(r *connectorShellRequest) { r.Command = string([]byte{255}) },
		func(r *connectorShellRequest) { r.Command = strings.Repeat("a", 65537) },
		func(r *connectorShellRequest) { r.Stdin = strings.Repeat("a", 262145) },
		func(r *connectorShellRequest) { r.Write = true },
	} {
		f := newShellFactoryFixture(t)
		r := shellFactoryRequest()
		change(&r)
		selected, observer, err := f.factory.selectShell(context.Background(), f.lease, r)
		if err == nil || selected != nil || observer != nil || f.allocations != 0 || f.preparations != 0 {
			t.Fatal("invalid input reached native preparation")
		}
	}
}

func TestConnectorShellFactoryRefusesExpiredRevokedOrCancelledSelection(t *testing.T) {
	for _, stage := range []string{"before", "scratch", "prepare"} {
		for _, mode := range []string{"deadline", "revoked", "cancelled", "removed-workspace", "changed-root"} {
			t.Run(stage+"/"+mode, func(t *testing.T) {
				f := newShellFactoryFixture(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				change := func() {
					switch mode {
					case "deadline":
						f.access.clock.now = f.lease.Deadline().Add(time.Millisecond)
					case "revoked":
						f.connector.root.guard.deactivate()
					case "cancelled":
						cancel()
					case "removed-workspace":
						f.access.approval.Workspaces = nil
						f.access.PutApproval(f.access.approval)
					case "changed-root":
						f.access.approval.Workspaces[0].RootIdentity.Inode = "replacement"
						f.access.PutApproval(f.access.approval)
					}
				}
				switch stage {
				case "before":
					change()
				case "scratch":
					allocate := f.factory.scratch
					f.factory.scratch = func(ctx context.Context) (connectorShellScratch, error) {
						scratch, err := allocate(ctx)
						change()
						return scratch, err
					}
				case "prepare":
					f.beforePrepare = change
				}
				selected, observer, err := f.factory.selectShell(ctx, f.lease, shellFactoryRequest())
				if err == nil || selected != nil || observer != nil || f.native.spawns != 0 || f.native.journal.reserves != 0 {
					t.Fatal("stale authority reached caller")
				}
			})
		}
	}
}

func TestConnectorShellFactoryDoesNotReplaceMissingSupport(t *testing.T) {
	if f, err := newConnectorShellFactory(context.Background(), connectorShellConfig{}, &computerClockFixture{}); err == nil || f != nil {
		t.Fatal("missing support enabled Shell")
	}
	if scratch, err := newConnectorShellScratch(nil); err == nil || scratch.path != "" {
		t.Fatal("missing lifetime allocated scratch")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if scratch, err := newConnectorShellScratch(ctx); err == nil || scratch.path != "" {
		t.Fatal("cancelled lifetime allocated scratch")
	}
}
