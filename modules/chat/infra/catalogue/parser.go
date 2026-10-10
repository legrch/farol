package catalogue

import selection "github.com/legrch/farol/modules/chat/domain/modelselection"

type Rows struct {
	Entries    []selection.Entry
	IDs        []string
	NextCursor string
}

// ParseSIWC accepts the declared /v1/models envelope. The listing does not
// advertise effort or capability evidence; those remain unknown here. Visibility
// list/hide follows the product's existing provider model representation.
func ParseSIWC(raw []byte) (Rows, error) {
	m, err := object(raw)
	if err != nil {
		return Rows{}, err
	}
	a, ok := m["models"].([]any)
	if !ok || len(a) > MaxRows {
		return Rows{}, Invalid
	}
	out := Rows{Entries: make([]selection.Entry, 0, len(a))}
	seen := map[string]bool{}
	for _, v := range a {
		r, ok := v.(map[string]any)
		if !ok {
			return Rows{}, Invalid
		}
		slug, a := text(r, "slug", 120, false)
		label, b := text(r, "display_name", 240, false)
		visible, c := text(r, "visibility", 40, false)
		if !a || !b || !c || !token(slug, 120) || seen[slug] || (visible != "list" && visible != "hide") {
			return Rows{}, Invalid
		}
		seen[slug] = true
		row := selection.Entry{Slug: slug, DisplayName: label, Hidden: visible == "hide", Capabilities: unknownCapabilities()}
		// Optional declared fields follow the existing provider representation.
		// Omission stays unknown; there is no universal effort list/default.
		if v, exists := r["supported_reasoning_levels"]; exists {
			levels, ok := v.([]any)
			if !ok || len(levels) > 32 {
				return Rows{}, Invalid
			}
			efforts := map[string]bool{}
			for _, v := range levels {
				x, ok := v.(map[string]any)
				if !ok {
					return Rows{}, Invalid
				}
				effort, ok := text(x, "effort", 40, false)
				if !ok || !token(effort, 40) || efforts[effort] {
					return Rows{}, Invalid
				}
				efforts[effort] = true
				row.Efforts = append(row.Efforts, effort)
			}
			if _, exists := r["default_reasoning_level"]; exists {
				def, ok := text(r, "default_reasoning_level", 40, false)
				if !ok || !efforts[def] {
					return Rows{}, Invalid
				}
				row.DefaultEffort = def
			}
		} else if _, exists := r["default_reasoning_level"]; exists {
			return Rows{}, Invalid
		}
		out.Entries = append(out.Entries, row)
	}
	return out, nil
}

// ParseAppServer preserves model/list's runtime model name (not its UI ID).
// It mirrors existing Codex boundary checks, without asserting live entitlement
// or using cached rows to grant inference/tools/browser capabilities.
func ParseAppServer(raw []byte) (Rows, error) {
	m, err := object(raw)
	if err != nil {
		return Rows{}, err
	}
	a, ok := m["data"].([]any)
	if !ok || len(a) > PageRows {
		return Rows{}, Invalid
	}
	out := Rows{Entries: make([]selection.Entry, 0, len(a))}
	ids := map[string]bool{}
	names := map[string]bool{}
	for _, v := range a {
		r, ok := v.(map[string]any)
		if !ok {
			return Rows{}, Invalid
		}
		id, a := text(r, "id", 160, false)
		slug, b := text(r, "model", 120, false)
		label, c := text(r, "displayName", 240, true)
		hidden, d := r["hidden"].(bool)
		efforts, e := r["supportedReasoningEfforts"].([]any)
		if !a || !b || !c || !d || !e || len(efforts) > 32 || !token(id, 160) || !token(slug, 120) || ids[id] || names[slug] {
			return Rows{}, Invalid
		}
		ids[id] = true
		names[slug] = true
		if label == "" {
			label = slug // Display the exact runtime name when no label is supplied.
		}
		row := selection.Entry{Slug: slug, DisplayName: label, Hidden: hidden, Capabilities: unknownCapabilities()}
		seen := map[string]bool{}
		for _, v := range efforts {
			x, ok := v.(map[string]any)
			if !ok {
				return Rows{}, Invalid
			}
			effort, ok := text(x, "reasoningEffort", 40, false)
			if !ok || !token(effort, 40) || seen[effort] {
				return Rows{}, Invalid
			}
			seen[effort] = true
			row.Efforts = append(row.Efforts, effort)
		}
		if v, exists := r["defaultReasoningEffort"]; exists && v != nil {
			def, ok := v.(string)
			if !ok || !seen[def] {
				return Rows{}, Invalid
			}
			row.DefaultEffort = def
		}
		if len(row.Efforts) > 0 && row.DefaultEffort == "" {
			return Rows{}, Invalid
		}
		out.Entries = append(out.Entries, row)
		out.IDs = append(out.IDs, id)
	}
	v, exists := m["nextCursor"]
	if !exists {
		return Rows{}, Invalid
	}
	if v != nil {
		cursor, ok := v.(string)
		if !ok || !token(cursor, 240) {
			return Rows{}, Invalid
		}
		out.NextCursor = cursor
	}
	return out, nil
}

func unknownCapabilities() selection.Capabilities {
	return selection.Capabilities{Text: selection.Unknown, Image: selection.Unknown, Tools: selection.Unknown}
}
