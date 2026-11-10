//go:build darwin

package boot

import "syscall"

// This is the trusted kernel scalar only, captured before C1/C3 handles.
func readKernelBootUUID() (string, error) { return syscall.Sysctl("kern.bootsessionuuid") }
