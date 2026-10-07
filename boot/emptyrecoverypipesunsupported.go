//go:build !darwin

package boot

import "io"

func emptyRecoveryDeadlineStreams(in io.Reader, out io.Writer) (io.Reader, io.Writer, func() error, error) {
	return in, out, func() error { return nil }, nil
}
