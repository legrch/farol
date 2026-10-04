package port

import "context"

// HandoffBinding is pinned by trusted boot/host before spawn. Roots identify
// physical directories, not paths selected by a transport request.
type HandoffBinding struct {
	ProfileID, BackendGeneration, BuildID, HostLifetimeID, ChildLaunchID string
	ParentRoot, ChatRoot                                                 JournalRoot
}

// HandoffPublication identifies the actual origin receipt independently of the
// handoff ID and of the subsequent persistence head digest.
type HandoffPublication struct {
	Binding       HandoffBinding
	HandoffID     string
	ReceiptDigest [32]byte
}

type HandoffStage string

const (
	HandoffCaptured     HandoffStage = "ORIGIN_CAPTURED"
	HandoffAcknowledged HandoffStage = "HOST_ACKNOWLEDGED"
	HandoffTerminated   HandoffStage = "CHILD_TERMINATED"
	HandoffConsumed     HandoffStage = "SUCCESSOR_CONSUMED"
)

type HandoffOrigin string

const HandoffLiveOwner HandoffOrigin = "LIVE_OWNER_CALLBACK"

// HandoffACK is a distinct explicit initiating-host acknowledgement. It is not
// a result ACK, transport write, receipt read or descriptor-close observation.
type HandoffACK struct{ Publication HandoffPublication }

type HandoffStopMode string

const (
	HandoffGracefulStop HandoffStopMode = "GRACEFUL_STOP"
	HandoffForcedStop   HandoffStopMode = "FORCED_STOP"
)

type HandoffTerminalKind string

const HandoffNormalExit HandoffTerminalKind = "NORMAL_EXIT"

// KnownACKDigest must be the head returned by durable Acknowledge, retained by
// the initiating host before observing its exact child. EOF/PID absence have no
// representation here. Only trusted host mechanics may supply this observation.
type HandoffTerminal struct {
	Publication    HandoffPublication
	KnownACKDigest [32]byte
	Kind           HandoffTerminalKind
	StopMode       HandoffStopMode
	ExitCode       *int
	Signal         string
}

// PreviousHostDrainConfirmed is supplied only by the trusted host's independent
// exact-profile drain witness. It means the preceding recorder reply AND exact
// recorder child terminal were known successful before the host persisted clean
// drain. It must never be inferred from this store's terminal bytes or Load.
// Missing/crashed/unknown host completion is false, even with a valid terminal.
type HandoffConsumption struct {
	PreviousHostDrainConfirmed bool
	Next                       JournalScope
	NextBinding                HandoffBinding
	AttemptID                  string
}

// HandoffRecord contains no credentials, provider content, clock or PID. Origin
// provenance is established by Capture(actual CleanRetirement), never journal
// replay. A persisted tag alone is not an origin proof.
type HandoffRecord struct {
	Version     int
	Stage       HandoffStage
	Origin      HandoffOrigin
	Publication HandoffPublication
	Receipt     RetirementReceipt
	ACK         *HandoffACK
	Terminal    *HandoffTerminal
	Consumption *HandoffConsumption
}

type HandoffHead struct {
	Record *HandoffRecord
	Digest [32]byte
}

// HandoffStore is the consumer-owned persistence seam. Publish compares exact
// prior bytes and durably publishes one transition; it never retries. A nil,
// mismatched, late or errored reply is uncertain, not permission to repeat.
// Load returns an empty head only for a qualified never-used store. Existing
// incomplete/unknown records must fail closed across process boundaries.
// Boot injects the native adapter at the exact approved physical roots; a memory
// fixture is not native authority. Store IO occurs outside the origin's gate.
type HandoffStore interface {
	// Guard supplies dedicated service serialization, not the live origin gate.
	Guard() Gate
	// Digest is deterministic, bounded and performs no IO or origin reentry.
	Digest(HandoffRecord) ([32]byte, error)
	// Fence makes late/lost caller outcomes sticky across repository lifetimes.
	// It is one-shot; failure grants no retry or alternate storage.
	Fence(context.Context) error
	Load(context.Context) (*HandoffHead, error)
	Publish(context.Context, [32]byte, HandoffRecord) (*HandoffHead, error)
}
