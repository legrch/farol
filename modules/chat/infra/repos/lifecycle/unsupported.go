//go:build !darwin && !linux

package lifecycle

import "context"

type disk struct{}

func openDisk(context.Context, Root) (*disk, error)           { return nil, failure(Unavailable, false) }
func (*disk) read(int) ([]byte, error)                        { return nil, failure(Unavailable, false) }
func (*disk) create(context.Context, []byte) error            { return failure(Unavailable, false) }
func (*disk) replace(context.Context, []byte, [32]byte) error { return failure(Unavailable, false) }
func (*disk) close() error                                    { return nil }
