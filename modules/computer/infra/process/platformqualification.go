package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

const (
	RootScopedPlatformAssurance  = "root-scoped-trusted-platform-v1"
	rootScopedPlatformCompiler   = "approved-roots-seatbelt-v1"
	rootScopedPlatformClass      = "local-apfs-no-nested-mounts-v1"
	rootScopedMountBoundaryClass = "system-apfs-kernel-mount-boundaries-v1"
	rootScopedPlatformTrust      = "protected-host-pathnames-v1"
)

// RootScopedPlatformSupport is trusted boot input from future authenticated
// build/release metadata. No loader, default support entry, observed-hash approval
// or public fact callback exists. Hashes identify qualified bytes; they are not
// kernel-installation evidence. Boot MUST authenticate their issuer separately.
// Classes are exact native macOS build/architecture and NoNetwork. The original
// class refuses nested mounts. The system APFS class seals known mount denials
// and continuously denies non-root mounts in the kernel. Host integrity and
// protected image parents remain assumptions.
type RootScopedPlatformSupport struct {
	ReleaseID, QualificationSHA256, CompilerSHA256                  string
	OS, OSBuild, Architecture, Compiler, FilesystemClass, HostTrust string
	Backend, Watchdog, Mechanism                                    ExecutablePin
	WatchdogSourceSHA256                                            string
	Imports                                                         []ExecutablePin
	Executables                                                     []ExecutablePin
	ProtectedBundle                                                 *ProtectedBundle `json:",omitempty"`
}

// PlatformStrategyBinding is value-only input to the original supervised
// reservation seal. Returning it alone does not dispatch or activate Shell.
type PlatformStrategyBinding struct {
	AssuranceID, SupportSHA256, SelectionSHA256 string
}

type platformFacts struct{ os, build, arch string }
type platformFileFacts struct {
	identity     authority.RootIdentity
	size         int64
	path, sha256 string
	mode         os.FileMode
	uid          uint32
	links        uint64
}
type platformDirectoryFacts struct {
	path, filesystem, mount string
	identity                authority.RootIdentity
	local, nested           bool
	// Sorted native mount names; control characters are forbidden in each name.
	mounts string
}

// Private native fact port returns measurements, never a permissive Qualify
// callback. Only in-package CPU tests inject it. Production uses the OS reader.
type platformFactPort interface {
	platform(context.Context) (platformFacts, error)
	effectiveUID() uint32
	backend(context.Context) (string, error)
	file(context.Context, string) (platformFileFacts, error)
	directory(context.Context, string) (platformDirectoryFacts, error)
}

type RootScopedPlatformStrategy struct{ frozen *platformSupport }
type platformSupport struct {
	descriptor RootScopedPlatformSupport
	digest     string
	facts      platformFactPort
	clock      port.Clock
	ownerUID   uint32
	files      []platformFileFacts
	bundle     *platformDirectoryFacts
}

func NewRootScopedPlatformStrategy(ctx context.Context, support RootScopedPlatformSupport, clock port.Clock) (*RootScopedPlatformStrategy, error) {
	return newRootScopedPlatformStrategy(ctx, support, clock, nativePlatformFacts{})
}

func newRootScopedPlatformStrategy(ctx context.Context, support RootScopedPlatformSupport, clock port.Clock, facts platformFactPort) (*RootScopedPlatformStrategy, error) {
	if !validPlatformSupport(support) || facts == nil || clock == nil {
		return nil, &processsvc.NativeFailure{}
	}
	support.Imports = slices.Clone(support.Imports)
	support.Executables = slices.Clone(support.Executables)
	support.ProtectedBundle = cloneProtectedBundle(support.ProtectedBundle)
	digest, err := platformDigest(support)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	s := &RootScopedPlatformStrategy{&platformSupport{descriptor: support, digest: digest, facts: facts, clock: clock, ownerUID: facts.effectiveUID()}}
	bundle, err := s.observeBundle(ctx)
	if err != nil {
		return nil, err
	}
	s.frozen.bundle = bundle
	observed, err := s.observe(ctx)
	if err != nil {
		return nil, err
	}
	s.frozen.files = observed
	if support.ProtectedBundle != nil && s.inspect(ctx) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	return s, nil
}

var platformBuildPattern = regexp.MustCompile(`^[0-9]{1,3}[A-Z][0-9]{1,6}[a-z]?$`)

