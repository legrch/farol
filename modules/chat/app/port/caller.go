package port

// CallerScope is the original external Responses binding, captured by trusted
// composition on this handle. It is correlation, never admission or authority.
type CallerScope struct {
	SessionID, ThreadID, TurnID, RootTurnID, Model string
}
type CallerFunctionCall struct {
	ItemID, CallID, Name, Arguments string
	Namespace                       *string
}
type BeginCallerToolRequest struct {
	Context             ComputerContext
	Scope               CallerScope
	ProducerOperationID string
	Call                CallerFunctionCall
}
type CallerFunctionOutput struct {
	CallID string
	// Raw is the existing string or typed-text-array output JSON, not a tool
	// request, filesystem result or evidence that the provider consumed it.
	Raw []byte
}
type AcceptCallerOutputRequest struct {
	Context ComputerContext
	Scope   CallerScope
	Calls   []CallerFunctionCall
	Outputs []CallerFunctionOutput
}
type CallerOutput struct {
	Output, SHA256 string
	Bytes          uint64
}
type CallerReturn struct {
	Context                                   ComputerContext
	ProducerOperationID, CallID, OutputSHA256 string
	OutputBytes                               uint64
	Returned                                  bool
}
