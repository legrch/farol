// Package settingsworkspace publishes independent owner Settings listing DTOs.
package settingsworkspace

import (
	"context"
	"errors"
	"slices"

	app "github.com/legrch/farol/modules/computer/app/services/settingsworkspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Contract struct{ service *app.Service }

func New(service *app.Service) *Contract { return &Contract{service: service} }

type Request struct{ WorkspaceID, RelativePath string }
type Root struct{ Path, Device, Inode string }
type Result struct {
	WorkspaceID, RelativePath string
	Root                      Root
	Entries                   []string
	Truncated                 bool
}
type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string { return f.Code + " (" + f.Source + ")" }

func (c *Contract) List(ctx context.Context, request Request) (*Result, error) {
	if c == nil || c.service == nil {
		return nil, failure(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
	}
	out, err := c.service.List(ctx, app.Request{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &Result{WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath,
		Root:    Root{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode},
		Entries: slices.Clone(out.Entries), Truncated: out.Truncated}, nil
}
func failure(err error) error {
	var classified *authority.Failure
	if errors.As(err, &classified) && classified != nil && codes[classified.Code] && sources[classified.Source] {
		return &Failure{Code: classified.Code, Source: classified.Source, Retry: "never"}
	}
	return &Failure{Code: "WORKSPACE_HELPER_FAILED", Source: "native-workspace", Retry: "never"}
}

var codes = map[string]bool{
	"COMPUTER_APPROVAL_INVALID": true, "COMPUTER_APPROVAL_NOT_FOUND": true,
	"COMPUTER_APPROVAL_STORE_UNAVAILABLE": true, "AUTHORITY_OWNER_MISMATCH": true,
	"COMPUTER_AUTHORITY_STORE_UNAVAILABLE": true, "COMPUTER_INVALID_REQUEST": true,
	"COMPUTER_PATH_INVALID": true, "AUTHORITY_EXPIRED": true,
	"AUTHORITY_CAPABILITY_DENIED": true, "AUTHORITY_PATH_DENIED": true,
	"AUTHORITY_COMPUTER_MISMATCH": true,
	"WORKSPACE_INVALID_REQUEST":   true, "WORKSPACE_POLICY_TOO_LARGE": true,
	"WORKSPACE_REQUEST_CANCELLED": true, "WORKSPACE_PATH_REFUSED": true,
	"WORKSPACE_ROOT_CHANGED": true, "WORKSPACE_NOT_FOUND": true,
	"WORKSPACE_RACE_DETECTED": true, "WORKSPACE_HELPER_FAILED": true,
	"WORKSPACE_FILE_TOO_LARGE": true, "WORKSPACE_NOT_TEXT": true, "WORKSPACE_NOT_A_FILE": true,
	"WORKSPACE_SEARCH_TIMEOUT": true,
}
var sources = map[string]bool{
	"computer-approval": true, "authority-store": true,
	"computer-policy":  true,
	"native-workspace": true, "contract": true,
}
