package authority

// FilePolicy selects the meaning of an owner-approved root. It is a trusted
// composition value, not an argument a tool caller may use to grant itself access.
// RootScopedFiles has no implicit filename/credential exclusions. It does not
// promise inode-level secrecy through another allowed hardlink. Existing explicit
// restrictions still apply until the owner replaces them through normal approval.
// Neither mode grants a root, writes, commands, network, or replay permission.
type FilePolicy string

const (
	// The zero value preserves the behavior of existing grants/composition.
	LegacyProtectedFiles FilePolicy = ""
	RootScopedFiles      FilePolicy = "approved-roots-v1"
)

func (p FilePolicy) Valid() bool {
	return p == LegacyProtectedFiles || p == RootScopedFiles
}
