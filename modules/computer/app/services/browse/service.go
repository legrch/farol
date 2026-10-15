// Package browse owns the owner Settings workspace browsing queries: bounded
// listing, search and metadata snapshots under current owner approval.
package browse

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Service struct {
	current port.CurrentOwnerApproval
	native  port.Workspace
	clock   port.Clock
}

// Composition supplies concrete nonnil dependencies. CurrentOwnerApproval owns
// synchronization; its callback is synchronous and cannot escape to another goroutine.
func New(current port.CurrentOwnerApproval, native port.Workspace, clock port.Clock) *Service {
	return &Service{current: current, native: native, clock: clock}
}

// Preserve callback failures even if a broken port swallows them. A skipped,
// repeated, late or mutated callback snapshot cannot admit or disclose output.
func (s *Service) withCurrent(ctx context.Context, inspect func(authority.Approval) error) error {
	calls := 0
	closed := false
	var callbackErr error
	var original *authority.Approval
	var captured authority.Approval
	err := s.current.WithCurrent(ctx, func(a *authority.Approval) error {
		if closed {
			return unavailable()
		}
		calls++
		if calls != 1 {
			callbackErr = unavailable()
			return callbackErr
		}
		if a == nil {
			callbackErr = authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-approval")
			return callbackErr
		}
		original, captured = a, a.Clone()
		callbackErr = inspect(captured.Clone())
		return callbackErr
	})
	closed = true
	if calls > 1 || calls == 0 && err == nil {
		return unavailable()
	}
	if callbackErr != nil {
		return callbackErr
	}
	if calls == 1 && (original == nil || !authority.SameApprovalPolicy(*original, captured) || !original.ExpiresAt.Equal(captured.ExpiresAt)) {
		return unavailable()
	}
	if err != nil {
		return currentFailure(err)
	}
	return nil
}

// Preserve classified current-authority refusals, including refusals before a
// snapshot is available. Raw store diagnostics never leave this adapter seam.
func currentFailure(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) && f != nil {
		switch f.Source {
		case "computer-approval", "computer-policy", "authority-store":
			switch f.Code {
			case "COMPUTER_APPROVAL_NOT_FOUND", "COMPUTER_APPROVAL_INVALID", "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
				"COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "AUTHORITY_OWNER_MISMATCH", "AUTHORITY_COMPUTER_MISMATCH",
				"AUTHORITY_EXPIRED", "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED":
				return authority.Fail(f.Code, f.Source)
			}
		}
	}
	return unavailable()
}

func unavailable() error {
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}
func malformed() error { return authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace") }
func active(ctx context.Context, now time.Time) error {
	if ctx == nil || ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	if d, ok := ctx.Deadline(); ok && !now.Before(d) {
		return authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	return nil
}
func liveLease(ctx context.Context, now, deadline time.Time) error {
	if err := active(ctx, now); err != nil {
		return err
	}
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(deadline) {
		return authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	return nil
}
func identifier(v string) bool {
	if v == "" || !utf8.ValidString(v) {
		return false
	}
	units := 0
	for _, r := range v {
		if r < 32 || r == 127 {
			return false
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	return units <= 120
}
func relative(v string) bool {
	if v == "." {
		return true
	}
	if v == "" || !utf8.ValidString(v) || len(v) > 4096 || strings.Contains(v, "\\") {
		return false
	}
	parts := strings.Split(v, "/")
	if len(parts) > 256 {
		return false
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || len(p) > 255 {
			return false
		}
		for _, r := range p {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}
func join(root, relative string) string {
	if relative == "." {
		return root
	}
	return root + "/" + relative
}
