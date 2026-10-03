package workspace

import (
	"context"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
)

type BootstrapRequest struct {
	OwnerID, SessionID, TaskID             string
	TaskEpoch                              uint64
	ParticipantID, TurnID                  string
	Generation                             uint64
	CallID, WorkspaceID, RelativeDirectory string
}

// Core maps these independent closed variants explicitly to the existing wire
// statuses read, not_found and unavailable. Do not blindly serialize app values.
type Instruction interface{ instruction() }
type ReadInstruction struct {
	RelativePath, Text string
	Bytes              uint64
}
type MissingInstruction struct{ RelativePath string }
type UnavailableInstruction struct{ RelativePath, Code string }

func (ReadInstruction) instruction()        {}
func (MissingInstruction) instruction()     {}
func (UnavailableInstruction) instruction() {}

type BootstrapResponse struct {
	OwnerID, SessionID, TaskID               string
	TaskEpoch                                uint64
	ParticipantID, TurnID                    string
	Generation                               uint64
	CallID, WorkspaceID, RelativeDirectory   string
	Root                                     string
	ApprovedRoot                             Root
	Scope, Coverage, Consistency, Precedence string
	Complete                                 bool
	Instructions                             []Instruction
}

func (c *Contract) Bootstrap(ctx context.Context, request BootstrapRequest) (*BootstrapResponse, error) {
	out, err := c.service.Bootstrap(ctx, workspacesvc.BootstrapRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativeDirectory: request.RelativeDirectory})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	instructions := make([]Instruction, 0, len(out.Instructions))
	for _, instruction := range out.Instructions {
		switch value := instruction.(type) {
		case workspacesvc.ReadInstruction:
			instructions = append(instructions, ReadInstruction{RelativePath: value.RelativePath, Text: value.Text, Bytes: value.Bytes})
		case workspacesvc.MissingInstruction:
			instructions = append(instructions, MissingInstruction{RelativePath: value.RelativePath})
		case workspacesvc.UnavailableInstruction:
			instructions = append(instructions, UnavailableInstruction{RelativePath: value.RelativePath, Code: value.Code})
		default:
			return nil, &Failure{Code: "COMPUTER_CONTRACT_INVALID", Source: "contract", Retry: "never"}
		}
	}
	return &BootstrapResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch, ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, WorkspaceID: out.WorkspaceID, RelativeDirectory: out.RelativeDirectory, Root: out.Root, ApprovedRoot: Root{Path: out.ApprovedRoot.Path, Device: out.ApprovedRoot.Device, Inode: out.ApprovedRoot.Inode}, Scope: out.Scope, Complete: out.Complete, Instructions: instructions, Coverage: out.Coverage, Consistency: out.Consistency, Precedence: out.Precedence}, nil
}
