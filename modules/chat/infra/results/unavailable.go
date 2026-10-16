//go:build !darwin && !linux

package results

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func (*Archive) listArchive(context.Context, port.ArchiveListSelection) (*port.ArchivePage, error) {
	return nil, Unavailable
}
func (*Archive) readArchive(context.Context, port.ArchiveReadSelection) (*port.ArchivedReply, error) {
	return nil, Unavailable
}
