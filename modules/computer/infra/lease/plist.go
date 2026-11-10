package lease

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strings"

	domain "github.com/legrch/farol/modules/computer/domain/lease"
)

const maxPlistBytes = 65536
const maxPlistDepth = 10
const maxPlistItems = 2048

type value struct {
	kind, text string
	entries    map[string]value
}

// parsePlist is a narrowly bounded, strict structured XML plist parser, not a
// regex or a general-purpose unbounded XML loader. Duplicate keys anywhere,
// directives/DTD, invalid nesting, extra nodes and unexpected text refuse.
func parsePlist(raw []byte) (map[string]value, error) {
	if len(raw) == 0 || len(raw) > maxPlistBytes {
		return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	d := xml.NewDecoder(bytes.NewReader(raw))
	d.Strict = true
	n := 0
	next := func() (xml.Token, error) {
		n++
		if n > maxPlistItems {
			return nil, errors.New("xml token limit")
		}
		return d.Token()
	}
	var start xml.StartElement
	found := false
	for !found {
		tok, e := next()
		if e != nil {
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		}
		switch v := tok.(type) {
		case xml.ProcInst:
			if v.Target != "xml" {
				return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
			}
		case xml.Directive:
			// diskutil's standard XML plist includes this exact public DTD line.
			// No arbitrary directives/entities or DTD expansion are accepted.
			if string(v) != `DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"` {
				return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
			}
		case xml.CharData:
			if len(bytes.TrimSpace(v)) != 0 {
				return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
			}
		case xml.StartElement:
			start = v
			found = true
		default:
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		}
	}
	if start.Name.Space != "" || start.Name.Local != "plist" || len(start.Attr) != 1 || start.Attr[0].Name.Local != "version" || start.Attr[0].Value != "1.0" {
		return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	var child xml.StartElement
	for {
		tok, e := next()
		if e != nil {
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		}
		if t, ok := tok.(xml.CharData); ok && len(bytes.TrimSpace(t)) == 0 {
			continue
		}
		v, ok := tok.(xml.StartElement)
		if !ok {
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		}
		child = v
		break
	}
	if child.Name.Local != "dict" || child.Name.Space != "" {
		return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	parsed, e := readValue(d, child, 0, &n)
	if e != nil {
		return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	for {
		tok, e := next()
		if e != nil {
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		}
		switch t := tok.(type) {
		case xml.EndElement:
			if t.Name != start.Name {
				return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
			}
			after, e := next()
			for e == nil {
				if chars, ok := after.(xml.CharData); !ok || len(bytes.TrimSpace(chars)) != 0 {
					return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
				}
				after, e = next()
			}
			if e == io.EOF {
				return parsed.entries, nil
			}
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		case xml.CharData:
			if len(bytes.TrimSpace(t)) != 0 {
				return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
			}
		default:
			return nil, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
		}
	}
}
func readValue(d *xml.Decoder, start xml.StartElement, depth int, count *int) (value, error) {
	bad := errors.New("malformed plist")
	if depth > maxPlistDepth || start.Name.Space != "" || len(start.Attr) != 0 {
		return value{}, bad
	}
	typ := start.Name.Local
	if typ != "dict" && typ != "array" && typ != "key" && typ != "string" && typ != "integer" && typ != "data" && typ != "date" && typ != "real" && typ != "true" && typ != "false" {
		return value{}, bad
	}
	out := value{kind: typ}
	if typ == "dict" {
		out.entries = map[string]value{}
	}
	pending := ""
	hasPending := false
	for {
		*count = *count + 1
		if *count > maxPlistItems {
			return value{}, bad
		}
		tok, e := d.Token()
		if e != nil {
			return value{}, bad
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if typ != "dict" && typ != "array" {
				return value{}, bad
			}
			v, e := readValue(d, t, depth+1, count)
			if e != nil {
				return value{}, e
			}
			if typ == "array" {
				continue
			}
			if !hasPending {
				if v.kind != "key" || v.text == "" {
					return value{}, bad
				}
				pending = v.text
				hasPending = true
				continue
			}
			if v.kind == "key" {
				return value{}, bad
			}
			if _, present := out.entries[pending]; present {
				return value{}, bad
			}
			out.entries[pending] = v
			hasPending = false
		case xml.CharData:
			if typ == "dict" || typ == "array" || typ == "true" || typ == "false" {
				if len(bytes.TrimSpace(t)) != 0 {
					return value{}, bad
				}
				continue
			}
			out.text += string(t)
			if len(out.text) > 4096 {
				return value{}, bad
			}
		case xml.EndElement:
			if t.Name != start.Name || hasPending {
				return value{}, bad
			}
			if typ == "true" || typ == "false" {
				if strings.TrimSpace(out.text) != "" {
					return value{}, bad
				}
			}
			return out, nil
		default:
			return value{}, bad
		}
	}
}

func decodeMetadata(raw []byte, point string) (domain.Metadata, error) {
	v, e := parsePlist(raw)
	if e != nil {
		return domain.Metadata{}, e
	}
	str := func(key string) (string, error) {
		entry, ok := v[key]
		if !ok || entry.kind != "string" {
			return "", errors.New("missing string")
		}
		if entry.text != strings.TrimSpace(entry.text) || entry.text == "" {
			return "", errors.New("invalid string")
		}
		return entry.text, nil
	}
	boolean := func(key string) (bool, error) {
		entry, ok := v[key]
		if !ok || (entry.kind != "true" && entry.kind != "false") {
			return false, errors.New("missing boolean")
		}
		return entry.kind == "true", nil
	}
	out := domain.Metadata{}
	if out.Filesystem, e = str("FilesystemType"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if out.MountPoint, e = str("MountPoint"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if out.GroupID, e = str("APFSVolumeGroupID"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if out.Internal, e = boolean("Internal"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if out.GlobalPermissions, e = boolean("GlobalPermissionsEnabled"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if out.Bootable, e = boolean("Bootable"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if out.Snapshot, e = boolean("APFSSnapshot"); e != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	if point != domain.SystemPath && point != domain.DataPath {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	return out, nil
}

// Keeps platform observations from exposing raw tool output to callers.

// boundWriter refuses utility output above the fixed XML-plist bound.
// It never exposes raw utility content in errors or logs.
type boundWriter struct{ data []byte }

func (w *boundWriter) Write(p []byte) (int, error) {
	if len(p) > maxPlistBytes-len(w.data) {
		return 0, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	w.data = append(w.data, p...)
	return len(p), nil
}
