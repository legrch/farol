package mutation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Historical process uncertainty is an observation, never permission to replay
// or proof of cleanup. Fresh startup holds the old core and MCP owner locks.
func qualifyFreshProcessHistory(entries []settledBytes, selection SettledSelection) (bool, error) {
	if len(entries) > maxPreservedRecords || !domain.Identifier(selection.OwnerID, 160) || !domain.Identifier(selection.ProfileID, 160) || !domain.Identifier(selection.ComputerID, 160) {
		return false, preservedRefusal()
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
			return false, preservedRefusal()
		}
		digest := sha256.Sum256(entry.raw)
		expected[n] = ExpectedPreservedRecord{Key: entry.key, SHA256: hex.EncodeToString(digest[:])}
		var identity domain.Identity
		switch {
		case header.Version == 2 && header.Kind == "workspace_owner_mutation", header.Version == 3 && header.Kind == "workspace_connector_mutation":
			state, err := decode(entry.raw)
			if err != nil {
				return false, preservedRefusal()
			}
			identity = state.Binding().Identity
		case header.Version == 4 && header.Kind == "workspace_connector_process":
			scope, intent, err := decodeProcess(entry.raw)
			if err != nil {
				return false, preservedRefusal()
			}
			identity = processIdentity(scope, intent.OperationID)
			if intent.Seal.Write {
				unknownWrite = true
			}
		case (header.Version == 5 || header.Version == 6) && header.Kind == "workspace_connector_process_terminal":
			result, _, err := decodeProcessTerminal(entry.raw)
			if err != nil || result == nil {
				return false, preservedRefusal()
			}
			identity = processIdentity(result.Scope, result.Intent.OperationID)
			parents[entry.key] = identity
			if result.Intent.Seal.Write && !processTerminalGroupConfirmed(result) {
				unknownWrite = true
			}
		case header.Version == 5 && header.Kind == "workspace_connector_process_output":
			// The existing terminal/output validator below binds every chunk to
			// its complete parent result, digest and original identity.
			continue
		default:
			return false, preservedRefusal()
		}
		key, err := recordKey(identity)
		if err != nil || key != entry.key || identity.OwnerID != selection.OwnerID || identity.ProfileID != selection.ProfileID || identity.ComputerID != selection.ComputerID {
			return false, preservedRefusal()
		}
		expected[n].Identity = identity
	}
	for n, entry := range entries {
		if expected[n].Identity.OwnerID != "" {
			continue
		}
		var envelope processOutputEnvelope
		if decodeStrict(entry.raw, &envelope) != nil {
			return false, preservedRefusal()
		}
		identity, ok := parents[envelope.Record.Parent]
		if !ok {
			return false, preservedRefusal()
		}
		expected[n].Identity, expected[n].OutputParent = identity, envelope.Record.Parent
	}
	if qualifyRetainedProcessOutputs(entries, expected, true) != nil {
		return false, preservedRefusal()
	}
	if unknownWrite {
		return true, nil
	}
	return false, nil
}
