package results

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Archive is an existing-only observation adapter, selected before any owner
// constructor. NewArchive performs no IO and cannot reopen a mutable Native.
// Its responses are stored data; only the caller supplies current read authority.
type Archive struct{ root Root }

func NewArchive(root Root) *Archive { return &Archive{root: root} }

func (a *Archive) ListStoredReplies(ctx context.Context, selection port.ArchiveListSelection) (*port.ArchivePage, error) {
	if a == nil || nilContext(ctx) || ctx.Err() != nil || selection.ProfileID != a.root.ProfileID || !validID(selection.ProfileID) || !validID(selection.OwnerID) || selection.After != "" && !validResultKey(selection.After) {
		return nil, Invalid
	}
	return a.listArchive(ctx, selection)
}

func (a *Archive) ReadStoredReply(ctx context.Context, selection port.ArchiveReadSelection) (*port.ArchivedReply, error) {
	if a == nil || nilContext(ctx) || ctx.Err() != nil || selection.ProfileID != a.root.ProfileID || !validID(selection.ProfileID) || !validID(selection.OwnerID) || !validResultKey(selection.Key) || selection.Digest == ([32]byte{}) {
		return nil, Invalid
	}
	return a.readArchive(ctx, selection)
}

var _ port.StoredReplyArchive = (*Archive)(nil)
