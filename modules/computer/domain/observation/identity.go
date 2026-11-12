// Package observation compares draft durable identity observations. It does not
// grant access, refresh an approval, or replace live descriptor dev/inode checks.
package observation

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// EvidenceSchema is deliberately NOT a ProductSettings or authority schema.
// Enabling persistence/automatic rebinding requires a separate reviewed migration.
const EvidenceSchema = "farol.workspace-root-candidate/1"

// Evidence is a candidate for continuity, not an unforgeable identity. Cloned or
// restored volumes can duplicate these values. Birth time is an additional
// discriminator, not a security token; it is mutable on macOS.
type Evidence struct {
	Schema           string `json:"schema"`
	Filesystem       string `json:"filesystem"`
	VolumeUUID       string `json:"volumeUuid"`
	FileID           string `json:"fileId"`
	BirthSeconds     string `json:"birthSeconds"`
	BirthNanoseconds string `json:"birthNanoseconds"`
}

// Binding is an observation of the CURRENT mount. Never persist it as evidence
// of a different mount or feed a candidate match into the existing authority.
type Binding struct{ Path, Device, Inode string }
type Observation struct {
	Binding  Binding
	Evidence Evidence
}
type Saved struct {
	Binding  Binding
	Evidence *Evidence
}

type Settlement string

const Settled Settlement = "settled"

type Assessment string

const (
	Unresolved             Assessment = "unresolved-outcome"
	InvalidEvidence        Assessment = "invalid-evidence"
	ReconfirmationRequired Assessment = "legacy-reconfirmation-required"
	DifferentPath          Assessment = "different-path"
	DifferentVolume        Assessment = "different-volume"
	DifferentDirectory     Assessment = "different-directory"
	SameMountCandidate     Assessment = "same-mount-candidate"
	RemountCandidate       Assessment = "remount-candidate"
)

func decimal(value string, positive bool, bits int) bool {
	if len(value) == 0 || len(value) > 20 {
		return false
	}
	n, err := strconv.ParseUint(value, 10, bits)
	return err == nil && (!positive || n != 0) && strconv.FormatUint(n, 10) == value
}

// CanonicalPath is lexical only. The native adapter must still open EVERY path
// component without following links and recheck its descriptor chain.
func CanonicalPath(value string) bool {
	if !utf8.ValidString(value) || len(value) < 2 || len(value) > 4096 ||
		!strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") || strings.Contains(value, "\\") {
		return false
	}
	parts := strings.Split(value[1:], "/")
	if len(parts) > 256 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
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

func (b Binding) Valid() bool {
	return CanonicalPath(b.Path) && decimal(b.Device, true, 64) && decimal(b.Inode, true, 64)
}

func (e Evidence) Valid() bool {
	if e.Schema != EvidenceSchema || e.Filesystem != "apfs" ||
		!decimal(e.FileID, true, 64) || !decimal(e.BirthSeconds, false, 63) ||
		!decimal(e.BirthNanoseconds, false, 32) {
		return false
	}
	ns, _ := strconv.ParseUint(e.BirthNanoseconds, 10, 32)
	if ns >= 1_000_000_000 || len(e.VolumeUUID) != 36 || e.VolumeUUID == "00000000-0000-0000-0000-000000000000" {
		return false
	}
	for i, c := range e.VolumeUUID {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (o Observation) Valid() bool {
	return o.Binding.Valid() && o.Evidence.Valid() && o.Binding.Inode == o.Evidence.FileID
}

// Preflight returns an early classification without measuring the filesystem.
// Unknown/missing settlement never becomes settled by receiving new evidence.
func Preflight(saved Saved, settlement Settlement) Assessment {
	if settlement != Settled {
		return Unresolved
	}
	if !CanonicalPath(saved.Binding.Path) {
		return InvalidEvidence
	}
	if saved.Evidence == nil {
		return ReconfirmationRequired
	}
	if !saved.Binding.Valid() || !saved.Evidence.Valid() || saved.Binding.Inode != saved.Evidence.FileID {
		return InvalidEvidence
	}
	return ""
}

// Compare intentionally never returns "approved". Even a full match requires
// the unresolved clone/restore policy and native qualification to be decided
// before any production authorization can use it.
func Compare(saved Saved, current Observation, settlement Settlement) Assessment {
	if early := Preflight(saved, settlement); early != "" {
		return early
	}
	if !current.Valid() {
		return InvalidEvidence
	}
	if saved.Binding.Path != current.Binding.Path {
		return DifferentPath
	}
	if saved.Evidence.VolumeUUID != current.Evidence.VolumeUUID {
		return DifferentVolume
	}
	if saved.Evidence.FileID != current.Evidence.FileID ||
		saved.Evidence.BirthSeconds != current.Evidence.BirthSeconds ||
		saved.Evidence.BirthNanoseconds != current.Evidence.BirthNanoseconds {
		return DifferentDirectory
	}
	if saved.Binding.Device != current.Binding.Device {
		return RemountCandidate
	}
	return SameMountCandidate
}
