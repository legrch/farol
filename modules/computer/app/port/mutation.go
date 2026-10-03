package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/mutation"
)

type MutationAdmissionStatus string

const (
	MutationAdmitted MutationAdmissionStatus = "admitted"
	MutationExisting MutationAdmissionStatus = "existing"
)

type MutationAdmission struct {
	Status MutationAdmissionStatus
	Record *mutation.State
}

// Repository owns atomic same-identity admission and immutable terminal storage.
// Only prepared records can be admitted. Existing records (including prepared)
// are never execution permission. Values are independent copies. Admit must not
// report admitted before durable publication; unavailable/uncertain publication
// is an error, never absence. Recovery may observe the SAME key, never retry it.
type MutationRepository interface {
	Admit(context.Context, *mutation.State) (MutationAdmission, error)
	Load(context.Context, mutation.Identity) (*mutation.State, error)
	Save(context.Context, *mutation.State) error
}

// The native digester must match SHA256(JSON.stringify([workspaceId,kind,path,
// expectedHash,content OR ordered [oldText,newText] pairs])). It excludes outer
// operation identity and Turn/Generation/CallID. Plain Go JSON escaping is not
// assumed equivalent. A digest failure precedes journal admission and effects.
type MutationDigestInput struct {
	WorkspaceID string
	Operation   mutation.Operation
}
type MutationDigester interface {
	Digest(MutationDigestInput) (string, error)
}
type MutationDescriptor struct {
	WorkspaceID, Root             string
	ApprovedRoot                  Root
	DeniedPaths, WriteDeniedPaths []string
}
type MutationRequest struct {
	Workspace MutationDescriptor
	Operation mutation.Operation
}
type MutationReceipt struct {
	Operation, RelativePath string
	Bytes                   uint64
	Replacements            uint32
	BeforeSHA256            *string
	AfterSHA256             string
}

// Native mutation is a single attempt with classified deterministic or unknown
// outcome. Cancellation before helper start has no effect; after start/lost
// acknowledgement is unknown. This port is NOT an authority/admission proof.
// Real implementation and the exact owner-bound effect handoff are prerequisites;
// none is supplied or activated by this pure slice. Native IO must never run
// inside the Computer/Task inspect callbacks. No fallback or retry is permitted.
type MutableWorkspace interface {
	Mutate(context.Context, MutationRequest) (*MutationReceipt, error)
}
