package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	nativeprocess "github.com/legrch/farol/modules/computer/infra/process"
)

// Trusted boot input only. The release loader must authenticate support and
// attest the complete protected bundle before constructing this factory. Hash
// equality and native measurement cannot issue that release acceptance.
// Normal NativeRuntime startup supplies no factory until that loader is wired.
type connectorShellConfig struct {
	runtimeID, home string
	support         nativeprocess.RootScopedPlatformSupport
	watchdog        nativeprocess.WatchdogSelection
}

type connectorShellScratch struct {
	path     string
	identity authority.RootIdentity
}

type connectorShellFactory struct {
	config   connectorShellConfig
	lifetime context.Context
	clock    port.Clock
	scratch  func(context.Context) (connectorShellScratch, error)
	prepare  func(context.Context, nativeprocess.Command, nativeprocess.SeatbeltSelection, processsvc.Invocation) (processsvc.Selected, error)
}

func newConnectorShellFactory(ctx context.Context, config connectorShellConfig, clock port.Clock) (*connectorShellFactory, error) {
	if ctx == nil || ctx.Err() != nil || clock == nil || !validIngressID(config.runtimeID) || strings.Contains(config.runtimeID, "/") ||
		!validProfilePath(config.home) || config.support.ProtectedBundle == nil || config.support.Architecture != "arm64" ||
		config.watchdog.Executable != config.support.Watchdog || config.watchdog.SourceSHA256 != config.support.WatchdogSourceSHA256 ||
		len(config.watchdog.Source) == 0 || len(config.watchdog.Source) > 64*1024 || !utf8.Valid(config.watchdog.Source) {
		return nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
	}
	sourceHash := sha256.Sum256(config.watchdog.Source)
	if hex.EncodeToString(sourceHash[:]) != config.watchdog.SourceSHA256 {
		return nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
	}
	config.support.Imports = slices.Clone(config.support.Imports)
	config.support.Executables = slices.Clone(config.support.Executables)
	bundle := *config.support.ProtectedBundle
	config.support.ProtectedBundle = &bundle
	config.watchdog.Source = slices.Clone(config.watchdog.Source)
	if _, ok := connectorBash(config.support); !ok {
		return nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
	}
	strategy, err := nativeprocess.NewRootScopedPlatformStrategy(ctx, config.support, clock)
	if err != nil {
		return nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
	}
	f := &connectorShellFactory{config: config, lifetime: ctx, clock: clock, scratch: newConnectorShellScratch}
	f.prepare = func(ctx context.Context, command nativeprocess.Command, policy nativeprocess.SeatbeltSelection, invocation processsvc.Invocation) (processsvc.Selected, error) {
		preparer, err := nativeprocess.NewRootScopedSupervisedPreparer(config.runtimeID, command, policy, strategy, config.watchdog, f.lifetime, clock)
		if err != nil {
			return nil, err
		}
		return preparer.Prepare(ctx, invocation)
	}
	return f, nil
}

func connectorBash(support nativeprocess.RootScopedPlatformSupport) (nativeprocess.ExecutablePin, bool) {
	for _, pin := range support.Executables {
		if pin.Path == "/bin/bash" {
			return pin, true
		}
	}
	return nativeprocess.ExecutablePin{}, false
}

