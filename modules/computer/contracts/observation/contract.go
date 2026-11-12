// Package observation exposes a draft diagnostic DTO, not an authority API.
// It is intentionally not registered with desktop IPC or any Computer tool.
package observation

import (
	"context"
	"errors"
	identityport "github.com/legrch/farol/modules/computer/app/port/observation"
	identitysvc "github.com/legrch/farol/modules/computer/app/services/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

type Request struct {
	Root, Device, Inode, Settlement string
	// Nil means legacy/absent. Non-nil empty, null or malformed are invalid.
	EvidenceJSON []byte
}

type Response struct {
	Classification string
	// This fixed value prevents a candidate classification being presented as
	// an approval. It is NOT a capability, replacement descriptor or receipt.
	Authority string
}
type Failure struct{ Code, Retry string }

func (f *Failure) Error() string { return f.Code }

type Contract struct{ service *identitysvc.Service }

func New(service *identitysvc.Service) *Contract { return &Contract{service: service} }
func refuse(code string) error                   { return &Failure{Code: code, Retry: "never"} }

func (c *Contract) Assess(ctx context.Context, request Request) (*Response, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, refuse("WORKSPACE_REQUEST_CANCELLED")
	}
	// Unknown persisted outcomes are never repaired by parsing/replacing evidence.
	if request.Settlement != string(identity.Settled) {
		return &Response{string(identity.Unresolved), "not-established"}, nil
	}
	saved := identity.Saved{Binding: identity.Binding{Path: request.Root, Device: request.Device, Inode: request.Inode}}
	if request.EvidenceJSON != nil {
		evidence, err := identity.ParseEvidence(request.EvidenceJSON)
		if err != nil {
			return nil, refuse("WORKSPACE_IDENTITY_INVALID")
		}
		saved.Evidence = &evidence
	}
	if c == nil || c.service == nil {
		return nil, refuse("WORKSPACE_IDENTITY_UNAVAILABLE")
	}
	result, err := c.service.Assess(ctx, identitysvc.Request{Saved: saved, Settlement: identity.Settlement(request.Settlement)})
	if err != nil {
		var failure *identityport.Failure
		if errors.As(err, &failure) && failure != nil {
			switch failure.Code {
			case "WORKSPACE_REQUEST_CANCELLED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_RACE_DETECTED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_IDENTITY_UNSUPPORTED", "WORKSPACE_IDENTITY_UNAVAILABLE", "WORKSPACE_IDENTITY_INVALID":
				return nil, refuse(failure.Code)
			}
		}
		return nil, refuse("WORKSPACE_IDENTITY_UNAVAILABLE")
	}
	return &Response{string(result), "not-established"}, nil
}
