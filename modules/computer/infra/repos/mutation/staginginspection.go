package mutation

import (
	"encoding/json"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// qualifyStagingHistory is a denial-only observation over the already bounded
// original inventory. It neither changes records nor grants new Shell authority.
// It is stricter than fresh startup: group-only cleanup does not prove that a
// previous writable process cannot still reach staging. A current runtime may
// separately establish protections for its own processes; old opaque seals do
// not supply that fact.
func qualifyStagingHistory(entries []settledBytes, selection SettledSelection) (bool, error) {
	unknown, err := qualifyFreshProcessHistory(entries, selection)
	if err != nil || unknown {
		return false, err
	}
	for _, entry := range entries {
		var header struct {
			Version uint8           `json:"schemaVersion"`
			Kind    string          `json:"kind"`
			Record  json.RawMessage `json:"record"`
		}
		if decodeStrict(entry.raw, &header) != nil {
			return false, preservedRefusal()
		}
		switch {
		case header.Version == scratchFileCleanupVersion && header.Kind == scratchFileCleanupKind:
			state, err := decodeScratchFileCleanup(entry.raw)
			if err != nil || state == nil {
				return false, preservedRefusal()
			}
			if state.Phase() == domain.Prepared || state.Phase() == domain.OutcomeUnknown {
				return false, nil
			}
		case header.Version == scratchCleanupVersion && header.Kind == scratchCleanupKind:
			state, err := decodeScratchCleanup(entry.raw)
			if err != nil || state == nil {
				return false, preservedRefusal()
			}
			if state.Phase() == domain.Prepared || state.Phase() == domain.OutcomeUnknown {
				return false, nil
			}
		case header.Version == scratchVersion && header.Kind == scratchKind:
			state, err := decode(entry.raw)
			if err != nil || state == nil {
				return false, preservedRefusal()
			}
			if state.Phase() == domain.Prepared || state.Phase() == domain.OutcomeUnknown {
				return false, nil
			}
		case header.Version == 4 && header.Kind == "workspace_connector_process":
			_, intent, err := decodeProcess(entry.raw)
			if err != nil {
				return false, preservedRefusal()
			}
			if intent.Seal.Write {
				return false, nil
			}
		case (header.Version == 5 || header.Version == 6) && header.Kind == "workspace_connector_process_terminal":
			result, _, err := decodeProcessTerminal(entry.raw)
			if err != nil || result == nil {
				return false, preservedRefusal()
			}
			if result.Intent.Seal.Write && (!processTerminalAllCleanupConfirmed(result)) {
				return false, nil
			}
		}
	}
	return true, nil
}
