package catalogue

import (
	"context"
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
)

// Transport must use an already-selected account/route. Page.Scope is its
// original correlation, never a token or an entitlement witness. Boot supplies
// concrete transport lifetime; this package neither discovers nor stores tokens.
type Transport interface {
	List(context.Context, selection.Scope, string) (Page, error)
}
type Page struct {
	Scope selection.Scope
	Body  []byte
}
type Stamp struct {
	Epoch                             uint64
	Revision                          string
	ObservedAtMillis, ExpiresAtMillis uint64
}

func Read(ctx context.Context, transport Transport, scope selection.Scope, source selection.Source, stamp Stamp) (selection.Snapshot, error) {
	if ctx == nil || transport == nil {
		return selection.Snapshot{}, Unavailable
	}
	if source == selection.SIWC && scope.Route.Backend != selection.PlanInference || source == selection.AppServer && scope.Route.Backend != selection.CodexTask || (source != selection.SIWC && source != selection.AppServer) {
		return selection.Snapshot{}, Invalid
	}
	snapshot := selection.Snapshot{Scope: scope, Source: source, Epoch: stamp.Epoch, Revision: stamp.Revision, ObservedAtMillis: stamp.ObservedAtMillis, ExpiresAtMillis: stamp.ExpiresAtMillis, Complete: true}
	if selection.ValidateSnapshot(snapshot) != nil {
		return selection.Snapshot{}, Invalid
	}
	cursor := ""
	seen := map[string]bool{}
	names := map[string]bool{}
	ids := map[string]bool{}
	totalBytes := 0
	for n := 0; n < 20; n++ {
		if ctx.Err() != nil {
			return selection.Snapshot{}, Unavailable
		}
		p, err := transport.List(ctx, scope, cursor)
		if err != nil || ctx.Err() != nil {
			return selection.Snapshot{}, Unavailable
		}
		if p.Scope != scope {
			return selection.Snapshot{}, ScopeMismatch
		}
		totalBytes += len(p.Body)
		if totalBytes > MaxBytes {
			return selection.Snapshot{}, Invalid
		}
		var rows Rows
		if source == selection.SIWC {
			rows, err = ParseSIWC(p.Body)
		} else {
			rows, err = ParseAppServer(p.Body)
		}
		if err != nil {
			return selection.Snapshot{}, err
		}
		for _, entry := range rows.Entries {
			if names[entry.Slug] {
				return selection.Snapshot{}, Invalid
			}
			names[entry.Slug] = true
			snapshot.Entries = append(snapshot.Entries, entry)
		}
		for _, id := range rows.IDs {
			if ids[id] {
				return selection.Snapshot{}, Invalid
			}
			ids[id] = true
		}
		if len(snapshot.Entries) > MaxRows {
			return selection.Snapshot{}, Invalid
		}
		if rows.NextCursor == "" {
			if err := selection.ValidateSnapshot(snapshot); err != nil {
				return selection.Snapshot{}, Invalid
			}
			return snapshot, nil
		}
		if seen[rows.NextCursor] {
			return selection.Snapshot{}, Invalid
		}
		seen[rows.NextCursor] = true
		cursor = rows.NextCursor
	}
	return selection.Snapshot{}, Invalid
}
