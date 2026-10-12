package process

import (
	"context"
	"slices"
	"strings"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// APFS presents Data firmlinks under both names. These aliases are denial-only.
func logicalMountPath(root, rootMount, mounted string) string {
	if rootMount == dataVolumePath && !insidePolicy(dataVolumePath, root) && insidePolicy(dataVolumePath, mounted) {
		return strings.TrimPrefix(mounted, dataVolumePath)
	}
	return mounted
}
func mountDenialAliases(path string) []string {
	if insidePolicy(dataVolumePath, path) {
		return []string{path, strings.TrimPrefix(path, dataVolumePath)}
	}
	return []string{path, dataVolumePath + path}
}

// Inputs only narrow already admitted roots. A mount cannot contain cwd,
// scratch, an executable or a protected runtime dependency.
func validateMountDenials(s SeatbeltSelection, c Command, roots []rootScopeBinding) error {
	if s.RootVolumeOnly && s.FilePolicy != authority.RootScopedFiles {
		return &processsvc.NativeFailure{}
	}
	if len(s.MountDenials) == 0 {
		return nil
	}
	if !s.RootVolumeOnly || s.FilePolicy != authority.RootScopedFiles || len(s.MountDenials) > 1024 || !slices.IsSorted(s.MountDenials) {
		return &processsvc.NativeFailure{}
	}
	for i, path := range s.MountDenials {
		if !absolutePolicyPath(path) || (i > 0 && path == s.MountDenials[i-1]) {
			return &processsvc.NativeFailure{}
		}
		contained := false
		for _, root := range roots {
			if path != root.ScopeRoot && insidePolicy(root.ScopeRoot, path) {
				contained = true
			}
		}
		if !contained {
			return &processsvc.NativeFailure{}
		}
		protected := []string{c.Cwd, s.Scratch}
		if s.ProtectedBundle != nil {
			protected = append(protected, s.ProtectedBundle.Path)
		}
		for _, pin := range slices.Concat(s.Executables, s.ProtectedImages) {
			protected = append(protected, pin.Path)
		}
		for _, target := range protected {
			for _, alias := range mountDenialAliases(path) {
				if authority.ComparableWithin(alias, target) {
					return &processsvc.NativeFailure{}
				}
			}
		}
	}
	return nil
}
func (s *RootScopedPlatformStrategy) mountBoundaryPaths(ctx context.Context, policy SeatbeltSelection, command Command) ([]string, error) {
	refuse := func() ([]string, error) { return nil, &processsvc.NativeFailure{FilesystemUnsupported: true} }
	if s == nil || s.frozen == nil || ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	roots, err := rootScopedScopes(policy, command)
	if err != nil {
		return refuse()
	}
	var paths []string
	for _, root := range roots {
		f, err := s.frozen.facts.directory(ctx, root.ScopeRoot)
		if err != nil || f.path != root.ScopeRoot || f.filesystem != "apfs" || !f.local || (f.mount != "/" && f.mount != dataVolumePath) || f.nested != (f.mounts != "") {
			return refuse()
		}
		if f.mounts != "" {
			if s.frozen.descriptor.FilesystemClass != rootScopedMountBoundaryClass {
				return refuse()
			}
			for _, path := range strings.Split(f.mounts, "\n") {
				if !absolutePolicyPath(path) || path == root.ScopeRoot || !insidePolicy(root.ScopeRoot, path) {
					return refuse()
				}
				paths = append(paths, path)
			}
		}
	}
	slices.Sort(paths)
	paths = slices.Compact(paths)
	if len(paths) > 1024 || ctx.Err() != nil {
		return refuse()
	}
	return paths, nil
}

// Measure before sealing. Later topology drift refuses the original operation
// instead of rewriting policy or renewing its selected deadline.
func (s *RootScopedPlatformStrategy) selectMountBoundaries(ctx context.Context, policy SeatbeltSelection, command Command) (SeatbeltSelection, error) {
	if policy.RootVolumeOnly || len(policy.MountDenials) > 0 || s == nil || s.frozen == nil {
		return SeatbeltSelection{}, &processsvc.NativeFailure{}
	}
	if s.frozen.descriptor.FilesystemClass != rootScopedMountBoundaryClass {
		return policy, nil
	}
	paths, err := s.mountBoundaryPaths(ctx, policy, command)
	if err != nil {
		return SeatbeltSelection{}, err
	}
	policy.MountDenials = paths
	policy.RootVolumeOnly = true
	return policy, nil
}
func (s *RootScopedPlatformStrategy) mountBoundariesCurrent(ctx context.Context, policy SeatbeltSelection, command Command) bool {
	if s == nil || s.frozen == nil {
		return false
	}
	if s.frozen.descriptor.FilesystemClass != rootScopedMountBoundaryClass {
		return !policy.RootVolumeOnly && len(policy.MountDenials) == 0
	}
	paths, err := s.mountBoundaryPaths(ctx, policy, command)
	return policy.RootVolumeOnly && err == nil && slices.Equal(paths, policy.MountDenials)
}
func (s *RootScopedPlatformStrategy) deniedMountFacts(f platformDirectoryFacts, denies []string) bool {
	if s == nil || s.frozen == nil || s.frozen.descriptor.FilesystemClass != rootScopedMountBoundaryClass || !f.nested || f.mounts == "" {
		return false
	}
	for _, path := range strings.Split(f.mounts, "\n") {
		if !absolutePolicyPath(path) || !slices.Contains(denies, path) {
			return false
		}
	}
	return true
}
