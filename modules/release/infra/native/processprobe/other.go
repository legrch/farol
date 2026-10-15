//go:build !darwin && !linux

package processprobe

import "io"

type nativeBoundary struct{}

func (nativeBoundary) prepare(int, io.Writer, io.Writer) child { return nil }
func (nativeBoundary) absent(int) bool                         { return false }
