package boot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"strconv"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
)

// This independent boundary projection maps the existing owner-settings approval
// losslessly. It establishes no consent, grant, filesystem identity or live owner;
// only trusted host publication may supply it, and Store revalidates it again.
type desktopApproval struct {
	OwnerID       string                     `json:"ownerId"`
	ComputerID    string                     `json:"computerId"`
	Generation    json.Number                `json:"generation"`
	Workspaces    []desktopApprovedWorkspace `json:"workspaces"`
	ExcludedPaths []desktopApprovalExclusion `json:"excludedPaths"`
	Capabilities  []authority.Capability     `json:"capabilities"`
	Network       authority.Network          `json:"network"`
	Commands      authority.Commands         `json:"commands"`
	ExpiresAt     json.Number                `json:"expiresAt"`
}
type desktopApprovedWorkspace struct {
	WorkspaceID  string           `json:"workspaceId"`
	Root         string           `json:"root"`
	Access       authority.Access `json:"access"`
	RootIdentity struct {
		Device string `json:"device"`
		Inode  string `json:"inode"`
	} `json:"rootIdentity"`
	GitMetadata        *desktopApprovedGit `json:"gitMetadata,omitempty"`
	GitHistoryApproved bool                `json:"gitHistoryApproved,omitempty"`
	ShellVerified      bool                `json:"shellVerified,omitempty"`
}
type desktopApprovedGit struct {
	GitDirectory    string `json:"gitDirectory"`
	CommonDirectory string `json:"commonDirectory"`
}
type desktopApprovalExclusion struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

func invalidDesktopApproval() error { return fmt.Errorf("COMPUTER_APPROVAL_INPUT_INVALID") }
func jsonHasNull(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case map[string]any:
		for _, x := range v {
			if jsonHasNull(x) {
				return true
			}
		}
	case []any:
		for _, x := range v {
			if jsonHasNull(x) {
				return true
			}
		}
	}
	return false
}
func safePositiveInteger(number json.Number) (uint64, error) {
	value, ok := new(big.Rat).SetString(string(number))
	if !ok || !value.IsInt() || value.Sign() <= 0 || value.Num().BitLen() > 53 {
		return 0, invalidDesktopApproval()
	}
	n := value.Num().Uint64()
	if n > 9007199254740991 {
		return 0, invalidDesktopApproval()
	}
	return n, nil
}
func parseDesktopApproval(raw json.RawMessage, ownerID, computerID string) (authority.Approval, error) {
	invalid := func() (authority.Approval, error) { return authority.Approval{}, invalidDesktopApproval() }
	if len(raw) > 1048576 || ipc.ValidateJSON(raw) != nil || wire.Validate("json", raw) != nil {
		return invalid()
	}
	var shape any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&shape) != nil || jsonHasNull(shape) {
		return invalid()
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	var input desktopApproval
	if decoder.Decode(&input) != nil {
		return invalid()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return invalid()
	}
	if input.OwnerID != ownerID || input.ComputerID != computerID || !validIngressID(input.OwnerID) || !validIngressID(input.ComputerID) || len(input.Workspaces) < 1 || len(input.Workspaces) > 32 || len(input.ExcludedPaths) > 32 || len(input.Capabilities) < 1 || len(input.Capabilities) > 6 {
		return invalid()
	}
	generation, e := safePositiveInteger(input.Generation)
	if e != nil {
		return invalid()
	}
	expiry, e := safePositiveInteger(input.ExpiresAt)
	if e != nil {
		return invalid()
	}
	output := authority.Approval{OwnerID: ownerID, ComputerID: computerID, Generation: generation, Capabilities: append([]authority.Capability(nil), input.Capabilities...), Network: input.Network, Commands: input.Commands, ExpiresAt: time.UnixMilli(int64(expiry)).UTC()}
	if input.Network != authority.NoNetwork && input.Network != authority.ApprovedNetwork {
		return invalid()
	}
	if input.Commands != authority.NoCommands && input.Commands != authority.VerificationCommands && input.Commands != authority.WorkspaceCommands {
		return invalid()
	}
	capabilities := make(map[authority.Capability]bool)
	for _, capability := range input.Capabilities {
		switch capability {
		case authority.List, authority.Read, authority.Search, authority.Verify, authority.Write, authority.Shell:
		default:
			return invalid()
		}
		if capabilities[capability] {
			return invalid()
		}
		capabilities[capability] = true
	}
	workspaces := make(map[string]bool)
	for _, w := range input.Workspaces {
		if !validIngressID(w.WorkspaceID) || workspaces[w.WorkspaceID] || (w.Access != authority.ReadAccess && w.Access != authority.WriteAccess) {
			return invalid()
		}
		workspaces[w.WorkspaceID] = true
		for _, id := range []string{w.RootIdentity.Device, w.RootIdentity.Inode} {
			if validateIngress("decimal", id) != nil || id == "0" {
				return invalid()
			}
			if _, e := strconv.ParseUint(id, 10, 64); e != nil {
				return invalid()
			}
		}
		workspace := authority.ApprovedWorkspace{WorkspaceID: w.WorkspaceID, Root: w.Root, Access: w.Access, RootIdentity: authority.RootIdentity{Device: w.RootIdentity.Device, Inode: w.RootIdentity.Inode}, GitHistoryApproved: w.GitHistoryApproved, ShellVerified: w.ShellVerified}
		if w.GitMetadata != nil {
			workspace.GitMetadata = &authority.GitMetadata{GitDirectory: w.GitMetadata.GitDirectory, CommonDirectory: w.GitMetadata.CommonDirectory}
		}
		output.Workspaces = append(output.Workspaces, workspace)
	}
	exclusions := make(map[string]bool)
	for _, x := range input.ExcludedPaths {
		key := x.WorkspaceID + "\x00" + x.Path
		if !workspaces[x.WorkspaceID] || exclusions[key] {
			return invalid()
		}
		exclusions[key] = true
		output.ExcludedPaths = append(output.ExcludedPaths, authority.Exclusion{WorkspaceID: x.WorkspaceID, Path: x.Path, RestrictionSource: authority.ComputerApprovalSource})
	}
	return output, nil
}
