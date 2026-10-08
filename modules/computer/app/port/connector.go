package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// ConnectorGate serializes one connector owner. Trusted root supplies a distinct
// gate with synchronous, no-IO Lock/Unlock; never share it with Store or guard.
type ConnectorGate interface {
	Lock()
	Unlock()
}

// ConnectorExecutionCeiling is an independent copy of the original verified
// publication seal. Exporting it does not grant liveness. Trusted root maps it to
// execution's constructor DTO once and retains that issuer with this exact owner.
// Subsequent operations and final disclosure still pass CurrentExecutionAdmission.
type ConnectorExecutionCeiling struct {
	Participant authority.Participant
	Approval    authority.Approval
}

// ConnectorHost is an immutable exact host lifetime selected by trusted root.
// None of these values or the execution IDs may come from an MCP request body.
type ConnectorHost struct {
	ProfileID, BackendGeneration, BuildID, RuntimeID, LaunchDigest string
	ConnectorGeneration                                            uint64
}

// ConnectorLaunch is constructor-only input. Root mints the admission SessionID,
// work-scope TaskID, owner TaskEpoch, participant and TurnCorrelation; no provider
// thread/turn IDs are mapped here. Root alone selects the bounded policy/role.
// Approval is the original trusted owner policy, not a persisted liveness proof.
type ConnectorLaunch struct {
	Host            ConnectorHost
	Admission       authority.Admission
	Participant     authority.ParticipantAdmission
	TurnCorrelation string
	Approval        authority.Approval
	// VerificationChallenge is the expected challenge digest computed by root.
	// Zero disables verification for existing source fixtures. It is never wire input.
	VerificationChallenge [32]byte
}

// ConnectorVerification is one content-free observation from this exact live
// owner. Root records it only after the existing workspace List contract succeeds
// and its final disclosure guard passes. It contains no entries or restored proof.
type ConnectorVerification struct {
	Host            ConnectorHost
	Binding         TaskBinding
	ChallengeDigest [32]byte
	WorkspaceID     string
	CallID          string
	EntryCount      uint32
	Truncated       bool
}

// ConnectorPublication contains known readback of a NEW original participant
// publication. Existing/duplicate participants cannot restore positive liveness.
// An error or incomplete result is unavailable even if bytes may have committed.
type ConnectorPublication struct {
	Revision          uint64
	OriginalPublished bool
	Participant       authority.Participant
	Approval          authority.Approval
}

// ConnectorJournal adapts the existing sole access Store. It owns no registry,
// journal or retry engine. Publish is one-shot CAS with exact original readback.
// Withdraw uses known revision/readback; all calls run OUTSIDE the connector gate.
type ConnectorJournal interface {
	AccessRepository
	PublishConnector(context.Context, ConnectorLaunch) (ConnectorPublication, error)
	WithdrawConnector(context.Context, string) error
}

// CurrentConnectorGuard is mandatory, root-selected and synchronous; its entry
// performs no IO. It serializes host/settings fences with inspect exactly once.
// Only MutationRequest.WithPublication may perform bounded final native file
// publication/verification/guarded undo inside inspect; other IO stays outside.
// Trusted root approval renewal may perform one final prepared Store snapshot
// rename here; its staging, durability and readback stay outside these gates.
// true requires this exact authenticated host lifetime and unchanged policy
// seal; time-only approval renewal is permitted. No permissive default exists.
// Lock order: AccessSnapshot -> connector owner -> guard. Fence changes release
// the guard before withdrawing the owner; no guard-held path may acquire Store
// or the connector owner. Neither inspect nor the guard may reenter these owners.
// Authentication, physical host qualification and shutdown remain root duties.
type CurrentConnectorGuard interface {
	WithConnectorCurrent(context.Context, ConnectorHost, func(bool) error) error
}
