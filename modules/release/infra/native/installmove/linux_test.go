//go:build linux

package installmove

import "golang.org/x/sys/unix"

// Test-only injection. Production Linux constructors always refuse.
func disposableMove(l int, ln string, r int, rn string, exchange bool) error {
	flags := uint(unix.RENAME_NOREPLACE)
	if exchange {
		flags = unix.RENAME_EXCHANGE
	}
	return unix.Renameat2(l, ln, r, rn, flags)
}