func validPlatformSupport(s RootScopedPlatformSupport) bool {
	nonzero := func(v string) bool { return digestValue(v) && v != strings.Repeat("0", 64) }
	if !bindingID(s.ReleaseID) || !nonzero(s.QualificationSHA256) || !nonzero(s.CompilerSHA256) ||
		s.OS != "darwin" || !platformBuildPattern.MatchString(s.OSBuild) ||
		(s.Architecture != "arm64" && s.Architecture != "amd64") ||
		s.Compiler != rootScopedPlatformCompiler || (s.FilesystemClass != rootScopedPlatformClass && s.FilesystemClass != rootScopedMountBoundaryClass) || s.HostTrust != rootScopedPlatformTrust ||
		s.Mechanism.Path != seatbeltExecutable || !nonzero(s.WatchdogSourceSHA256) ||
		len(s.Imports) < 1 || len(s.Imports) > 16 || len(s.Executables) < 1 || len(s.Executables) > 16 {
		return false
	}
	if !validProtectedBundle(s.ProtectedBundle) {
		return false
	}
	if s.ProtectedBundle != nil {
		for _, pin := range []ExecutablePin{s.Backend, s.Watchdog} {
			if pin.Path == s.ProtectedBundle.Path || !insidePolicy(s.ProtectedBundle.Path, pin.Path) {
				return false
			}
		}
	}
	seen := map[string]string{}
	for _, pin := range platformPins(s) {
		previous, exists := seen[pin.Path]
		if !absolutePolicyPath(pin.Path) || !nonzero(pin.SHA256) || (exists && previous != pin.SHA256) {
			return false
		}
		seen[pin.Path] = pin.SHA256
	}
	dyld := ""
	for _, pin := range s.Imports {
		// This is an OS import closure attested by the release issuer. Name-only
		// search paths, user-provided policy directories and symlink aliases refuse.
		parent := filepath.Dir(pin.Path)
		if (parent != "/usr/share/sandbox" && parent != "/System/Library/Sandbox/Profiles") ||
			!strings.HasSuffix(filepath.Base(pin.Path), ".sb") {
			return false
		}
		if filepath.Base(pin.Path) == "dyld-support.sb" {
			if dyld != "" && dyld != pin.Path {
				return false
			}
			dyld = pin.Path
		}
	}
	return dyld != ""
}

func platformPins(s RootScopedPlatformSupport) []ExecutablePin {
	return slices.Concat([]ExecutablePin{s.Backend, s.Watchdog, s.Mechanism}, s.Imports, s.Executables)
}

func (s *RootScopedPlatformStrategy) Binding() PlatformStrategyBinding {
	if s == nil || s.frozen == nil {
		return PlatformStrategyBinding{}
	}
	return PlatformStrategyBinding{AssuranceID: RootScopedPlatformAssurance, SupportSHA256: s.frozen.digest}
}

func (s *RootScopedPlatformStrategy) observe(ctx context.Context) ([]platformFileFacts, error) {
	refuse := func() ([]platformFileFacts, error) { return nil, &processsvc.NativeFailure{} }
	if s == nil || s.frozen == nil || ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	f, d := s.frozen.facts, s.frozen.descriptor
	if f.effectiveUID() != s.frozen.ownerUID {
		return refuse()
	}
	actual, err := f.platform(ctx)
	if err != nil || actual != (platformFacts{d.OS, d.OSBuild, d.Architecture}) {
		return refuse()
	}
	backend, err := f.backend(ctx)
	if err != nil || backend != d.Backend.Path {
		return refuse()
	}
	pins := platformPins(d)
	observed := make([]platformFileFacts, 0, len(pins))
	for i, pin := range pins {
		if ctx.Err() != nil {
			return refuse()
		}
		actual, err := f.file(ctx, pin.Path)
		imported := i >= 3 && i < 3+len(d.Imports)
		system := imported || i == 2
		ownerAllowed := actual.uid == 0 || (!system && actual.uid == s.frozen.ownerUID)
		if err != nil || actual.path != pin.Path || actual.sha256 != pin.SHA256 ||
			!actual.mode.IsRegular() || actual.mode&os.ModeSymlink != 0 || !ownerAllowed ||
			actual.mode.Perm()&0022 != 0 || actual.links != 1 || actual.size <= 0 || actual.size > 128*1024*1024 ||
			actual.identity.Device == "" || actual.identity.Inode == "" || (!imported && actual.mode.Perm()&0111 == 0) {
			return refuse()
		}
		if d.ProtectedBundle != nil && i < 2 && actual.identity.Device != d.ProtectedBundle.Identity.Device {
			return refuse()
		}
		observed = append(observed, actual)
	}
	if ctx.Err() != nil {
		return refuse()
	}
	return observed, nil
}

