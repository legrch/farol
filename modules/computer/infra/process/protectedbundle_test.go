package process

import (
	"context"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// All facts, retained handles and watchdog IPC in this file are CPU doubles.
// Nothing launches a child or claims native filesystem/kernel qualification.
func bundleFixtureCPU(t *testing.T) platformFixture {
	t.Helper()
	f := platformFixtureCPU(t)
	bundle := ProtectedBundle{"/Users/owner/Applications/Farol.app", authority.RootIdentity{Device: "1", Inode: "42"}}
	// Match the accepted package placement while retaining explicit fake facts.
	backendFacts := f.facts.files[f.descriptor.Backend.Path]
	watchdogFacts := f.facts.files[f.descriptor.Watchdog.Path]
	f.descriptor.Backend.Path = bundle.Path + "/Contents/Resources/app/farol-backend"
	f.descriptor.Watchdog.Path = bundle.Path + "/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron"
	backendFacts.path, watchdogFacts.path = f.descriptor.Backend.Path, f.descriptor.Watchdog.Path
	f.facts.files[backendFacts.path], f.facts.files[watchdogFacts.path] = backendFacts, watchdogFacts
	f.facts.backendPath = backendFacts.path
	f.watchdog.Executable = f.descriptor.Watchdog
	f.policy.ProtectedImages = []ExecutablePin{f.descriptor.Backend, f.descriptor.Watchdog}
	f.descriptor.ProtectedBundle = cloneProtectedBundle(&bundle)
	f.policy.ProtectedBundle = cloneProtectedBundle(&bundle)
	f.facts.directories[bundle.Path] = platformDirectoryFacts{bundle.Path, "apfs", dataVolumePath, bundle.Identity, true, false, ""}
	f.original.Confinement = nil
	bound, err := (&Seatbelt{selection: f.policy}).bind(f.original)
	if err != nil {
		t.Fatal(err)
	}
	f.original = bound
	return f
}

func TestProtectedBundleCompilerProtectsResourcesAndAllAncestorsWithoutGrants(t *testing.T) {
	for _, outside := range []bool{false, true} {
		s, c := rootScopedFixture(t)
		root := "/Users/owner"
		s.Home = root
		s.Snapshot.Participant.Grant.Workspaces[0].Root = root
		s.Snapshot.Approval.Workspaces[0].Root = root
		c.Root, c.Cwd, c.Write = root, root, true
		bundlePath := root + "/Applications/Farol.app"
		if outside {
			bundlePath = dataVolumePath + bundlePath
		}
		environment := seatbeltEnvironment(s, true)
		s.ProtectedBundle = &ProtectedBundle{bundlePath, authority.RootIdentity{Device: "1", Inode: "42"}}
		c.Environment = seatbeltEnvironment(s, true)
		plan, err := compileSeatbelt(s, c)
		if err != nil {
			t.Fatal(err)
		}
		if !hasParameterRule(plan, "deny file-write*", "literal", bundlePath) ||
			!hasParameterRule(plan, "deny file-write*", "subpath", bundlePath) ||
			!hasParameterRule(plan, "allow file-write*", "subpath", root) {
			t.Fatal("missing bundle resource/root protection or ordinary HOME writes")
		}
		// Every ancestor is protected even across textual APFS workspace aliases.
		for ancestor := bundlePath[:strings.LastIndex(bundlePath, "/")]; ancestor != ""; ancestor = ancestor[:strings.LastIndex(ancestor, "/")] {
			if !hasParameterRule(plan, "deny file-write-unlink", "literal", ancestor) {
				t.Fatal("unprotected ancestor", ancestor)
			}
			if hasParameterRule(plan, "deny file-write*", "subpath", ancestor) {
				t.Fatal("ancestor denial consumes sibling writes", ancestor)
			}
		}
		for _, operation := range []string{"allow file-read*", "allow process-exec"} {
			for _, selector := range []string{"literal", "subpath"} {
				if hasParameterRule(plan, operation, selector, bundlePath) {
					t.Fatal("protection added access", operation)
				}
			}
		}
		if !slices.Equal(environment, seatbeltEnvironment(s, true)) {
			t.Fatal("protection changed PATH/environment")
		}
	}
}

func TestProtectedBundleRejectsInvalidSelectionsAndSupport(t *testing.T) {
	changes := map[string]func(*ProtectedBundle){
		"root":                  func(b *ProtectedBundle) { b.Path = "/" },
		"relative":              func(b *ProtectedBundle) { b.Path = "Farol.app" },
		"unclean":               func(b *ProtectedBundle) { b.Path += "/../Farol.app" },
		"control":               func(b *ProtectedBundle) { b.Path += "\n" },
		"empty-device":          func(b *ProtectedBundle) { b.Identity.Device = "" },
		"invalid-device":        func(b *ProtectedBundle) { b.Identity.Device = "+1" },
		"overflow":              func(b *ProtectedBundle) { b.Identity.Inode = "18446744073709551616" },
		"zero-inode":            func(b *ProtectedBundle) { b.Identity.Inode = "0" },
		"noncanonical-identity": func(b *ProtectedBundle) { b.Identity.Inode = "042" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := bundleFixtureCPU(t)
			change(f.policy.ProtectedBundle)
			if _, err := NewSeatbelt(f.policy, &confinementEvidenceDouble{}); err == nil {
				t.Fatal("invalid selection accepted")
			}
			change(f.descriptor.ProtectedBundle)
			if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
				t.Fatal("invalid support accepted")
			}
			if f.facts.reads != 0 {
				t.Fatal("invalid support reached native facts")
			}
		})
	}
	for _, path := range []string{"/private/tmp", "/private/tmp/farol-fixture-operation", "/private/tmp/farol-fixture-operation/app", "/PRIVATE/tmp/Farol-fixture-operation/app"} {
		s, _ := rootScopedFixture(t)
		s.ProtectedBundle = &ProtectedBundle{path, authority.RootIdentity{Device: "1", Inode: "42"}}
		if validSelection(s) {
			t.Fatal("scratch overlap accepted", path)
		}
	}
	f := bundleFixtureCPU(t)
	f.policy.FilePolicy = authority.LegacyProtectedFiles
	f.policy.Snapshot.Participant.Grant.FilePolicy = authority.LegacyProtectedFiles
	f.policy.Snapshot.Approval.FilePolicy = authority.LegacyProtectedFiles
	f.policy.Git = DenyGit
	f.policy.ProtectedImages = nil
	if validSelection(f.policy) {
		t.Fatal("legacy bundle selection accepted")
	}
	for _, which := range []string{"backend", "watchdog"} {
		f := bundleFixtureCPU(t)
		if which == "backend" {
			f.descriptor.Backend.Path = f.descriptor.ProtectedBundle.Path + "-sibling/backend"
		} else {
			f.descriptor.Watchdog.Path = f.descriptor.ProtectedBundle.Path
		}
		if validPlatformSupport(f.descriptor) {
			t.Fatal("component outside bundle accepted", which)
		}
	}
}

