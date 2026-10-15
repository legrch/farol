//go:build darwin

package installmove

import "golang.org/x/sys/unix"

func productionBackend() backend { return unixBackend{effect: darwinMove} }
func darwinMove(left int, leftName string, right int, rightName string, exchange bool) error {
	flags := uint32(unix.RENAME_EXCL)
	if exchange {
		// Darwin RENAME_SWAP; both entries must exist.
		flags = 0x00000002
	}
	return unix.RenameatxNp(left, leftName, right, rightName, flags)
}
