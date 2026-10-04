package task

import (
	"strconv"
	"strings"
)

// NativeSeal retains command correlation only, never argv, stdin, environment,
// permission, confinement evidence or a provider transcript.
type NativeRootIdentity struct{ Device, Inode string }
type NativeSeal struct {
	Digest, WorkspaceID, Root, Cwd string
	RootIdentity                   NativeRootIdentity
	Write                          bool
}

// NativeReservation belongs to an ALREADY admitted operation. DeadlineUnixNano
// is the original absolute execution deadline, without monotonic clock metadata.
// This value neither checks expiry nor changes the Computer execution budget.
type NativeReservation struct {
	OperationID      string
	Admission        AdmissionBinding
	Seal             NativeSeal
	DeadlineUnixNano int64
}

func nativeDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
func nativeIdentity(s string) bool {
	v, err := strconv.ParseUint(s, 10, 64)
	return err == nil && v != 0 && strconv.FormatUint(v, 10) == s
}
func nativePath(s string) bool {
	// Canonical POSIX spelling only. This pure check measures no host path and
	// performs no normalization that could adopt a different selected root.
	if !Text(s, 4096) || len(s) <= 1 || s[0] != '/' {
		return false
	}
	for _, component := range strings.Split(s[1:], "/") {
		if component == "" || component == "." || component == ".." || len(component) > 255 {
			return false
		}
	}
	for _, c := range s {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}
func (r NativeReservation) Valid() bool {
	s := r.Seal
	return ID(r.OperationID) && r.Admission.Valid() && r.DeadlineUnixNano > 0 && nativeDigest(s.Digest) &&
		ID(s.WorkspaceID) && nativePath(s.Root) && nativePath(s.Cwd) &&
		(s.Cwd == s.Root || strings.HasPrefix(s.Cwd, s.Root+"/")) &&
		nativeIdentity(s.RootIdentity.Device) && nativeIdentity(s.RootIdentity.Inode)
}
func (r NativeReservation) Matches(i Intent) bool {
	return r.Valid() && r.OperationID == i.OperationID && r.Admission == i.Admission && r.Admission.TaskID == i.TaskID &&
		(i.Action == Create || i.Action == Continue || i.Action == Resume) &&
		r.Seal.WorkspaceID == i.Binding.WorkspaceID && r.Seal.Root == i.Binding.Writer.Path &&
		r.Seal.RootIdentity.Device == i.Binding.Writer.Device && r.Seal.RootIdentity.Inode == i.Binding.Writer.Inode
}
