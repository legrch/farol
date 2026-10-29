//go:build darwin

package boot

import "golang.org/x/sys/unix"

// Duplicate the exact retained Computer descriptor while the profile lock also
// protects its full named-entry and physical-path recheck. Never reopen by path.
func duplicateComputerDescriptor(profile *QualifiedProfile) (int, NativeRoot, error) {
	if profile == nil || profile.owner == nil {
		return -1, NativeRoot{}, profileFailure(ProfileUnavailable)
	}
	s := profile.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.os.(darwinProfileOS); !ok {
		return -1, NativeRoot{}, profileFailure(ProfileUnsupported)
	}
	if err := s.check(); err != nil {
		return -1, NativeRoot{}, err
	}
	d := s.directories[s.computer]
	fd, err := unix.FcntlInt(uintptr(d.fd), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return -1, NativeRoot{}, profileFailure(ProfileUnavailable)
	}
	root := NativeRoot{Path: d.path, ProfileID: s.binding.ProfileID, Device: d.meta.device, Inode: d.meta.inode, OwnerUID: d.meta.uid, Mode: d.meta.mode & 07777}
	return fd, root, nil
}

func closeStageDescriptor(fd int) error {
	if unix.Close(fd) != nil {
		return profileFailure(ProfileCleanupUnknown)
	}
	return nil
}
