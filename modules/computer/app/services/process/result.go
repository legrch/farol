package process

import (
	"bytes"
	"strconv"
	"strings"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// TerminalResult is the owning service's complete bounded terminal observation.
// Its original correlation is not current READ authority, liveness proof, or
// permission to restore, restart, renew admission, or retry an operation.
type TerminalResult struct {
	Scope       ConnectorReservationScope
	Intent      Intent
	Observation Observation
}

// Clone copies every mutable value, including the exit-code pointer.
func (v TerminalResult) Clone() TerminalResult {
	v.Observation.Stdout = bytes.Clone(v.Observation.Stdout)
	v.Observation.Stderr = bytes.Clone(v.Observation.Stderr)
	if v.Observation.ExitCode != nil {
		code := *v.Observation.ExitCode
		v.Observation.ExitCode = &code
	}
	return v
}

// ValidTerminalResult is pure value validation. It consults no clock, host,
// filesystem, current owner, workspace, or admission and grants no authority.
func ValidTerminalResult(v TerminalResult) bool {
	s, i, o := v.Scope, v.Intent, v.Observation
	h, b, seal := s.Host, i.Binding, i.Seal
	boundedID := func(v string, max int) bool { return len(v) <= max && identifier(v) }
	counter := func(v string) bool {
		n, err := strconv.ParseUint(v, 10, 64)
		return err == nil && strconv.FormatUint(n, 10) == v
	}
	path := func(v string) bool {
		if len(v) > 4096 || !authority.CanonicalPath(v) || v == "/" || strings.Contains(v, "\\") {
			return false
		}
		parts := strings.Split(v[1:], "/")
		if len(parts) > 256 {
			return false
		}
		for _, part := range parts {
			if len(part) > 255 {
				return false
			}
			for _, c := range part {
				if c < 32 || c == 127 {
					return false
				}
			}
		}
		return true
	}
	nanos := i.Deadline.UnixNano()
	if !identifier(s.OwnerID) || !identifier(s.ComputerID) || !boundedID(s.CallID, 120) ||
		!identifier(h.ProfileID) || !boundedID(h.BackendGeneration, 120) || !boundedID(h.BuildID, 120) ||
		!boundedID(h.RuntimeID, 120) || !digest(h.LaunchDigest) || h.ConnectorGeneration == 0 ||
		!identifier(i.OperationID) || b.OwnerID != s.OwnerID || !identifier(b.OwnerID) ||
		!boundedID(b.SessionID, 120) || !boundedID(b.TaskID, 120) || !boundedID(b.ParticipantID, 120) || !boundedID(b.TurnID, 120) ||
		!digest(seal.Digest) || !boundedID(seal.WorkspaceID, 120) || !path(seal.Root) || !path(seal.Cwd) || !authority.Within(seal.Root, seal.Cwd) ||
		!counter(seal.RootIdentity.Device) || !counter(seal.RootIdentity.Inode) || nanos <= 0 || !time.Unix(0, nanos).Equal(i.Deadline) {
		return false
	}
	if !identifier(o.Handle) || o.Root != RootExited || !o.Waited ||
		o.GroupCleanup != CleanupConfirmed || o.DescendantCleanup != CleanupConfirmed || !o.OutputDrained ||
		o.StdoutOffset != 0 || o.StderrOffset != 0 || len(o.Stdout) > MaximumOutput || len(o.Stderr) > MaximumOutput ||
		len(o.Stdout)+len(o.Stderr) > MaximumOutput || o.StdoutNext != uint64(len(o.Stdout)) || o.StderrNext != uint64(len(o.Stderr)) ||
		o.StdoutBytes != o.StdoutNext || o.StderrBytes != o.StderrNext {
		return false
	}
	return o.ExitCode != nil && *o.ExitCode >= 0 && *o.ExitCode <= 255 && o.ExitSignal == 0 ||
		o.ExitCode == nil && o.ExitSignal > 0 && o.ExitSignal <= 128
}
