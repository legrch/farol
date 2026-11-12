// Package lease defines non-authorizing observations of the current
// startup APFS system/Data pair. It never represents workspace approval.
package lease

import (
	"regexp"
	"strings"
)

const (
	SystemPath = "/"
	DataPath   = "/System/Volumes/Data"
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Facts come from independently held native file descriptors, not a caller path.
// Device and FSID are ephemeral and MUST NOT be persisted as continuity proof.
type Mount struct {
	Device, Inode                              uint64
	FSID                                       [2]int32
	Filesystem, MountedOn, MountedFrom         string
	Local, ReadOnly, Snapshot, IgnoreOwnership bool
}

type Metadata struct {
	Filesystem, MountPoint, GroupID                 string
	Internal, GlobalPermissions, Bootable, Snapshot bool
}

type Epoch struct{ Boot, Runtime string }

func (e Epoch) Valid() bool { return uuidPattern.MatchString(e.Boot) && e.Runtime != "" }
func (m Mount) valid(expected string) bool {
	return m.Device != 0 && m.Inode != 0 && m.FSID != [2]int32{} &&
		m.Filesystem == "apfs" && m.MountedOn == expected && m.MountedFrom != "" &&
		m.Local && !m.IgnoreOwnership
}
func (m Mount) SameInstance(other Mount) bool {
	return m.Device == other.Device && m.FSID == other.FSID &&
		m.Filesystem == other.Filesystem && m.MountedOn == other.MountedOn &&
		m.MountedFrom == other.MountedFrom && m.Local == other.Local &&
		m.ReadOnly == other.ReadOnly && m.Snapshot == other.Snapshot &&
		m.IgnoreOwnership == other.IgnoreOwnership
}
func (m Metadata) valid(expected string, snapshot bool) bool {
	return m.Filesystem == "apfs" && m.MountPoint == expected &&
		uuidPattern.MatchString(m.GroupID) && m.Internal && m.GlobalPermissions &&
		m.Bootable && m.Snapshot == snapshot
}

// Qualified validates an observed current startup pair, not its historical
// physical identity and not an ApprovedRoot. A privileged boot-policy or startup
// Data replacement is outside this trust boundary.
func Qualified(rootMount, dataMount Mount, rootInfo, dataInfo Metadata, epoch Epoch) bool {
	return epoch.Valid() && rootMount.valid(SystemPath) && dataMount.valid(DataPath) &&
		rootMount.ReadOnly && rootMount.Snapshot && !dataMount.ReadOnly && !dataMount.Snapshot &&
		rootInfo.valid(SystemPath, true) && dataInfo.valid(DataPath, false) &&
		strings.EqualFold(rootInfo.GroupID, dataInfo.GroupID)
}

// Candidate is a non-authorizing classification for the *current* Data mount.
// Its values cannot be reused as a future descriptor lease.
type Candidate struct {
	Path          string
	Device, Inode uint64
	Kind          string
	Authority     string
}

func CurrentCandidate(path string, data, observed Mount) Candidate {
	if !data.SameInstance(observed) || observed.Inode == 0 {
		return Candidate{}
	}
	return Candidate{Path: path, Device: observed.Device, Inode: observed.Inode,
		Kind: "current-data-candidate", Authority: "not-established"}
}
