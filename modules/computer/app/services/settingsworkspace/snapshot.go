package settingsworkspace

import (
	"context"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type SnapshotResult struct {
	WorkspaceID, RelativePath string
	Root                      port.Root
	Bytes                     uint64
	SHA256                    string
}

// Snapshot discloses metadata for one full native read under current owner read
// approval and a fixed lease. The native adapter owns physical root/path checks
// and the raw-byte digest; response validation is not independent native proof.
func (s *Service) Snapshot(ctx context.Context, request Request) (*SnapshotResult, error) {
	if s == nil || s.current == nil || s.native == nil || s.clock == nil {
		return nil, unavailable()
	}
	if err := active(ctx, s.clock.Now()); err != nil {
		return nil, err
	}
	if !identifier(request.WorkspaceID) || !relative(request.RelativePath) || request.RelativePath == "." {
		return nil, authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	var initial authority.Approval
	var descriptor port.Descriptor
	var target string
	var deadline time.Time
	err := s.withCurrent(ctx, func(a authority.Approval) error {
		now := s.clock.Now()
		if err := active(ctx, now); err != nil {
			return err
		}
		w, found := authority.FindApproved(a, request.WorkspaceID)
		if !found {
			return authority.Fail("AUTHORITY_PATH_DENIED", "computer-approval")
		}
		target = join(w.Root, request.RelativePath)
		if err := authority.AuthorizeOwnerRead(a, request.WorkspaceID, target, now); err != nil {
			return err
		}
		initial = a.Clone()
		deadline = now.Add(authority.OrdinaryExecutionLifetime)
		if a.ExpiresAt.Before(deadline) {
			deadline = a.ExpiresAt
		}
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		descriptor = port.Descriptor{FilePolicy: a.FilePolicy, WorkspaceID: w.WorkspaceID, Root: w.Root,
			ApprovedRoot: port.Root{Path: w.Root, Device: w.RootIdentity.Device, Inode: w.RootIdentity.Inode}}
		for _, e := range a.ExcludedPaths {
			if e.WorkspaceID == w.WorkspaceID && authority.Within(w.Root, e.Path) && e.Path != w.Root {
				descriptor.DeniedPaths = append(descriptor.DeniedPaths, strings.TrimPrefix(e.Path, w.Root+"/"))
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := liveLease(ctx, s.clock.Now(), deadline); err != nil {
		return nil, err
	}
	readRequest := port.ReadRequest{Workspace: descriptor, RelativePath: request.RelativePath}
	readRequest.Workspace.DeniedPaths = slices.Clone(descriptor.DeniedPaths)
	checked, err := s.native.Read(ctx, readRequest)
	if err != nil {
		return nil, snapshotNativeFailure(err)
	}
	if !fullSnapshot(checked) {
		return nil, malformed()
	}
	// Capture values before the final authority callback; never disclose text.
	bytes, digest := checked.Bytes, checked.SHA256
	var result *SnapshotResult
	err = s.withCurrent(ctx, func(current authority.Approval) error {
		now := s.clock.Now()
		if err := liveLease(ctx, now, deadline); err != nil {
			return err
		}
		if !authority.SameApprovalPolicy(initial, current) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
		}
		if err := authority.AuthorizeOwnerRead(current, request.WorkspaceID, target, now); err != nil {
			return err
		}
		result = &SnapshotResult{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath,
			Root: descriptor.ApprovedRoot, Bytes: bytes, SHA256: digest}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := liveLease(ctx, s.clock.Now(), deadline); err != nil {
		return nil, err
	}
	return result, nil
}

func fullSnapshot(r *port.ReadResponse) bool {
	if r == nil || r.Page != nil || r.Bytes > 256*1024 || len(r.SHA256) != 64 ||
		!utf8.ValidString(r.Text) || strings.ContainsRune(r.Text, 0) {
		return false
	}
	if _, err := hex.DecodeString(r.SHA256); err != nil {
		return false
	}
	textBytes := uint64(len(r.Text))
	// Native strips exactly one initial UTF-8 BOM from text, while Bytes and
	// SHA256 cover all raw bytes. Never substitute a hash of the decoded text.
	return r.Bytes == textBytes && !strings.HasPrefix(r.Text, "\ufeff") || r.Bytes == textBytes+3
}

func snapshotNativeFailure(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) && f != nil && f.Source == "native-workspace" {
		switch f.Code {
		case "WORKSPACE_INVALID_REQUEST", "WORKSPACE_POLICY_TOO_LARGE", "WORKSPACE_REQUEST_CANCELLED",
			"WORKSPACE_PATH_REFUSED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_NOT_FOUND",
			"WORKSPACE_RACE_DETECTED", "WORKSPACE_HELPER_FAILED", "WORKSPACE_FILE_TOO_LARGE",
			"WORKSPACE_NOT_TEXT", "WORKSPACE_NOT_A_FILE":
			return authority.Fail(f.Code, f.Source)
		}
	}
	return malformed()
}
