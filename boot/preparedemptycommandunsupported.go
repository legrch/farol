//go:build !darwin

package boot

import "io"

func runPreparedEmptyInspection([]string, io.Reader, io.Writer, io.Writer) int { return 2 }
