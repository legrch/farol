package process

// NativeRefusalReason contains safe pre-start policy/measurement classes only.
// It never carries a native message, path, argv, environment or retry advice.
type NativeRefusalReason string

const (
	RefusalAdmissionPolicy       NativeRefusalReason = "admission_policy"
	RefusalConfinementPolicy     NativeRefusalReason = "confinement_policy"
	RefusalExecutableIntegrity   NativeRefusalReason = "executable_integrity"
	RefusalWorkspaceRootIdentity NativeRefusalReason = "workspace_root_identity"
	RefusalCwdFence              NativeRefusalReason = "cwd_fence"
	RefusalDirectoryPolicy       NativeRefusalReason = "directory_policy"
	RefusalFilesystemPolicy      NativeRefusalReason = "filesystem_policy"
	RefusalRuntimeIntegrity      NativeRefusalReason = "runtime_integrity"
	RefusalHelperPreflight       NativeRefusalReason = "helper_preflight"
	RefusalUnclassified          NativeRefusalReason = "unclassified"
)

// ParseNativeRefusalReason fails closed for absent, future or malformed input.
func ParseNativeRefusalReason(value string) NativeRefusalReason {
	switch reason := NativeRefusalReason(value); reason {
	case RefusalAdmissionPolicy, RefusalConfinementPolicy, RefusalExecutableIntegrity, RefusalWorkspaceRootIdentity, RefusalCwdFence, RefusalDirectoryPolicy, RefusalFilesystemPolicy, RefusalRuntimeIntegrity, RefusalHelperPreflight, RefusalUnclassified:
		return reason
	default:
		return RefusalUnclassified
	}
}
