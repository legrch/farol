// Package workspace publishes independent in-process Computer read contracts.
// Wire parsing and decimal-string encoding belong to the Core adapter.
package workspace

import (
	"context"
	"errors"
	"slices"

	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Contract struct{ service *workspacesvc.Service }

func New(service *workspacesvc.Service) *Contract { return &Contract{service: service} }

// Failure is safe to cross the module boundary. No raw native error is exposed.
type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string { return f.Code + " (" + f.Source + ")" }
func failure(err error) error {
	var classified *authority.Failure
	if errors.As(err, &classified) && codes[classified.Code] && sources[classified.Source] {
		return &Failure{Code: classified.Code, Source: classified.Source, Retry: "never"}
	}
	return &Failure{Code: "WORKSPACE_HELPER_FAILED", Source: "native-workspace", Retry: "never"}
}

var codes = map[string]bool{
	"COMPUTER_WORKSPACE_CATALOGUE_INVALID": true, "COMPUTER_WORKSPACE_CONTEXT_CHANGED": true, "COMPUTER_CONTRACT_INVALID": true,
	"COMPUTER_INSTRUCTION_DEPTH_LIMIT": true, "COMPUTER_INSTRUCTIONS_CHANGED": true, "COMPUTER_INSTRUCTION_BYTE_LIMIT": true,
	"AUTHORITY_OWNER_MISMATCH": true, "AUTHORITY_TASK_MISMATCH": true, "AUTHORITY_COMPUTER_MISMATCH": true,
	"AUTHORITY_EXPIRED": true, "AUTHORITY_INFLATION_DENIED": true, "AUTHORITY_CAPABILITY_DENIED": true, "AUTHORITY_PATH_DENIED": true,
	"AUTHORITY_NETWORK_DENIED": true, "AUTHORITY_COMMAND_DENIED": true, "AUTHORITY_MUTATION_OWNERSHIP_DENIED": true,
	"COMPUTER_PARTICIPANT_NOT_FOUND": true, "COMPUTER_APPROVAL_NOT_FOUND": true, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE": true,
	"COMPUTER_APPROVAL_STORE_UNAVAILABLE": true, "COMPUTER_PATH_INVALID": true, "COMPUTER_INVALID_REQUEST": true,
	"WORKSPACE_INVALID_REQUEST": true, "WORKSPACE_POLICY_TOO_LARGE": true, "WORKSPACE_REQUEST_CANCELLED": true,
	"WORKSPACE_PATH_REFUSED": true, "WORKSPACE_ROOT_CHANGED": true, "WORKSPACE_NOT_FOUND": true, "WORKSPACE_NOT_A_FILE": true,
	"WORKSPACE_FILE_TOO_LARGE": true, "WORKSPACE_RACE_DETECTED": true, "WORKSPACE_NOT_TEXT": true, "WORKSPACE_HELPER_FAILED": true,
}
var sources = map[string]bool{
	"computer-approval": true, "task-admission": true, "task-grant": true, "owner-restriction": true, "unverified-provenance": true,
	"role": true, "computer-policy": true, "native-host": true, "authority-store": true, "native-workspace": true, "contract": true,
}

type Range struct {
	Offset uint64
	Length uint32
}
type Page struct {
	Offset, Size uint64
	NextOffset   *uint64
}
type ReadRequest struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Range                             *Range
}
type ReadResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Text                              string
	Bytes                             uint64
	SHA256                            string
	Page                              *Page
}

func (c *Contract) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	app := workspacesvc.ReadRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch,
		ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath}
	if request.Range != nil {
		app.Range = &workspacesvc.Range{Offset: request.Range.Offset, Length: request.Range.Length}
	}
	out, err := c.service.Read(ctx, app)
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	result := &ReadResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch,
		ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, WorkspaceID: out.WorkspaceID,
		RelativePath: out.RelativePath, Text: out.Text, Bytes: out.Bytes, SHA256: out.SHA256}
	if out.Page != nil {
		result.Page = &Page{Offset: out.Page.Offset, Size: out.Page.Size}
		if out.Page.NextOffset != nil {
			next := *out.Page.NextOffset
			result.Page.NextOffset = &next
		}
	}
	return result, nil
}

type ListRequest struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
}
type ListResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Entries                           []string
	Truncated                         bool
}

func (c *Contract) List(ctx context.Context, request ListRequest) (*ListResponse, error) {
	out, err := c.service.List(ctx, workspacesvc.ListRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch,
		ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &ListResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch,
		ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, WorkspaceID: out.WorkspaceID,
		RelativePath: out.RelativePath, Entries: slices.Clone(out.Entries), Truncated: out.Truncated}, nil
}
