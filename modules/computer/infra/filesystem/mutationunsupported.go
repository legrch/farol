//go:build !darwin

package filesystem

// No weak rename fallback or non-Darwin native mutation qualification exists.
func nativeMutationFS() mutationFS { return nil }
