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
type launchFilesystem interface {
	resolve(string) (string, error)
	openDirectory(string) (directoryPin, error)
	pinExecutable(ExecutablePin) (io.Closer, error)
	effectiveUID() int
}

// Both native routes hold every root/scope/cwd/scratch/executable measurement
// through their existing one dispatch. This is not continuous kernel proof.
func measureLaunchFiles(ctx context.Context, command Command, launch *confinedLaunch, fs launchFilesystem) (func(), error) {
	refuse := func() (func(), error) { return nil, &processsvc.NativeFailure{} }
	if ctx == nil || ctx.Err() != nil || launch == nil || fs == nil {
		return refuse()
	}
	var pins []io.Closer
	closePins := func() {
		for i := len(pins) - 1; i >= 0; i-- {
			_ = pins[i].Close()
		}
	}
	retained := false
	defer func() {
		if !retained {
			closePins()
		}
	}()
	// Include partial handles even on error so every failure releases them.
	for _, executable := range launch.pins {
		if ctx.Err() != nil {
			return refuse()
		}
		pin, err := fs.pinExecutable(executable)
		if pin != nil {
			pins = append(pins, pin)
		}
		if err != nil || pin == nil {
			return refuse()
		}
	}
	type directoryCheck struct {
		pin      directoryPin
		path     string
		identity authority.RootIdentity
		private  bool
	}
	var checks []directoryCheck
	check := func(c directoryCheck) bool {
		if ctx.Err() != nil {
			return false
		}
		resolved, err := fs.resolve(c.path)
		if err != nil || resolved != c.path {
			return false
		}
		facts, err := c.pin.inspect(c.path)
		return err == nil && facts.mode.IsDir() && facts.mode&os.ModeSymlink == 0 &&
			facts.identity == c.identity && c.identity.Device != "" && c.identity.Inode != "" &&
			(!c.private || (facts.mode.Perm() == 0700 && facts.uid == fs.effectiveUID()))
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
			pins = append(pins, pin)
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
		if !check(c) {
			return nil
		}
		checks = append(checks, c)
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
	// Later measurements cannot hide an earlier ancestor/path replacement.
	for _, c := range checks {
		if !check(c) {
			return refuse()
		}
	}
	if ctx.Err() != nil {
		return refuse()
	}
	retained = true
	return closePins, nil
}