// selectShell consumes the SAME admitted lease. Native preparation happens
// outside snapshot callbacks and within its original deadline. It neither
// reserves nor dispatches; the existing connector process owner does both.
func (f *connectorShellFactory) selectShell(ctx context.Context, lease *execution.Lease, request connectorShellRequest) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
	refuse := func() (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
		return nil, nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
	}
	if f == nil || f.clock == nil || f.lifetime == nil || f.lifetime.Err() != nil || f.scratch == nil || f.prepare == nil ||
		ctx == nil || ctx.Err() != nil || lease == nil || !f.clock.Now().Before(lease.Deadline()) ||
		!validIngressID(request.WorkspaceID) || !shellRelativeCwd(request.RelativeCwd) || len(request.RelativeCwd) > 4096 ||
		len(request.Command) == 0 || len(request.Command) > 65536 || strings.ContainsRune(request.Command, 0) || !utf8.ValidString(request.Command) ||
		len(request.Stdin) > 262144 || !utf8.ValidString(request.Stdin) {
		return refuse()
	}
	preparation, cancel := context.WithDeadline(ctx, lease.Deadline())
	defer cancel()
	stopLifetime := context.AfterFunc(f.lifetime, cancel)
	defer stopLifetime()
	var snapshot port.AccessSnapshot
	var workspace authority.ApprovedWorkspace
	var cwd string
	err := lease.WithSnapshot(preparation, lease.Binding().ParticipantID, func(current port.AccessSnapshot) error {
		if current.Participant == nil || current.Approval == nil || current.Approval.FilePolicy != authority.RootScopedFiles ||
			current.Participant.Grant.FilePolicy != authority.RootScopedFiles {
			return connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
		}
		approved, ok := authority.FindApproved(*current.Approval, request.WorkspaceID)
		if !ok || !approved.ShellVerified || !validProfilePath(approved.Root) {
			return connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
		}
		cwd = filepath.Join(approved.Root, request.RelativeCwd)
		action := authority.Action{Identity: lease.Binding().Identity, Operation: authority.Operation{
			Kind: authority.Shell, WorkspaceID: request.WorkspaceID, Path: cwd, Write: request.Write}}
		if err := authority.AuthorizeComputer(*current.Participant, *current.Approval, action, f.clock.Now()); err != nil {
			return err
		}
		participant, approval := *current.Participant, current.Approval.Clone()
		participant.Grant = participant.Grant.Clone()
		snapshot = port.AccessSnapshot{Participant: &participant, Approval: &approval}
		workspace = approved
		return nil
	})
	if err != nil || snapshot.Participant == nil || !f.clock.Now().Before(lease.Deadline()) || preparation.Err() != nil {
		return refuse()
	}
	scratch, err := f.scratch(preparation)
	if err != nil || preparation.Err() != nil || !f.clock.Now().Before(lease.Deadline()) {
		return refuse()
	}
	bash, ok := connectorBash(f.config.support)
	if !ok {
		return refuse()
	}
	command := nativeprocess.Command{WorkspaceID: workspace.WorkspaceID, Root: workspace.Root, Cwd: cwd,
		RootIdentity: workspace.RootIdentity, Executable: bash.Path, ExecutableSHA256: bash.SHA256, Write: request.Write}
	policy := nativeprocess.SeatbeltSelection{FilePolicy: authority.RootScopedFiles, Snapshot: snapshot, RuntimeID: f.config.runtimeID,
		WorkspaceID: workspace.WorkspaceID, Home: f.config.home, Scratch: scratch.path, ScratchIdentity: scratch.identity,
		MechanismSHA256: f.config.support.Mechanism.SHA256, Executables: slices.Clone(f.config.support.Executables),
		ProtectedImages: []nativeprocess.ExecutablePin{f.config.support.Backend, f.config.support.Watchdog},
		ProtectedBundle: f.config.support.ProtectedBundle, Network: authority.NoNetwork, Git: nativeprocess.RootScopedGit}
	invocation := processsvc.Invocation{RuntimeID: f.config.runtimeID, SessionID: lease.Binding().SessionID, ModelID: "chatgpt",
		AdmissionID: snapshot.Participant.Grant.AuthorityID, Arguments: []string{"--noprofile", "--norc", "-c", request.Command}, Input: []byte(request.Stdin)}
	selected, err := f.prepare(preparation, command, policy, invocation)
	if err != nil || selected == nil || preparation.Err() != nil || !f.clock.Now().Before(lease.Deadline()) {
		return refuse()
	}
	bound, ok := selected.(processsvc.PolicyBound)
	if !ok {
		return refuse()
	}
	// Revalidate the original lease after all native yields. Start performs its
	// own later check and owns the only reservation and child lifetime.
	if err := lease.WithSnapshot(preparation, lease.Binding().ParticipantID, func(current port.AccessSnapshot) error {
		if !bound.MatchesPolicy(current) || !f.clock.Now().Before(lease.Deadline()) {
			return connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
		}
		return nil
	}); err != nil {
		return refuse()
	}
	seal := selected.Seal()
	if seal.WorkspaceID != command.WorkspaceID || seal.Root != command.Root || seal.Cwd != command.Cwd || seal.RootIdentity != command.RootIdentity || seal.Write != command.Write {
		return refuse()
	}
	observer, err := nativeprocess.NewObservationWorkspace(processsvc.ObservedWorkspace{
		WorkspaceID: seal.WorkspaceID, Root: seal.Root, RootIdentity: seal.RootIdentity})
	if err != nil {
		return refuse()
	}
	return selected, observer, nil
}
