// Package browser adapts the Chat browser capability to a Root-injected exchange.
// These consumer-owned values are NOT a wire format. Root explicitly maps them
// to its canonical generated schema; no transport/protocol implementation lives here.
package browser

import "context"

// Exchange sends exactly one already-bounded command and returns one typed reply.
// Implementations must honor ctx cancellation and DeadlineMillis, bound encoded
// bytes before decoding, and never retry unknown/refused work. Any error returns
// nil Reply. Root owns physical request correlation and the inherited mailbox.
type Exchange interface {
	Exchange(context.Context, Command) (Reply, error)
}
type Clock interface{ NowMillis() uint64 }
type Scope struct{ ProfileID, BackendGeneration string }

// Unexported markers close the operation set. Commands are VALUE structs. Root
// uses a type switch over these six types, rather than marshaling private structs
// or supplying arbitrary methods/scripts/URLs. Replies must also be VALUE structs.
type Command interface{ browserCommand() }
type Reply interface{ browserReply() }

type Identity struct {
	ProfileID, OwnerID, SessionID, TaskID, TurnID, OperationID string
	TurnGeneration                                             uint64
}
type Lease struct {
	Identity          Identity
	BackendGeneration string
	SlotOrdinal       uint8
	SlotGeneration    uint64
}
type Binding struct {
	ProviderState                      string
	Lease                              Lease
	ViewID                             string
	ViewGeneration, DocumentGeneration uint64
	ConversationID                     string
}
type Selection struct {
	Provider, Alias, AccountID, ModelID, Effort, Mode string
	ToolsEnabled                                      bool
	ConnectorID, ConnectorGrantID                     string
}
type Resolution struct {
	RequestedAlias, RequestedExecutor, RequestedEffort, RequestedMode string
	Resolved                                                          Selection
	ConfigSHA256, TranslationID                                       string
}
type Target struct {
	Required                                            RequiredControls
	Mode                                                string
	ConversationID, PreviousUserTurnID, PreviousReplyID string
	Selection                                           Selection
	Resolution                                          Resolution
}
type ControlFact struct{ Value, Literal, Source string }
type SelectionFacts struct {
	Model, Effort, Mode, Connector ControlFact
	ObservedAtMillis               uint64
}
type RequiredControls struct{ Model, Effort, Mode, Connector bool }
type Verification struct {
	Pinned                              Selection
	Required                            RequiredControls
	Binding                             Binding
	Observed                            SelectionFacts
	PreviousUserTurnID, PreviousReplyID string
	IntentDigest, EvidenceID            string
}

type PrepareCommand struct {
	Target         Target
	Lease          Lease
	DeadlineMillis uint64
}
type PreparedReply struct {
	Saved     bool
	Readiness string
	Binding   Binding
	Code      string
}
type VerifySendCommand struct {
	Required                                          RequiredControls
	Binding                                           Binding
	Requested                                         Selection
	PreviousUserTurnID, PreviousReplyID, IntentDigest string
	DeadlineMillis                                    uint64
}
type VerifiedReply struct{ Verification Verification }
type SendCommand struct {
	Binding              Binding
	Verification         Verification
	IntentDigest, Prompt string
	DeadlineMillis       uint64
}
type SentReply struct {
	Binding                      Binding
	VerificationID, Status, Code string
}
type ObserveCommand struct {
	Binding        Binding
	AfterSequence  uint64
	Limit          int
	DeadlineMillis uint64
}
type Observation struct {
	ProviderConversationID         string
	Binding                        Binding
	Sequence, ObservedAtMillis     uint64
	Kind, Text, Code               string
	UserTurnID, ReplyID, SegmentID string
}

// The adapter bounds Events before allocation and copies them to the application
// port. Root must not mutate a reply concurrently with returning it.
type ObservedReply struct {
	Events []Observation
	Gap    bool
}
type CancelCommand struct {
	Binding        Binding
	DeadlineMillis uint64
}
type CancelledReply struct {
	Binding      Binding
	Status, Code string
}
type DisposeCommand struct {
	Lease          Lease
	DeadlineMillis uint64
}
type DisposedReply struct {
	Lease     Lease
	Confirmed bool
	Code      string
}

func (PrepareCommand) browserCommand()    {}
func (VerifySendCommand) browserCommand() {}
func (SendCommand) browserCommand()       {}
func (ObserveCommand) browserCommand()    {}
func (CancelCommand) browserCommand()     {}
func (DisposeCommand) browserCommand()    {}
func (PreparedReply) browserReply()       {}
func (VerifiedReply) browserReply()       {}
func (SentReply) browserReply()           {}
func (ObservedReply) browserReply()       {}
func (CancelledReply) browserReply()      {}
func (DisposedReply) browserReply()       {}