func TestProtectedBundleFrozenAndIncludedInPolicyReservationAndSupport(t *testing.T) {
	f := bundleFixtureCPU(t)
	expected := *f.policy.ProtectedBundle
	seatbelt, err := NewSeatbelt(f.policy, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := New(f.original, seatbelt, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	strategy := f.strategy(t)
	selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	f.policy.ProtectedBundle.Path = "/caller-mutation"
	f.descriptor.ProtectedBundle.Identity.Inode = "99"
	if *seatbelt.selection.ProtectedBundle != expected || *strategy.frozen.descriptor.ProtectedBundle != expected || *selected.frozen.policy.ProtectedBundle != expected {
		t.Fatal("constructor retained caller pointer")
	}
	launch, err := selectedLaunch(seatbelt, f.original)
	if err != nil || *launch.protectedBundle != expected {
		t.Fatal("bundle absent from launch", err)
	}
	launch.protectedBundle.Path = "/launch-mutation"
	again, err := selectedLaunch(seatbelt, f.original)
	if err != nil || *again.protectedBundle != expected {
		t.Fatal("launch aliases frozen policy", err)
	}
	for _, mode := range []string{"path", "device", "inode", "nil"} {
		t.Run(mode, func(t *testing.T) {
			next := bundleFixtureCPU(t)
			switch mode {
			case "path":
				next.policy.ProtectedBundle.Path += "-next"
			case "device":
				next.policy.ProtectedBundle.Identity.Device = "2"
			case "inode":
				next.policy.ProtectedBundle.Identity.Inode = "43"
			case "nil":
				next.policy.ProtectedBundle = nil
			}
			next.original.Confinement = nil
			policy, err := NewSeatbelt(next.policy, &confinementEvidenceDouble{})
			if err != nil {
				t.Fatal(err)
			}
			changed, err := New(next.original, policy, next.clock)
			if err != nil || changed.Seal().Digest == prepared.Seal().Digest {
				t.Fatal("bundle not in reservation seal", err)
			}
			if _, err := selectedLaunch(policy, f.original); err == nil {
				t.Fatal("old confinement rebound")
			}
			before, err := platformDigest(strategy.frozen.descriptor)
			if err != nil {
				t.Fatal(err)
			}
			descriptor := strategy.frozen.descriptor
			descriptor.ProtectedBundle = cloneProtectedBundle(next.policy.ProtectedBundle)
			after, err := platformDigest(descriptor)
			if err != nil || before == after {
				t.Fatal("bundle not in support seal", err)
			}
		})
	}
	// Nil remains the existing individually pinned class and selection shape.
	legacy := platformFixtureCPU(t)
	strategyNil := legacy.strategy(t)
	if _, err := strategyNil.Select(context.Background(), legacy.policy, legacy.original, legacy.watchdog); err != nil {
		t.Fatal("nil class lost", err)
	}
}

func TestProtectedBundlePlatformRejectsCrossedBindingsAndPhysicalDrift(t *testing.T) {
	for _, mode := range []string{"missing-policy", "missing-support", "crossed-inode", "crossed-path", "pins-missing"} {
		t.Run(mode, func(t *testing.T) {
			f := bundleFixtureCPU(t)
			if mode == "missing-support" {
				f.descriptor.ProtectedBundle = nil
			}
			strategy := f.strategy(t)
			switch mode {
			case "missing-policy":
				f.policy.ProtectedBundle = nil
			case "crossed-inode":
				f.policy.ProtectedBundle.Identity.Inode = "43"
			case "crossed-path":
				f.policy.ProtectedBundle.Path += "-other"
			case "pins-missing":
				f.policy.ProtectedImages = nil
			}
			if selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog); err == nil || selected != nil {
				t.Fatal("crossed protection accepted")
			}
		})
	}
	changes := map[string]func(*platformDirectoryFacts){
		"alias":         func(d *platformDirectoryFacts) { d.path = dataVolumePath + d.path },
		"identity":      func(d *platformDirectoryFacts) { d.identity.Inode = "43" },
		"device":        func(d *platformDirectoryFacts) { d.identity.Device = "2" },
		"filesystem":    func(d *platformDirectoryFacts) { d.filesystem = "hfs" },
		"remote":        func(d *platformDirectoryFacts) { d.local = false },
		"nested-mount":  func(d *platformDirectoryFacts) { d.nested = true },
		"invalid-mount": func(d *platformDirectoryFacts) { d.mount = "relative" },
		"mount-drift":   func(d *platformDirectoryFacts) { d.mount = "/Volumes/Other" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := bundleFixtureCPU(t)
			selected, q, deadline := f.qualify(t)
			path := f.policy.ProtectedBundle.Path
			d := f.facts.directories[path]
			change(&d)
			f.facts.directories[path] = d
			if q.ValidateBound(context.Background(), f.original, selected.WrappedCommand(), deadline) == nil {
				t.Fatal("bundle drift accepted before release")
			}
			if name != "mount-drift" {
				if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
					t.Fatal("unsupported bundle facts accepted at construction")
				}
			}
		})
	}
	f := bundleFixtureCPU(t)
	value := f.facts.files[f.descriptor.Watchdog.Path]
	value.identity.Device = "2"
	f.facts.files[f.descriptor.Watchdog.Path] = value
	if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
		t.Fatal("bundle component on another device accepted")
	}
}

