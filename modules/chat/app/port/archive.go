package port

import "context"

const (
	ArchivePageSize  = 32
	ArchiveTextBytes = 8192
)

// ArchiveSummary is observed stored data, never a terminal/publication proof,
// live handle, delivery ACK or authority to resume/repeat an original effect.
// Digest pins one exact canonical record for a later explicit content query.
type ArchiveSummary struct {
	Key, ProfileID, OwnerID, BackendGeneration, OperationID, ResultID, ConversationID string
	RecordedOutcome                                                                   string
	Bytes                                                                             int
	Digest                                                                            [32]byte
}

// ArchivePage is a bounded current observation, not an immutable history origin.
// Next is an exclusive lexical key; empty means no later observed reply. Pages
// may change between queries. Reads must still match their exact record digest.
// Unresolved reports retained fences/incomplete or unrendered namespace entries without
// settling them. Even false does not supply old process/operation closure.
type ArchivePage struct {
	Entries    []ArchiveSummary
	Next       string
	Unresolved bool
}

type ArchiveListSelection struct{ ProfileID, OwnerID, After string }
type ArchiveReadSelection struct {
	ProfileID, OwnerID, Key string
	Digest                  [32]byte
}

type ArchivedReply struct {
	Summary ArchiveSummary
	Text    string
}

// StoredReplyArchive observes the EXISTING private result namespace only, under
// its existing exclusive claim. It composes no mutable result owner, journal,
// provider or handoff. Each operation holds its own read-only claim and performs
// final physical rechecks before returning; Close releases only descriptors.
// The adapter must not create, repair, sync, poison, remove or acknowledge state.
// Large inventories are streamed with a bounded page and context cancellation;
// opening a UI/reader does not eagerly scan or impose the live queue's capacity.
type StoredReplyArchive interface {
	ListStoredReplies(context.Context, ArchiveListSelection) (*ArchivePage, error)
	ReadStoredReply(context.Context, ArchiveReadSelection) (*ArchivedReply, error)
}
