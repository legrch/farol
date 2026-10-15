// Package browse publishes independent owner Settings browsing DTOs.
package browse

import (
	"errors"

	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Contract struct{ service *app.Service }

func New(service *app.Service) *Contract { return &Contract{service: service} }

type Root struct{ Path, Device, Inode string }
type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string { return f.Code + " (" + f.Source + ")" }

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
