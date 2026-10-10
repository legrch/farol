package catalogue

import selection "github.com/legrch/farol/modules/chat/domain/modelselection"

// Evidence is explicitly supplied product-supported behavior, independently of
// account listing/marketing. Exact scope and catalogue epoch prevent an old
// account's supported features from being attached to a newly selected account.
// It is not an authorization grant or successful provider-call observation.
type Evidence struct {
	Scope  selection.Scope
	Epoch  uint64
	Models map[string]selection.Capabilities
}

func WithEvidence(snapshot selection.Snapshot, e Evidence) (selection.Snapshot, error) {
	if e.Scope != snapshot.Scope || e.Epoch != snapshot.Epoch {
		return selection.Snapshot{}, ScopeMismatch
	}
	if len(e.Models) > MaxRows {
		return selection.Snapshot{}, Invalid
	}
	out := clone(snapshot)
	found := map[string]bool{}
	for n, row := range out.Entries {
		if c, ok := e.Models[row.Slug]; ok {
			out.Entries[n].Capabilities = c
			found[row.Slug] = true
		}
	}
	for name := range e.Models {
		if !found[name] {
			return selection.Snapshot{}, Invalid
		}
	}
	if selection.ValidateSnapshot(out) != nil {
		return selection.Snapshot{}, Invalid
	}
	return out, nil
}
