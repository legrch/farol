package mutation

import (
	"github.com/legrch/farol/modules/computer/domain/authority"
	"strings"
)

const scratchPrefix = ".farol-self-test-"
const EmptyScratchInventory = "empty"

// DirectoryIdentity is native evidence, never authority. Decimal strings retain
// all 64 bits across JSON/desktop boundaries, including values above 2^53.
type DirectoryIdentity struct{ Device, Inode string }

func (d DirectoryIdentity) Valid() bool {
	return decimalIdentity(d.Device, false) && decimalIdentity(d.Inode, true)
}

// ScratchBinding is immutable from admission, including interrupted creation.
// This first slice owns only an empty directory; no marker, file or child owner.
type ScratchBinding struct {
	RunID, Root, Leaf string
	RootIdentity      DirectoryIdentity
	ExpectedInventory string
}

func (s ScratchBinding) Valid() bool {
	return ScratchLeaf(s.Leaf) && s.Leaf == ScratchPath(s.RunID) && authority.CanonicalPath(s.Root) && s.Root != "/" && s.RootIdentity.Valid() && s.ExpectedInventory == EmptyScratchInventory
}

type Scratch struct{ Binding ScratchBinding }

func (Scratch) operation()         {}
func (Scratch) Kind() Kind         { return ScratchKind }
func (s Scratch) Path() string     { return s.Binding.Leaf }
func (s Scratch) Clone() Operation { return s }
func ScratchPath(id string) string { return scratchPrefix + id }
func ScratchLeaf(path string) bool {
	if !strings.HasPrefix(path, scratchPrefix) {
		return false
	}
	id := strings.TrimPrefix(path, scratchPrefix)
	if len(id) != 32 && len(id) != 36 {
		return false
	}
	for i, c := range id {
		if len(id) == 36 && (i == 8 || i == 13 || i == 18 || i == 23) {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func decimalIdentity(s string, nonzero bool) bool {
	if s == "" || len(s) > 20 || len(s) > 1 && s[0] == '0' || nonzero && s == "0" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return len(s) < 20 || s <= "18446744073709551615"
}
