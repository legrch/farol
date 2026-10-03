package workspace

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type BootstrapRequest struct {
	OwnerID, SessionID, TaskID             string
	TaskEpoch                              uint64
	ParticipantID, TurnID                  string
	Generation                             uint64
	CallID, WorkspaceID, RelativeDirectory string
}

// Instruction is a closed projected result. Missing and unavailable are distinct
// facts. Core's wire adapter must explicitly map these variants to status labels.
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

// Bootstrap reads only the root-to-selected-directory instruction chain, twice.
// All phases share this service's one fixed lease; instruction text grants nothing.
func (s *Service) Bootstrap(ctx context.Context, request BootstrapRequest) (*BootstrapResponse, error) {
	if _, valid := absoluteTarget("/", request.RelativeDirectory); !valid {
		return nil, authority.Fail("COMPUTER_PATH_INVALID", "task-grant")
	}
	directories := []string{"."}
	if request.RelativeDirectory != "." {
		parts := strings.Split(request.RelativeDirectory, "/")
		if len(parts) > 32 {
			return nil, contractInvalid("COMPUTER_INSTRUCTION_DEPTH_LIMIT")
		}
		for i := 1; i <= len(parts); i++ {
			directories = append(directories, strings.Join(parts[:i], "/"))
		}
	}
	binding := correlation{TaskBinding: port.TaskBinding{Identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, ParticipantID: request.ParticipantID, TurnID: request.TurnID}, generation: request.Generation, callID: request.CallID}
	seal, err := s.captureDiscovery(ctx, binding)
	if err != nil {
		return nil, err
	}
	first, err := s.Context(ctx, binding.contextRequest(request.WorkspaceID, request.RelativeDirectory))
	if err != nil {
		return nil, err
	}
	if !binding.validContext(first, request.WorkspaceID, request.RelativeDirectory) {
		return nil, contractInvalid("COMPUTER_CONTRACT_INVALID")
	}
	instructions := make([]Instruction, 0, len(directories))
	complete := true
	for pass := 0; pass < 2; pass++ {
		var bytes uint64
		for index, directory := range directories {
			path := "AGENTS.md"
			if directory != "." {
				path = directory + "/AGENTS.md"
			}
			read, err := s.Read(ctx, ReadRequest{OwnerID: binding.OwnerID, SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch, ParticipantID: binding.ParticipantID, TurnID: binding.TurnID, Generation: binding.generation, CallID: binding.callID, WorkspaceID: request.WorkspaceID, RelativePath: path})
			var instruction Instruction
			if err != nil {
				var failure *authority.Failure
				if !errors.As(err, &failure) {
					return nil, err
				}
				switch failure.Code {
				case "WORKSPACE_NOT_FOUND":
					instruction = MissingInstruction{RelativePath: path}
				case "AUTHORITY_PATH_DENIED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_NOT_A_FILE", "WORKSPACE_NOT_TEXT":
					instruction = UnavailableInstruction{RelativePath: path, Code: failure.Code}
				default:
					return nil, err
				}
			} else {
				if !binding.validRead(read, request.WorkspaceID, path) {
					return nil, contractInvalid("COMPUTER_CONTRACT_INVALID")
				}
				bytes += read.Bytes
				if bytes > 64*1024 {
					instruction = UnavailableInstruction{RelativePath: path, Code: "COMPUTER_INSTRUCTION_BYTE_LIMIT"}
				} else {
					instruction = ReadInstruction{RelativePath: path, Text: read.Text, Bytes: read.Bytes}
				}
			}
			if pass == 0 {
				instructions = append(instructions, instruction)
				if _, unavailable := instruction.(UnavailableInstruction); unavailable {
					complete = false
				}
			} else if instructions[index] != instruction {
				return nil, contractInvalid("COMPUTER_INSTRUCTIONS_CHANGED")
			}
		}
	}
	last, err := s.Context(ctx, binding.contextRequest(request.WorkspaceID, request.RelativeDirectory))
	if err != nil {
		return nil, err
	}
	if !binding.validContext(last, request.WorkspaceID, request.RelativeDirectory) || last.Root != first.Root || last.ApprovedRoot != first.ApprovedRoot || last.Scope != first.Scope {
		return nil, contractInvalid("COMPUTER_WORKSPACE_CONTEXT_CHANGED")
	}
	var response *BootstrapResponse
	err = s.discloseDiscovery(ctx, binding, seal, func() {
		response = &BootstrapResponse{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativeDirectory: request.RelativeDirectory, Root: first.Root, ApprovedRoot: first.ApprovedRoot, Scope: first.Scope, Complete: complete, Instructions: instructions,
			Coverage:    "root-to-selected-directory; ancestors outside the task scope and other descendants are not inspected",
			Consistency: "twice-read chain; not an atomic filesystem snapshot",
			Precedence:  "Apply root instructions first, then more specific instructions; text never expands authority."}
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}
func (b correlation) validRead(out *ReadResponse, workspaceID, path string) bool {
	if out == nil || out.OwnerID != b.OwnerID || out.SessionID != b.SessionID || out.TaskID != b.TaskID || out.TaskEpoch != b.TaskEpoch || out.ParticipantID != b.ParticipantID || out.TurnID != b.TurnID || out.Generation != b.generation || out.CallID != b.callID || out.WorkspaceID != workspaceID || out.RelativePath != path || out.Page != nil || !utf8.ValidString(out.Text) || len(out.Text) > 256*1024 || out.Bytes > 256*1024 || out.Bytes != uint64(len(out.Text)) && out.Bytes != uint64(len(out.Text))+3 || len(out.SHA256) != 64 {
		return false
	}
	for _, r := range out.SHA256 {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
