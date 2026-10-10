package contextbudget

import "unicode/utf8"

type exchange struct {
	start, end int
	required   bool
}

// A user event starts an indivisible exchange. Tool rounds may interleave calls,
// but each output must follow its exact call within the SAME original turn.
// No absent output is fabricated. An incomplete exchange fails materialization.
func group(s Source) ([]exchange, []UnknownReference, error) {
	if !s.Binding.Valid() || s.Revision == 0 || len(s.Events) == 0 || len(s.Events) > MaxEvents {
		return nil, nil, Invalid
	}
	groups := []exchange{}
	unknowns := []UnknownReference{}
	seen := map[string]bool{}
	turns := map[Turn]bool{}
	calls := map[string]Event{}
	answered := map[string]bool{}
	toolops := map[string]bool{}
	var current Turn
	bytes := 0
	var last uint64
	for i, v := range s.Events {
		if !ID(v.ID) || seen[v.ID] || v.Sequence == 0 || (i > 0 && v.Sequence <= last) || !utf8.ValidString(v.Text) || len(v.Text) > MaxEventBytes {
			return nil, nil, Invalid
		}
		seen[v.ID] = true
		last = v.Sequence
		bytes += len(v.Text)
		if bytes > MaxSourceBytes {
			return nil, nil, SourceLimit
		}
		if v.Kind == Instruction {
			if len(groups) > 0 && current != (Turn{}) || v.Turn != (Turn{}) || v.CallID != "" || v.ToolOperationID != "" || v.Name != "" || v.Outcome != "" {
				return nil, nil, Invalid
			}
			groups = append(groups, exchange{i, i + 1, true})
			continue
		}
		if !v.Turn.Valid() {
			return nil, nil, Invalid
		}
		if v.Kind == User {
			if turns[v.Turn] {
				return nil, nil, Pairing
			}
			turns[v.Turn] = true
			current = v.Turn
			groups = append(groups, exchange{i, i + 1, false})
		} else {
			if len(groups) == 0 || current != v.Turn {
				return nil, nil, Pairing
			}
			groups[len(groups)-1].end = i + 1
		}
		switch v.Kind {
		case User, Assistant:
			if v.CallID != "" || v.ToolOperationID != "" || v.Name != "" || v.Outcome != "" {
				return nil, nil, Invalid
			}
		case Call:
			if !ID(v.CallID) || !ID(v.ToolOperationID) || !ID(v.Name) || v.Outcome != "" || toolops[v.ToolOperationID] {
				return nil, nil, Pairing
			}
			// Provider call IDs must be unique across the whole request, not just
			// within a turn; account/turn pairing alone cannot fix ambiguous wire.
			if _, ok := calls[v.CallID]; ok {
				return nil, nil, Pairing
			}
			calls[v.CallID] = v
			toolops[v.ToolOperationID] = true
		case Result:
			call, ok := calls[v.CallID]
			if !ok || answered[v.CallID] || call.Turn != v.Turn || call.ToolOperationID != v.ToolOperationID || v.Name != "" {
				return nil, nil, Pairing
			}
			switch v.Outcome {
			case Completed, Failed, Refused, Cancelled, Unknown:
			default:
				return nil, nil, Invalid
			}
			answered[v.CallID] = true
			if v.Outcome == Unknown {
				groups[len(groups)-1].required = true
				unknowns = append(unknowns, UnknownReference{v.Turn, v.CallID, v.ToolOperationID, call.ID, v.ID, Unknown})
			}
		default:
			return nil, nil, Invalid
		}
	}
	for _, v := range s.Events {
		if v.Kind == Call && !answered[v.CallID] {
			unknowns = append(unknowns, UnknownReference{Turn: v.Turn, CallID: v.CallID, ToolOperationID: v.ToolOperationID, CallEventID: v.ID, Outcome: Pending})
		}
	}
	if len(answered) < len(calls) {
		return nil, nil, &Failure{Code: Incomplete, Unresolved: unknowns}
	}
	if current == (Turn{}) {
		return nil, nil, Invalid
	}
	groups[len(groups)-1].required = true // keep the latest complete user intent
	return groups, unknowns, nil
}
