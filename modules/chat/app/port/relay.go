package port

// ComputerContext is a content-free observation of one actual admitted owner.
// Values correlate a relay callback; they cannot create admission or a grant.
type ComputerContext struct {
	Binding             TurnBinding
	Browser             BrowserBinding
	UserTurnID, ReplyID string
	SourceSequence      uint64
}

// ComputerReturn is supplied by trusted composition after the existing host
// caller-relay returned the exact result. It does not prove provider consumption.
// No tool arguments, result bytes or history payload are stored by Chat.
type ComputerReturn struct {
	Context  ComputerContext
	CallID   string
	Returned bool
}