// Observe only the directory binding; no dependency tree walk or byte attestation.
func (s *RootScopedPlatformStrategy) observeBundle(ctx context.Context) (*platformDirectoryFacts, error) {
	if s == nil || s.frozen == nil || ctx == nil || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	bundle := s.frozen.descriptor.ProtectedBundle
	if bundle == nil {
		return nil, nil
	}
	f, err := s.frozen.facts.directory(ctx, bundle.Path)
	if err != nil || f.path != bundle.Path || f.identity != bundle.Identity ||
		f.filesystem != "apfs" || !f.local || f.nested ||
		(f.mount != "/" && !absolutePolicyPath(f.mount)) || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	return &f, nil
}

func (s *RootScopedPlatformStrategy) inspect(ctx context.Context) error {
	if s == nil || s.frozen == nil || len(s.frozen.files) == 0 {
		return &processsvc.NativeFailure{}
	}
	observed, err := s.observe(ctx)
	bundle, bundleErr := s.observeBundle(ctx)
	bundleSame := bundle == nil && s.frozen.bundle == nil
	if bundle != nil && s.frozen.bundle != nil {
		bundleSame = *bundle == *s.frozen.bundle
	}
	if err != nil || !slices.Equal(observed, s.frozen.files) || bundleErr != nil || !bundleSame {
		return &processsvc.NativeFailure{}
	}
	return nil
}

type RootScopedPlatformSelection struct{ frozen *platformSelection }
type platformSelection struct {
	strategy          RootScopedPlatformStrategy
	policy            SeatbeltSelection
	original, wrapped Command
	binding           PlatformStrategyBinding
	deadline          platformOriginalDeadline
}

// This cell binds time only, not a dispatch, journal, authority store or cache.
// Copies of a selection share the FIRST supplied deadline, including refusal.
type platformOriginalDeadline struct {
	mutex sync.Mutex
	set   bool
	value time.Time
}

// Select requires the existing selected ORIGINAL command, already policy-bound.
// It never edits argv/env/input or chooses another image. Trusted composition owns
// the SAME authority snapshot, measurement, reservation and one-start lifecycle.
func (s *RootScopedPlatformStrategy) Select(ctx context.Context, policy SeatbeltSelection, original Command, watchdog WatchdogSelection) (*RootScopedPlatformSelection, error) {
	refuse := func() (*RootScopedPlatformSelection, error) { return nil, &processsvc.NativeFailure{} }
	if s == nil || s.frozen == nil || original.Binding == nil || original.Confinement == nil ||
		policy.FilePolicy != authority.RootScopedFiles || policy.Git != RootScopedGit || policy.Network != authority.NoNetwork ||
		!validSelection(policy) || !platformCommandText(original) {
		return refuse()
	}
	d := s.frozen.descriptor
	if !sameProtectedBundle(policy.ProtectedBundle, d.ProtectedBundle) || policy.MechanismSHA256 != d.Mechanism.SHA256 || !slices.Equal(policy.Executables, d.Executables) ||
		watchdog.Executable != d.Watchdog || watchdog.SourceSHA256 != d.WatchdogSourceSHA256 ||
		len(watchdog.Source) == 0 || len(watchdog.Source) > 64*1024 || !utf8.Valid(watchdog.Source) {
		return refuse()
	}
	for _, required := range []ExecutablePin{d.Backend, d.Watchdog} {
		if !slices.Contains(policy.Executables, required) && !slices.Contains(policy.ProtectedImages, required) {
			return refuse()
		}
	}
	source := sha256.Sum256(watchdog.Source)
	if hex.EncodeToString(source[:]) != d.WatchdogSourceSHA256 {
		return refuse()
	}
	p, a := policy.Snapshot.Participant.Clone(), policy.Snapshot.Approval.Clone()
	policy.Snapshot = port.AccessSnapshot{Participant: &p, Approval: &a}
	policy.Executables = slices.Clone(policy.Executables)
	policy.ProtectedImages = slices.Clone(policy.ProtectedImages)
	policy.ProtectedBundle = cloneProtectedBundle(policy.ProtectedBundle)
	policy.MountDenials = slices.Clone(policy.MountDenials)
	if !s.mountBoundariesCurrent(ctx, policy, original) {
		return refuse()
	}
	original = copyCommand(original)
	wrapped, err := platformWrappedCommand(policy, original)
	if err != nil {
		return refuse()
	}
	// Broad approved roots (including HOME) remain eligible. Backend/helper pins
	// above participate in compiler image/ancestor protection; mechanism/imports
	// additionally require protected system ownership. No implicit HOME ban.
	digest, err := platformDigest(struct {
		Support, Mode     string
		Original, Wrapped Command
		Selection         SeatbeltSelection
	}{s.frozen.digest, watchdogMode, original, wrapped, policy})
	if err != nil || s.inspect(ctx) != nil {
		return refuse()
	}
	binding := s.Binding()
	binding.SelectionSHA256 = digest
	selected := &RootScopedPlatformSelection{&platformSelection{strategy: *s, policy: policy, original: original, wrapped: wrapped, binding: binding}}
	// Reject unsupported roots during preparation, before the caller reserves an
	// execution. The original StartLease still repeats all native checks.
	if _, err := selected.frozen.inspectDirectories(ctx); err != nil {
		return nil, err
	}
	return selected, nil
}

