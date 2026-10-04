package boot

import (
	wire "github.com/legrch/farol/gen/desktop/v1"
	control "github.com/legrch/farol/modules/task/contracts/control"
	observation "github.com/legrch/farol/modules/task/contracts/observation"
	"github.com/legrch/farol/transport/desktop"
)

// Explicit value mapping keeps module DTOs independent from the shared wire.
func taskWireOptional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func taskWireReference(r control.Reference) wire.TaskReference {
	return wire.TaskReference{SessionId: taskWireOptional(r.SessionID), ThreadId: taskWireOptional(r.ThreadID), TurnId: taskWireOptional(r.TurnID), InvocationId: taskWireOptional(r.InvocationID)}
}
func taskWireObservedReference(r observation.Reference) wire.TaskReference {
	return taskWireReference(control.Reference{SessionID: r.SessionID, ThreadID: r.ThreadID, TurnID: r.TurnID, InvocationID: r.InvocationID})
}
func taskWireRoot(r control.Root) wire.TaskRoot {
	return wire.TaskRoot{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
}
func taskWireBinding(b control.Binding) wire.TaskBinding {
	return wire.TaskBinding{Provider: string(b.Provider), ProfileId: b.ProfileID, HostId: b.HostID, ProjectId: b.ProjectID, WorkspaceId: b.WorkspaceID, Project: taskWireRoot(b.Project), Writer: taskWireRoot(b.Writer), ModelAlias: b.ModelAlias, Model: b.Model, Effort: b.Effort, ConfigDigest: b.ConfigDigest}
}
func taskWireResolution(r *control.ResolveResponse) wire.TaskResolution {
	return wire.TaskResolution{Binding: taskWireBinding(r.Binding), Capabilities: wire.TaskCapabilities{Create: r.Capabilities.Create, Continue: r.Capabilities.Continue, Resume: r.Capabilities.Resume, Message: r.Capabilities.Message, Cancel: r.Capabilities.Cancel}}
}
func taskWireReceipt(r control.Receipt) wire.TaskReceipt {
	return wire.TaskReceipt{State: string(r.State), Code: r.Code, Reference: taskWireReference(r.Reference), Lifecycle: taskWireOptional(string(r.Lifecycle)), Result: r.Result, CancelRequested: r.CancelRequested}
}
func taskWireMutation(r *control.MutationResponse) (*desktop.Outcome, error) {
	out, err := taskWireOutcome("TaskMutation", wire.TaskMutation{OperationId: r.OperationID, TaskId: r.TaskID, Receipt: taskWireReceipt(r.Receipt)})
	if err != nil {
		return nil, err
	}
	// The retained receipt's certainty is explicit at the transport boundary.
	switch r.Receipt.State {
	case control.Uncertain:
		out.Status = "unknown"
		out.Code = r.Receipt.Code
	case control.Rejected:
		out.Status = "refused"
		out.Code = r.Receipt.Code
	}
	return out, nil
}
func taskWireStatus(r *control.StatusResponse) wire.TaskStatus {
	return wire.TaskStatus{TaskId: r.TaskID, Binding: taskWireBinding(r.Binding), ParentThreadId: r.Parent.ThreadID, ParentTurnId: r.Parent.TurnID, Reference: taskWireReference(r.Reference), Lifecycle: string(r.Lifecycle), DispatchId: taskWireOptional(r.DispatchID), PendingOperationId: taskWireOptional(r.PendingOperationID), DeliveryDispatchId: taskWireOptional(r.DeliveryDispatchID), CancelRequested: r.CancelRequested}
}
func taskWireDispatch(r *TaskIngressDispatchResponse) wire.TaskDispatch {
	return wire.TaskDispatch{TaskId: r.TaskID, DispatchId: r.DispatchID, Reference: taskWireReference(r.Reference), Lifecycle: string(r.Lifecycle), Pending: r.Pending, Retained: r.Retained, Text: r.Text, ResultEvidence: r.ResultEvidence, Delivery: r.Delivery}
}
func taskWireOperation(r *control.OperationResponse) wire.TaskOperation {
	return wire.TaskOperation{OperationId: r.OperationID, TaskId: r.TaskID, Action: string(r.Action), Lineage: taskWireReference(r.Lineage), Receipt: taskWireReceipt(r.Receipt)}
}
func taskWireObservation(r *observation.Response) wire.TaskObservation {
	events := make([]wire.TaskEvent, 0, len(r.Events))
	for _, e := range r.Events {
		events = append(events, wire.TaskEvent{RunId: e.RunID, DispatchId: e.DispatchID, EventId: e.EventID, StreamId: e.StreamID, Generation: decimal(e.Generation), SourceSequence: decimal(e.SourceSequence), Sequence: decimal(e.Sequence), TimestampMillis: decimal(e.TimestampMillis), Kind: e.Kind, Source: e.Source, ReportedLifecycle: e.ReportedLifecycle, Reference: taskWireObservedReference(e.Reference), ItemId: taskWireOptional(e.ItemID), HasExitCode: e.HasExitCode, ExitCode: int32(e.ExitCode), PlanSteps: uint32(e.PlanSteps), CompletedSteps: uint32(e.CompletedSteps)})
	}
	return wire.TaskObservation{TaskId: r.TaskID, DispatchId: r.DispatchID, Reference: taskWireObservedReference(r.Reference), Events: events, Next: wire.TaskCursor{StreamId: r.Next.StreamID, Generation: decimal(r.Next.Generation), Sequence: decimal(r.Next.Sequence)}, Gap: r.Gap, More: r.More, SourceGap: r.SourceGap, Pending: r.Pending, Retained: r.Retained, Lifecycle: r.Lifecycle, Result: r.Result, ResultEvidence: r.ResultEvidence, Delivery: r.Delivery}
}
