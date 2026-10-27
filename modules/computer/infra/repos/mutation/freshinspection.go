package mutation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// ErrFreshProcessScopeUnavailable refuses ambiguous writable legacy processes.
// The retained seal names cwd, not the complete originally writable root set.
// Neither flock nor supervisor exit may supply missing group cleanup facts.
var ErrFreshProcessScopeUnavailable = errors.New("FRESH_SESSION_PROCESS_SCOPE_UNAVAILABLE")

func qualifyFreshProcessHistory(entries []settledBytes, selection SettledSelection) error {
	if len(entries) > maxPreservedRecords || !domain.Identifier(selection.OwnerID, 160) || !domain.Identifier(selection.ProfileID, 160) || !domain.Identifier(selection.ComputerID, 160) {
		return preservedRefusal()
	}
	unknownWrite := false
	parents := map[string]domain.Identity{}
	expected := make([]ExpectedPreservedRecord, len(entries))
	for n, entry := range entries {
		var header struct {
			Version uint8           `json:"schemaVersion"`
			Kind    string          `json:"kind"`
			Record  json.RawMessage `json:"record"`
		}
		if decodeStrict(entry.raw, &header) != nil {
			return preservedRefusal()
		}
		digest := sha256.Sum256(entry.raw)
		expected[n] = ExpectedPreservedRecord{Key: entry.key, SHA256: hex.EncodeToString(digest[:])}
		var identity domain.Identity
		switch {
		case header.Version == 2 && header.Kind == "workspace_owner_mutation", header.Version == 3 && header.Kind == "workspace_connector_mutation":
			state, err := decode(entry.raw)
			if err != nil {
				return preservedRefusal()
			}
			identity = state.Binding().Identity
		case header.Version == 4 && header.Kind == "workspace_connector_process":
			scope, intent, err := decodeProcess(entry.raw)
			if err != nil {
				return preservedRefusal()
			}
			identity = processIdentity(scope, intent.OperationID)
			if intent.Seal.Write {
				unknownWrite = true
			}
		case (header.Version == 5 || header.Version == 6) && header.Kind == "workspace_connector_process_terminal":
			result, _, err := decodeProcessTerminal(entry.raw)
			if err != nil || result == nil {
				return preservedRefusal()
			}
			identity = processIdentity(result.Scope, result.Intent.OperationID)
			parents[entry.key] = identity
			if result.Intent.Seal.Write && !processTerminalCleanupConfirmed(result) {
				unknownWrite = true
			}
		case header.Version == 5 && header.Kind == "workspace_connector_process_output":
			// The existing terminal/output validator below binds every chunk to
			// its complete parent result, digest and original identity.
			continue
		default:
			return preservedRefusal()
		}
		key, err := recordKey(identity)
		if err != nil || key != entry.key || identity.OwnerID != selection.OwnerID || identity.ProfileID != selection.ProfileID || identity.ComputerID != selection.ComputerID {
			return preservedRefusal()
		}
		expected[n].Identity = identity
	}
	for n, entry := range entries {
		if expected[n].Identity.OwnerID != "" {
			continue
		}
		var envelope processOutputEnvelope
		if decodeStrict(entry.raw, &envelope) != nil {
			return preservedRefusal()
		}
		identity, ok := parents[envelope.Record.Parent]
		if !ok {
			return preservedRefusal()
		}
		expected[n].Identity, expected[n].OutputParent = identity, envelope.Record.Parent
	}
	if qualifyRetainedProcessOutputs(entries, expected, true) != nil {
		return preservedRefusal()
	}
	if unknownWrite {
		return ErrFreshProcessScopeUnavailable
	}
	return nil
}
