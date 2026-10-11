package process

import (
	"context"
	"io"
	"os"
	"path/filepath"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Internal doubles exercise the native measurement sequence without IO/launch.
// These ports neither select nor grant authority.
type directoryFacts struct {
	identity authority.RootIdentity
	mode     os.FileMode
	uid      int
}
type directoryPin interface {
	io.Closer
	inspect(namedPath string) (directoryFacts, error)
	openDirectory(relativePath string) (directoryPin, error)
}
type executableMeasurement interface {
	io.Closer
	recheck(context.Context) error
}
type launchFilesystem interface {
	resolve(string) (string, error)
	openDirectory(string) (directoryPin, error)
	pinExecutable(context.Context, ExecutablePin) (executableMeasurement, error)
	effectiveUID() int
}

// launchMeasurement is owned serially by the original dispatch attempt.
type launchMeasurement interface {
	Recheck(context.Context) error
	Close()
}

func measureRetainedLaunch(ctx context.Context, command Command, launch *confinedLaunch) (launchMeasurement, error) {
	measurement, err := retainLaunch(ctx, command, launch)
	if err != nil {
		return nil, err
	}
	return measurement, nil
}

// retainedLaunchMeasurement is invocation-owned and used serially. Its observations
// grant no lease authority and are snapshots, not continuous kernel proof. Recheck
// never opens replacements; any failure consumes and closes this measurement.
type retainedLaunchMeasurement struct {
	context     context.Context
	fs          launchFilesystem
	pins        []io.Closer
	executables []executableMeasurement
	directories []directoryCheck
	closed      bool
}
type directoryCheck struct {
	pin      directoryPin
	path     string
	identity authority.RootIdentity
	private  bool
}

func (m *retainedLaunchMeasurement) Close() {
	if m == nil || m.closed {
		return
	}
	m.closed = true
	for i := len(m.pins) - 1; i >= 0; i-- {
		_ = m.pins[i].Close()
	}
}
func (m *retainedLaunchMeasurement) checkDirectory(ctx context.Context, c directoryCheck) bool {
	if ctx.Err() != nil || m.context.Err() != nil {
		return false
	}
	resolved, err := m.fs.resolve(c.path)
	if err != nil || resolved != c.path {
		return false
	}
	facts, err := c.pin.inspect(c.path)
	return err == nil && ctx.Err() == nil && m.context.Err() == nil &&
		facts.mode.IsDir() && facts.mode&os.ModeSymlink == 0 &&
		facts.identity == c.identity && c.identity.Device != "" && c.identity.Inode != "" &&
		(!c.private || (facts.mode.Perm() == 0700 && facts.uid == m.fs.effectiveUID()))
}
func (m *retainedLaunchMeasurement) Recheck(ctx context.Context) error {
	refuse := func() error { m.Close(); return &processsvc.NativeFailure{} }
	if m == nil || m.closed || ctx == nil || ctx.Err() != nil || m.context == nil || m.context.Err() != nil {
		return refuse()
	}
	// A new caller context cannot renew the original measurement lifetime.
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(m.context, cancel)
	defer stop()
	defer cancel()
	for _, pin := range m.executables {
		if bounded.Err() != nil || m.context.Err() != nil || pin.recheck(bounded) != nil {
			return refuse()
		}
	}
	for _, c := range m.directories {
		if !m.checkDirectory(bounded, c) {
			return refuse()
		}
	}
	if bounded.Err() != nil || m.context.Err() != nil {
		return refuse()
	}
	return nil
}

// Compatibility for the existing dispatch callers: retain exactly the same
// lifetime without adding a release join or changing authority checks.
func measureLaunchFiles(ctx context.Context, command Command, launch *confinedLaunch, fs launchFilesystem) (func(), error) {
	measurement, err := retainLaunchFiles(ctx, command, launch, fs)
	if err != nil {
		return nil, err
	}
	return measurement.Close, nil
}

func retainLaunchFiles(ctx context.Context, command Command, launch *confinedLaunch, fs launchFilesystem) (*retainedLaunchMeasurement, error) {
	refuse := func() (*retainedLaunchMeasurement, error) { return nil, &processsvc.NativeFailure{} }
	if ctx == nil || ctx.Err() != nil || launch == nil || fs == nil {
		return refuse()
	}
	measurement := &retainedLaunchMeasurement{context: ctx, fs: fs}
	retained := false
	defer func() {
		if !retained {
			measurement.Close()
		}
	}()
	// Include partial handles even on error so every failure releases them.
	for _, executable := range launch.pins {
		if ctx.Err() != nil {
			return refuse()
		}
		pin, err := fs.pinExecutable(ctx, executable)
		if pin != nil {
			measurement.pins = append(measurement.pins, pin)
		}
		if err != nil || pin == nil {
			return refuse()
		}
		measurement.executables = append(measurement.executables, pin)
	}
	add := func(path string, identity authority.RootIdentity, private bool, parent directoryPin, relative string) directoryPin {
		if ctx.Err() != nil || !absolutePolicyPath(path) {
			return nil
		}
		var pin directoryPin
		var err error
		if parent == nil {
			pin, err = fs.openDirectory(path)
		} else {
			pin, err = parent.openDirectory(relative)
		}
		if pin != nil {
			measurement.pins = append(measurement.pins, pin)
		}
		if err != nil || pin == nil {
			return nil
		}
		// Subdirectories have no separately approved identity: capture their
		// descriptor identity from the measured approved ancestor.
		if identity == (authority.RootIdentity{}) {
			facts, inspectErr := pin.inspect(path)
			if inspectErr != nil {
				return nil
			}
			identity = facts.identity
		}
		c := directoryCheck{pin, path, identity, private}
		if !measurement.checkDirectory(ctx, c) {
			return nil
		}
		measurement.directories = append(measurement.directories, c)
		return pin
	}
	if command.RootIdentity.Device == "" || command.RootIdentity.Inode == "" || launch.scratchIdentity.Device == "" || launch.scratchIdentity.Inode == "" {
		return refuse()
	}
	root := add(command.Root, command.RootIdentity, false, nil, "")
	if root == nil || !insidePolicy(command.Root, command.Cwd) {
		return refuse()
	}
	relative, err := filepath.Rel(command.Root, command.Cwd)
	if err != nil || add(command.Cwd, authority.RootIdentity{}, false, root, relative) == nil ||
		add(launch.scratch, launch.scratchIdentity, true, nil, "") == nil {
		return refuse()
	}
	approvedPins := map[string]directoryPin{}
	for _, binding := range launch.roots {
		if !absolutePolicyPath(binding.ApprovedRoot) || !absolutePolicyPath(binding.ScopeRoot) ||
			!insidePolicy(binding.ApprovedRoot, binding.ScopeRoot) || binding.RootIdentity.Device == "" || binding.RootIdentity.Inode == "" {
			return refuse()
		}
		approved := add(binding.ApprovedRoot, binding.RootIdentity, false, nil, "")
		if approved == nil {
			return refuse()
		}
		approvedPins[binding.ApprovedRoot] = approved
		relative, err := filepath.Rel(binding.ApprovedRoot, binding.ScopeRoot)
		if err != nil || add(binding.ScopeRoot, authority.RootIdentity{}, false, approved, relative) == nil {
			return refuse()
		}
	}
	for _, binding := range launch.gitDirectories {
		parent := approvedPins[binding.ApprovedRoot]
		relative, err := filepath.Rel(binding.ApprovedRoot, binding.Path)
		if parent == nil || !insidePolicy(binding.ApprovedRoot, binding.Path) || err != nil ||
			binding.Identity.Device == "" || binding.Identity.Inode == "" ||
			add(binding.Path, binding.Identity, false, parent, relative) == nil {
			return refuse()
		}
	}
	// Later measurements cannot hide an earlier path or image replacement.
	if measurement.Recheck(ctx) != nil {
		return refuse()
	}
	retained = true
	return measurement, nil
}
