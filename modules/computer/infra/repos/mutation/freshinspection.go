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
	scratchParents := map[string]*domain.State{}
	cleanupChildren := map[string]*domain.ScratchCleanupState{}
	fileCleanupChildren := map[string]*domain.ScratchFileCleanupState{}
	mutationParents := map[string]*domain.State{}
	seen := map[string]bool{}
	expected := make([]ExpectedPreservedRecord, len(entries))
	for n, entry := range entries {
		if seen[entry.key] {
			return false, preservedRefusal()
		}
		seen[entry.key] = true
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
		var cleanupKey string
		switch {
		case header.Version == 2 && header.Kind == "workspace_owner_mutation", header.Version == 3 && header.Kind == "workspace_connector_mutation", header.Version == scratchVersion && header.Kind == scratchKind:
			state, err := decode(entry.raw)
			if err != nil {
				return false, preservedRefusal()
			}
			identity = state.Binding().Identity
			mutationParents[entry.key] = state
			if header.Version == scratchVersion && header.Kind == scratchKind {
				scratchParents[entry.key] = state
			}
		case header.Version == scratchCleanupVersion && header.Kind == scratchCleanupKind:
			state, err := decodeScratchCleanup(entry.raw)
			if err != nil || state == nil {
				return false, preservedRefusal()
			}
			identity = state.Binding().Creation.Identity
			cleanupKey, err = scratchCleanupKey(identity)
			if err != nil {
				return false, preservedRefusal()
			}
			cleanupChildren[entry.key] = state
		case header.Version == scratchFileCleanupVersion && header.Kind == scratchFileCleanupKind:
			state, err := decodeScratchFileCleanup(entry.raw)
			if err != nil || state == nil {
				return false, preservedRefusal()
			}
			identity = state.Inventory().Creation.Creation.Identity
			cleanupKey, err = scratchCleanupKey(identity)
			if err != nil {
				return false, preservedRefusal()
			}
			fileCleanupChildren[entry.key] = state
		case header.Version == selfTestVersion && header.Kind == selfTestKind:
			state, err := decodeSelfTest(entry.raw)
			if err != nil || state == nil {
				return false, preservedRefusal()
			}
			identity = state.Binding().Identity
			cleanupKey, err = selfTestKey(identity)
			if err != nil {
				return false, preservedRefusal()
			}
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
		if cleanupKey != "" {
			key = cleanupKey
		}
		if err != nil || key != entry.key || identity.OwnerID != selection.OwnerID || identity.ProfileID != selection.ProfileID || identity.ComputerID != selection.ComputerID {
			return false, preservedRefusal()
		}
		expected[n].Identity = identity
	}
	for _, cleanup := range cleanupChildren {
		binding := cleanup.Binding()
		parentKey, err := recordKey(binding.Creation.Identity)
		if err != nil {
			return false, preservedRefusal()
		}
		parent := scratchParents[parentKey]
		if parent == nil || parent.Phase() != domain.Completed || parent.Binding() != binding.Creation || parent.Receipt() == nil || parent.Receipt().Operation != domain.ScratchKind || parent.Receipt().Directory != binding.Directory {
			return false, preservedRefusal()
		}
	}
	for _, cleanup := range fileCleanupChildren {
		inventory := cleanup.Inventory()
		parentKey, err := recordKey(inventory.Creation.Creation.Identity)
		if err != nil {
			return false, preservedRefusal()
		}
		fileKey, err := recordKey(inventory.Mutation.Identity)
		if err != nil {
			return false, preservedRefusal()
		}
		witness, err := domain.NewScratchFileInventory(scratchParents[parentKey], mutationParents[fileKey], inventory.File)
		if err != nil || witness == nil || *witness != inventory {
			return false, preservedRefusal()
		}
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
