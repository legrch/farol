package mutation

import (
	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// This predicate is used only after the complete inventory and record graph
// have been qualified. It never changes a marker or authorizes a replay.
func selfTestMarkerHasKnownTerminal(marker port.SelfTestMarkerHistoryEntry, parents []port.SelfTestHistoryEntry) bool {
	if marker.Phase == domain.SelfTestMarkerSettling {
		return false
	}
	for _, parent := range parents {
		if parent.Binding == marker.Binding && (parent.Phase == domain.Completed || parent.Phase == domain.Failed) {
			return true
		}
	}
	return false
}