func TestProtectedBundleRetainedHandlesRefuseDriftAndCloseExactlyOnce(t *testing.T) {
	for _, mode := range []string{"current", "identity", "alias", "owner", "trusted-owner-drift", "mode", "safe-mode-drift", "partial", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			_, command, launch, fs := rootMeasurementFixture(t)
			bundle := ProtectedBundle{"/bundle/Farol.app", authority.RootIdentity{Device: "1", Inode: "42"}}
			launch.protectedBundle = &bundle
			fs.directories[bundle.Path] = directoryFacts{bundle.Identity, os.ModeDir | 0755, 501}
			if mode == "partial" {
				fs.directoryError = bundle.Path
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			measurement, err := retainLaunchFiles(ctx, command, launch, fs)
			if mode == "partial" {
				if err == nil || measurement != nil {
					t.Fatal("partial capture retained")
				}
				fs.assertCloses(t, 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			absolute, anchored := slices.Clone(fs.absolute), slices.Clone(fs.anchored)
			// Recheck must use the captured value, never a caller's replacement binding.
			launch.protectedBundle = &ProtectedBundle{"/changed", authority.RootIdentity{Device: "3", Inode: "8"}}
			d := fs.directories[bundle.Path]
			switch mode {
			case "identity":
				d.identity.Inode = "43"
			case "alias":
				fs.alias = bundle.Path
			case "owner":
				d.uid = 502
			case "trusted-owner-drift":
				d.uid = 0
			case "mode":
				d.mode = os.ModeDir | 0775
			case "safe-mode-drift":
				d.mode = os.ModeDir | 0700
			case "cancelled":
				cancel()
			}
			fs.directories[bundle.Path] = d
			err = measurement.Recheck(context.Background())
			if (err == nil) != (mode == "current") {
				t.Fatal("incorrect retained result", mode, err)
			}
			if !slices.Equal(absolute, fs.absolute) || !slices.Equal(anchored, fs.anchored) {
				t.Fatal("recheck reopened paths")
			}
			measurement.Close()
			measurement.Close()
			fs.assertCloses(t, 1)
			if measurement.Recheck(context.Background()) == nil {
				t.Fatal("consumed measurement resurrected")
			}
		})
	}
}

func TestProtectedBundleUsesExistingWatchdogReservationAndRelease(t *testing.T) {
	for _, phase := range []string{"current", "platform-before-release", "retained-before-release"} {
		t.Run(phase, func(t *testing.T) {
			f := newWatchdogFixture(t)
			pf := bundleFixtureCPU(t)
			pf.clock.value = f.clock.Now()
			pf.policy.Snapshot.Participant.Grant.Identity = f.lease.binding.Identity
			pf.policy.Snapshot.Participant.Grant.ExpiresAt = f.lease.snapshot.Participant.Grant.ExpiresAt
			pf.policy.Snapshot.Approval.ExpiresAt = f.lease.snapshot.Approval.ExpiresAt
			f.lease.snapshot = pf.policy.Snapshot
			template := copyCommand(pf.original)
			template.Binding, template.Confinement = nil, nil
			template.Args, template.Input = nil, nil
			preparer, err := NewRootScopedSupervisedPreparer("cli", template, pf.policy, pf.strategy(t), pf.watchdog, context.Background(), f.clock)
			if err != nil {
				t.Fatal(err)
			}
			preparer.boundary.host = f.host
			_, _, _, fs := rootMeasurementFixture(t)
			bundle := *pf.policy.ProtectedBundle
			fs.directories[bundle.Path] = directoryFacts{bundle.Identity, os.ModeDir | 0755, 501}
			preparer.boundary.measure = func(ctx context.Context, command Command, launch *confinedLaunch) (launchMeasurement, error) {
				f.measurements.Add(1)
				return retainLaunchFiles(ctx, command, launch, fs)
			}
			f.preparer = preparer
			service, err := processsvc.NewForInvocation("operation", f.lease, preparer, f.reservation, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			f.route, err = processcontract.New(service)
			if err != nil {
				t.Fatal(err)
			}
			f.prepare(t)
			if phase != "current" {
				f.host.beforePrepared = func() {
					if phase == "platform-before-release" {
						d := pf.facts.directories[bundle.Path]
						d.identity.Inode = "43"
						pf.facts.directories[d.path] = d
					} else {
						d := fs.directories[bundle.Path]
						d.identity.Inode = "43"
						fs.directories[bundle.Path] = d
					}
				}
			}
			started, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if f.reservation.calls != 1 || f.measurements.Load() != 1 || f.host.calls.Load() != 1 {
				t.Fatal("existing owners duplicated")
			}
			fs.assertCloses(t, 1)
			if phase != "current" {
				if err == nil || f.host.starts.Load() != 0 {
					t.Fatal("drift released command")
				}
				f.settle(t)
				_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
				if err == nil || f.host.calls.Load() != 1 || f.reservation.calls != 1 {
					t.Fatal("refusal replayed")
				}
				return
			}
			if err != nil || started == nil || f.host.starts.Load() != 1 {
				t.Fatal("unchanged bundle refused", err)
			}
			prepare, release := <-f.host.frames, <-f.host.frames
			if prepare["deadlineAt"] != float64(f.lease.deadline.UnixMilli()) || release["type"] != "start" {
				t.Fatal("deadline/release changed")
			}
			f.emit(t, map[string]any{"type": "close", "id": prepare["id"], "code": 0, "signal": nil})
			f.settle(t)
			again, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err != nil || again.Handle != started.Handle || f.host.starts.Load() != 1 {
				t.Fatal("retained outcome redispatched", err)
			}
		})
	}
}

func TestProtectedBundleSelectionDigestAndOriginalDeadline(t *testing.T) {
	f := bundleFixtureCPU(t)
	selected, q, deadline := f.qualify(t)
	next := bundleFixtureCPU(t)
	next.descriptor.ProtectedBundle.Identity.Inode = "43"
	next.policy.ProtectedBundle.Identity.Inode = "43"
	d := next.facts.directories[next.policy.ProtectedBundle.Path]
	d.identity.Inode = "43"
	next.facts.directories[d.path] = d
	next.original.Confinement = nil
	var err error
	next.original, err = (&Seatbelt{selection: next.policy}).bind(next.original)
	if err != nil {
		t.Fatal(err)
	}
	other := next.selectCommand(t)
	if other.Binding().SupportSHA256 == selected.Binding().SupportSHA256 || other.Binding().SelectionSHA256 == selected.Binding().SelectionSHA256 {
		t.Fatal("binding omitted from strategy/selection digest")
	}
	if _, err := selected.BindInvocation(context.Background(), f.original, selected.WrappedCommand(), deadline.Add(time.Second)); err == nil {
		t.Fatal("deadline extended")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if q.Qualify(cancelled, selected.WrappedCommand()) == nil {
		t.Fatal("cancelled qualification accepted")
	}
}

// The no-bundle root-scoped class includes ordinary-Git config metadata and
// the exact uname reads. Nil bundle and disabled mount-boundary fields stay omitted.
// Unapproved user Git config now selects /dev/null and scratch XDG config. This
// intentionally changes the invocation/selection digest, not the profile or
// support digests. The frozen selection below includes that narrower environment.
func TestProtectedBundleNilPreservesFrozenBaselineDigests(t *testing.T) {
	f := platformFixtureCPU(t)
	if f.policy.UserGitSettings || !slices.Contains(f.original.Environment, "GIT_CONFIG_GLOBAL=/dev/null") ||
		!slices.Contains(f.original.Environment, "XDG_CONFIG_HOME="+f.policy.Scratch) {
		t.Fatal("frozen unapproved selection omitted the explicit config restriction")
	}
	strategy := f.strategy(t)
	selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(f.policy, f.original)
	if err != nil {
		t.Fatal(err)
	}
	if plan.digest != "3aee32564e93dfe3948599bf93a5cf7ce105f9622a5111e02a238f8b15c55e9a" ||
		strategy.Binding().SupportSHA256 != "d4fedcdb8be2faef765b57e849add5738d2e6299b462634ef1d4d4ea2169e84b" ||
		selected.Binding().SelectionSHA256 != "684537ecc4ae70c14274fccb7e501c2e3ef32e2d33d9242b8744407788ed3794" {
		t.Fatalf("nil bundle altered frozen baseline digests: profile=%s support=%s selection=%s", plan.digest, strategy.Binding().SupportSHA256, selected.Binding().SelectionSHA256)
	}
}