func platformCommandText(c Command) bool {
	for _, value := range slices.Concat(c.Args, c.Environment) {
		if !utf8.ValidString(value) {
			return false
		}
	}
	return validCommand(c)
}

func platformWrappedCommand(policy SeatbeltSelection, original Command) (Command, error) {
	selected := &Seatbelt{selection: policy}
	bound, err := selected.bind(original)
	if err != nil || original.Confinement == nil || *original.Confinement != *bound.Confinement {
		return Command{}, &processsvc.NativeFailure{}
	}
	plan, err := compileSeatbelt(policy, original)
	if err != nil {
		return Command{}, err
	}
	wrapped := copyCommand(original)
	wrapped.Executable, wrapped.ExecutableSHA256 = seatbeltExecutable, policy.MechanismSHA256
	wrapped.Args = append(append(slices.Clone(plan.arguments), original.Executable), original.Args...)
	if !platformCommandText(wrapped) {
		return Command{}, &processsvc.NativeFailure{}
	}
	return wrapped, nil
}

func (s *RootScopedPlatformSelection) Binding() PlatformStrategyBinding {
	if s == nil || s.frozen == nil {
		return PlatformStrategyBinding{}
	}
	return s.frozen.binding
}
func (s *RootScopedPlatformSelection) WrappedCommand() Command {
	if s == nil || s.frozen == nil {
		return Command{}
	}
	return copyCommand(s.frozen.wrapped)
}

// BindInvocation is called inside the ORIGINAL Spawn/StartLease. It is read-only
// support/class inspection, not a child certificate or a release. Rebinding with
// a different deadline refuses, including after copying or a failed inspection.
func (s *RootScopedPlatformSelection) BindInvocation(ctx context.Context, original, wrapped Command, deadline time.Time) (*RootScopedPlatformQualification, error) {
	refuse := func() (*RootScopedPlatformQualification, error) { return nil, &processsvc.NativeFailure{} }
	if s == nil || s.frozen == nil {
		return refuse()
	}
	f := s.frozen
	f.deadline.mutex.Lock()
	if !f.deadline.set {
		f.deadline.set, f.deadline.value = true, deadline
	}
	sameTime := f.deadline.value.Equal(deadline)
	f.deadline.mutex.Unlock()
	if !sameTime || !f.current(ctx, deadline) || !samePlatformCommand(original, f.original) || !samePlatformCommand(wrapped, f.wrapped) ||
		f.strategy.inspect(ctx) != nil {
		return refuse()
	}
	directories, err := f.inspectDirectories(ctx)
	if err != nil || !f.current(ctx, deadline) {
		return refuse()
	}
	digest, err := platformDigest(struct {
		Binding     PlatformStrategyBinding
		Deadline    time.Time
		Directories []platformDirectoryBinding
	}{f.binding, deadline, directories})
	if err != nil {
		return refuse()
	}
	return &RootScopedPlatformQualification{&platformInvocation{f, deadline, directories, digest}}, nil
}

func (s *platformSelection) current(ctx context.Context, deadline time.Time) bool {
	if ctx == nil || ctx.Err() != nil || deadline.IsZero() {
		return false
	}
	now := s.strategy.frozen.clock.Now()
	return now.Before(deadline) && !deadline.After(now.Add(authority.ProcessExecutionLifetime))
}

type platformDirectoryBinding struct {
	Path, Mount string
	Mounts      string `json:",omitempty"`
	Identity    authority.RootIdentity
}

