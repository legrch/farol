package mutation

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"slices"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const maxSelfTestInventory = 4096
const maxSelfTestHistory = 256
const maxSelfTestInventoryBytes = 32 * 1024 * 1024

type historyKeys interface{ keys() ([]string, error) }

// ListSelfTests observes a complete, twice-checked journal snapshot under the
// retained writer owner. It never changes a phase, creates a permit or returns
// the contents of other operations. Unreadable inventory fails closed.
// The two passes detect concurrent changes; they do not provide an atomic
// snapshot against a noncooperating process running as the same user.
func (r *Repository) ListSelfTests(ctx context.Context, owner, profile, computer string) ([]port.SelfTestHistoryEntry, error) {
	return r.listSelfTestInventory(ctx, owner, profile, computer, nil)
}

func (r *Repository) ListSelfTestMarkers(ctx context.Context, owner, profile, computer string) ([]port.SelfTestMarkerHistoryEntry, error) {
	markers := make([]port.SelfTestMarkerHistoryEntry, 0)
	if _, err := r.listSelfTestInventory(ctx, owner, profile, computer, &markers); err != nil {
		return nil, err
	}
	return markers, nil
}

type selfTestInventoryStats struct {
	names []string
	bytes int
}

func (r *Repository) listSelfTestInventory(ctx context.Context, owner, profile, computer string, markers *[]port.SelfTestMarkerHistoryEntry) ([]port.SelfTestHistoryEntry, error) {
	if r == nil || !domain.Identifier(owner, 160) || !domain.Identifier(profile, 160) || !domain.Identifier(computer, 160) {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listSelfTestInventoryLocked(ctx, owner, profile, computer, markers, nil)
}

// Caller retains the same writer mutex through any following admission.
func (r *Repository) listSelfTestInventoryLocked(ctx context.Context, owner, profile, computer string, markers *[]port.SelfTestMarkerHistoryEntry, stats *selfTestInventoryStats) ([]port.SelfTestHistoryEntry, error) {
	if err := r.ready(ctx); err != nil {
		return nil, err
	}
	listing, ok := r.disk.(historyKeys)
	if !ok {
		return nil, unavailable()
	}
	names, err := listing.keys()
	if err != nil || len(names) > maxSelfTestInventory || !slices.IsSorted(names) {
		return nil, unavailable()
	}
	digests := make([][32]byte, len(names))
	entries := make([]port.SelfTestHistoryEntry, 0)
	records := make([]settledBytes, 0, len(names))
	total := 0
	for i, name := range names {
		if ctx.Err() != nil || i > 0 && names[i-1] == name {
			return nil, unavailable()
		}
		raw, err := r.disk.read(name)
		if err != nil || len(raw) == 0 {
			return nil, unavailable()
		}
		total += len(raw)
		if total > maxSelfTestInventoryBytes {
			return nil, unavailable()
		}
		records = append(records, settledBytes{key: name, raw: raw})
		digests[i] = sha256.Sum256(raw)
		var header struct {
			Version uint8           `json:"schemaVersion"`
			Kind    string          `json:"kind"`
			Record  json.RawMessage `json:"record"`
		}
		if decodeStrict(raw, &header) != nil || header.Kind == "" || len(header.Record) == 0 {
			return nil, unavailable()
		}
		if markers != nil && header.Version == selfTestMarkerVersion && header.Kind == selfTestMarkerKind {
			marker, err := decodeSelfTestMarker(raw)
			if err != nil || marker == nil || len(*markers) >= maxSelfTestHistory {
				return nil, unavailable()
			}
			binding := marker.Binding()
			key, err := selfTestMarkerKey(binding)
			if err != nil || key != name || binding.Identity.OwnerID != owner || binding.Identity.ProfileID != profile || binding.Identity.ComputerID != computer {
				return nil, unavailable()
			}
			*markers = append(*markers, port.SelfTestMarkerHistoryEntry{Binding: binding, Phase: marker.Phase()})
		}
		if header.Version != selfTestVersion || header.Kind != selfTestKind {
			continue
		}
		value, err := decodeSelfTest(raw)
		if err != nil || value == nil {
			return nil, unavailable()
		}
		binding := value.Binding()
		key, err := selfTestKey(binding.Identity)
		if err != nil || key != name || binding.Identity.OwnerID != owner || binding.Identity.ProfileID != profile || binding.Identity.ComputerID != computer || len(entries) >= maxSelfTestHistory {
			return nil, unavailable()
		}
		entries = append(entries, port.SelfTestHistoryEntry{Binding: binding, Phase: value.Phase()})
	}
	// A record with an unknown schema, malformed identity, crossed key or
	// incomplete output graph cannot be silently mistaken for non-selftest data.
	if _, err := qualifyProcessHistoryBounded(records, SettledSelection{OwnerID: owner, ProfileID: profile, ComputerID: computer}, maxSelfTestInventory); err != nil {
		return nil, unavailable()
	}
	again, err := listing.keys()
	if err != nil || !slices.Equal(names, again) {
		return nil, unavailable()
	}
	for i, name := range names {
		if ctx.Err() != nil {
			return nil, unavailable()
		}
		raw, err := r.disk.read(name)
		if err != nil || len(raw) == 0 || sha256.Sum256(raw) != digests[i] {
			return nil, unavailable()
		}
	}
	if err := r.ready(ctx); err != nil {
		return nil, err
	}
	if stats != nil {
		stats.names = slices.Clone(names)
		stats.bytes = total
	}
	return entries, nil
}

var _ port.SelfTestHistoryRepository = (*Repository)(nil)
var _ port.SelfTestMarkerHistoryRepository = (*Repository)(nil)
