package port

import (
	"context"

	"github.com/legrch/farol/modules/chat/domain/turn"
)

// ResultPublication identifies exact durable bytes outside the content-free
// journal. Root is the qualified Chat root, not a request-selected path. The
// digest covers the closed storage version, original binding, result, metadata
// and payload. Zero means memory-only retention and cannot prove restart safety.
// A publication is data, not current read, admission, Send or Follow authority.
type ResultPublication struct {
	Version      uint32
	Root         JournalRoot
	StorageRoot  JournalRoot
	Digest       [32]byte
	EncodedBytes uint32
}

// Includes at most 8192 payload bytes (base64 encoded) and bounded identity and
// selection evidence. This bounds decoding independently of payload capacity.
const MaxResultRecordBytes = 64 * 1024

func (p ResultPublication) Valid() bool {
	return p.Version == 1 && p.Root.Device != 0 && p.Root.Inode != 0 &&
		p.StorageRoot.Device == p.Root.Device && p.StorageRoot.Inode != 0 && p.StorageRoot.Inode != p.Root.Inode && p.StorageRoot.OwnerUID == p.Root.OwnerUID &&
		p.Digest != ([32]byte{}) && p.EncodedBytes > 0 && p.EncodedBytes <= MaxResultRecordBytes
}

// ResultRead names one previously qualified terminal publication. The caller
// must establish original terminal/cleanup evidence and CURRENT read authority
// before storage IO, then recheck authority before exposing returned content.
// A storage match alone cannot qualify an orphan Retain as a terminal result.
type ResultRead struct {
	Binding     TurnBinding
	Result      turn.Result
	Publication ResultPublication
}

// DurableResults is the existing retention owner's durable adapter seam. Read
// performs no provider call, ACK, journal transition or admission restoration.
// It returns an independent exact request only after physical qualification,
// closed decoding and digest/binding/result checks. There is no discovery API.
// Fence preserves a late/lost caller outcome after possible publication. It is
// one-shot best effort; failure remains uncertainty, never permission to reload
// apparently valid bytes or switch storage. Boot owns accepted reopen authority.
type DurableResults interface {
	ResultRetention
	Read(context.Context, ResultRead) (*RetainRequest, error)
	Fence(context.Context) error
}