func (s *platformSelection) inspectDirectories(ctx context.Context) ([]platformDirectoryBinding, error) {
	refuse := func() ([]platformDirectoryBinding, error) { return nil, &processsvc.NativeFailure{} }
	plan, err := compileSeatbelt(s.policy, s.original)
	if err != nil || !s.strategy.mountBoundariesCurrent(ctx, s.policy, s.original) {
		return refuse()
	}
	type directory struct {
		path     string
		identity authority.RootIdentity
		device   string
	}
	directories := []directory{{s.original.Root, s.original.RootIdentity, s.original.RootIdentity.Device},
		{s.original.Cwd, authority.RootIdentity{}, s.original.RootIdentity.Device},
		{s.policy.Scratch, s.policy.ScratchIdentity, s.policy.ScratchIdentity.Device}}
	if s.policy.ProtectedBundle != nil {
		bundle := s.policy.ProtectedBundle
		directories = append(directories, directory{bundle.Path, bundle.Identity, bundle.Identity.Device})
	}
	for _, root := range plan.roots {
		directories = append(directories, directory{root.ApprovedRoot, root.RootIdentity, root.RootIdentity.Device},
			directory{root.ScopeRoot, authority.RootIdentity{}, root.RootIdentity.Device})
	}
	out := make([]platformDirectoryBinding, 0, len(directories))
	for _, d := range directories {
		if ctx == nil || ctx.Err() != nil {
			return refuse()
		}
		f, err := s.strategy.frozen.facts.directory(ctx, d.path)
		if err == nil && f.path == d.path && (f.filesystem != "apfs" || !f.local || (s.policy.RootVolumeOnly && f.mount != "/" && f.mount != dataVolumePath) || (f.nested && !s.strategy.deniedMountFacts(f, s.policy.MountDenials))) {
			return nil, &processsvc.NativeFailure{FilesystemUnsupported: true}
		}
		if err != nil || f.path != d.path ||
			(f.mount != "/" && !absolutePolicyPath(f.mount)) ||
			f.identity.Device != d.device || f.identity.Inode == "" || (d.identity != (authority.RootIdentity{}) && f.identity != d.identity) {
			return refuse()
		}
		out = append(out, platformDirectoryBinding{d.path, f.mount, f.mounts, f.identity})
	}
	return out, nil
}

type RootScopedPlatformQualification struct{ frozen *platformInvocation }
type platformInvocation struct {
	selected    *platformSelection
	deadline    time.Time
	directories []platformDirectoryBinding
	digest      string
}

func (q *RootScopedPlatformQualification) InvocationSHA256() string {
	if q == nil || q.frozen == nil {
		return ""
	}
	return q.frozen.digest
}

// Qualify declares supported OS enforcement PLUS per-invocation measured binding.
// It cannot prove policy installation from compilation/ready, revoke descendants,
// renew a lease, run a probe or dispatch. The supervised boundary also rechecks
// retained launch measurements and current authority before its one release.
func (q *RootScopedPlatformQualification) Qualify(ctx context.Context, wrapped Command) error {
	if q == nil || q.frozen == nil {
		return &processsvc.NativeFailure{}
	}
	f := q.frozen
	return q.ValidateBound(ctx, f.selected.original, wrapped, f.deadline)
}

// ValidateBound checks the caller's SAME original, exact wrapper and original
// deadline. It never silently reinterprets a wrapped command as the original.
func (q *RootScopedPlatformQualification) ValidateBound(ctx context.Context, original, wrapped Command, deadline time.Time) error {
	refuse := func() error { return &processsvc.NativeFailure{} }
	if q == nil || q.frozen == nil {
		return refuse()
	}
	f, s := q.frozen, q.frozen.selected
	if !deadline.Equal(f.deadline) || !s.current(ctx, f.deadline) || !samePlatformCommand(original, s.original) ||
		!samePlatformCommand(wrapped, s.wrapped) {
		return refuse()
	}
	generated, err := platformWrappedCommand(s.policy, s.original)
	if err != nil || !samePlatformCommand(generated, wrapped) || s.strategy.inspect(ctx) != nil {
		return refuse()
	}
	directories, err := s.inspectDirectories(ctx)
	if err != nil || !slices.Equal(directories, f.directories) || !s.current(ctx, f.deadline) {
		return refuse()
	}
	return nil
}

func samePlatformCommand(a, b Command) bool {
	if !platformCommandText(a) || !platformCommandText(b) {
		return false
	}
	left, e1 := nativeCommandDigest(a)
	right, e2 := nativeCommandDigest(b)
	return e1 == nil && e2 == nil && left == right
}
func platformDigest(v any) (string, error) {
	bytes, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:]), nil
}

var _ Qualification = (*RootScopedPlatformQualification)(nil)
