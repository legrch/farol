package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
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
	// Nil confirms exact durable terminal publication; an error is uncertain.
	// Result retention and client acknowledgement belong to the root journal.
	Save(context.Context, *mutation.State) error
}

// CurrentMutationObservation authorizes metadata disclosure under the current
// authenticated connector, its original ceiling and current Computer policy.
// The stable profile identity comes from trusted composition. This port grants
// no execution, admission or lease renewal. It must check read access to the
// exact workspace/path and invoke inspect synchronously exactly once, serialized
// against connector withdrawal and policy changes. Entry and inspect perform no
// native IO and must not reenter those owners. Repository IO happens outside it.
type CurrentMutationObservation interface {
	WithMutationObservation(context.Context, mutation.Identity, string, string, func() error) error
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

// FilePolicy has the same trusted snapshot contract as Descriptor.FilePolicy.
type MutationDescriptor struct {
	FilePolicy                    authority.FilePolicy
	WorkspaceID, Root             string
	ApprovedRoot                  Root
	DeniedPaths, WriteDeniedPaths []string
}
type MutationRequest struct {
	Workspace MutationDescriptor
	Operation mutation.Operation
	// Optional private self-test constraint. When present the native producer
	// must pin this exact previously created parent, refuse missing parents and
	// recheck its physical identity through publication. It grants no authority.
	ScratchParent *mutation.ScratchCleanupBinding
	// Only scratch edits supply this original file identity. It is enforced by
	// the scratch-capable native producer before the existing guarded swap.
	ScratchExpectedFile *mutation.DirectoryIdentity
	// Rechecks the SAME selected execution lease, outside owner callbacks.
	// Required before the first directory effect and publication preparation.
	BeforePublish func(context.Context) error
	// Rechecks the same selected owner/lease, generations and exact descriptor,
	// then invokes publish exactly once per call synchronously while ALL
	// current-owner locks remain held through its return. Each call encloses one
	// absent workspace-parent mkdir OR final file publication/verification/undo.
	// Traversal, content preparation, staging, directory sync/open, journal IO and
	// owner reentry stay outside. Errors must be propagated; no effect is retried.
	WithPublication func(context.Context, func() error) error
}
type MutationReceipt struct {
	Operation, RelativePath string
	Bytes                   uint64
	Replacements            uint32
	BeforeSHA256            *string
	AfterSHA256             string
	Directory               mutation.DirectoryIdentity
	// Physical identity of a successful scratch file publication only. This is
	// an in-memory cleanup witness, not a public or durable mutation receipt.
	ScratchFile mutation.DirectoryIdentity
}

// Native mutation is one admitted attempt. Cancellation before possible effects
// is a refusal; lost publication acknowledgement or uncertainty after parent
// creation/publication is unknown. One guarded internal undo may settle a swap
// preimage mismatch before reporting; no retry/fallback after unknown/refusal.
// This port is not authority/admission proof. Only WithPublication may run the
// bounded parent mkdir or final native publication under owner locks.
// Confinement still requires native qualification before activation.
type MutableWorkspace interface {
	Mutate(context.Context, MutationRequest) (*MutationReceipt, error)
}

// ScratchBoundMutableWorkspace is implemented only by producers that enforce
// the supplied original scratch parent. The caller still owns admission and
// the whole-run process fence; a generic MutableWorkspace is not enough.
type ScratchBoundMutableWorkspace interface {
	MutateScratch(context.Context, MutationRequest, mutation.ScratchCleanupBinding) (*MutationReceipt, error)
}

// StagedMutableWorkspace is a private Scratch-only execution port. BeginStage
// retains the process exclusion gate but performs no native effect. The caller
// owns exactly one Execute and must Release only after terminal persistence.
// Existing journal records never enter this port.
type StagedMutableWorkspace interface {
	BeginStage(context.Context, MutationRequest) (StagedMutation, error)
}

// StagedMutation keeps its gate through Execute, the caller's terminal Save,
// and Release. Execute joins the native descriptor close and its post-check.
// Release is an idempotent synchronous in-memory gate release, not a native effect.
type StagedMutation interface {
	Execute(context.Context) (*MutationReceipt, error)
	Release()
}

// ScratchCleanupRequest carries the original immutable creation facts. The
// caller owns journal admission, process exclusion, current authority and the
// terminal result; this value does not supply any of those proofs.
type ScratchCleanupRequest struct {
	Workspace       MutationDescriptor
	Binding         mutation.ScratchCleanupBinding
	BeforePublish   func(context.Context) error
	WithPublication func(context.Context, func() error) error
}

// ScratchCleanupAdmission is permission to execute only when Status is
// MutationAdmitted. An existing record, including Prepared, is observation.
type ScratchCleanupAdmission struct {
	Status MutationAdmissionStatus
	Record *mutation.ScratchCleanupState
}

// ScratchCleanupRepository binds a cleanup attempt to its durable creation.
// Neither admission nor a stored record supplies current authority or process
// exclusion. A failed admission or terminal save must never be retried.
type ScratchCleanupRepository interface {
	AdmitScratchCleanup(context.Context, *mutation.ScratchCleanupState) (ScratchCleanupAdmission, error)
	LoadScratchCleanup(context.Context, mutation.ScratchCleanupBinding) (*mutation.ScratchCleanupState, error)
	SaveScratchCleanup(context.Context, *mutation.ScratchCleanupState) error
}

// ScratchCleanupWorkspace performs one already admitted, guarded attempt.
type ScratchCleanupWorkspace interface {
	RemoveEmptyScratch(context.Context, ScratchCleanupRequest) error
}
