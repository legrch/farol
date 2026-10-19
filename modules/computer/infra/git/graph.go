package git

import (
	"bytes"
	"encoding/hex"
	"strings"
)

func (p *verifiedPack) load(id string) (*object, error) {
	if v := p.objects[id]; v != nil {
		return v, nil
	}
	return p.source.known(id)
}

// verifyGraph proves both source baseline and remote predecessor ancestry from
// actual authenticated commit bytes. Git authorship is NOT task ownership: the
// already-admitted manifest must supply that distinct workflow authorization.
func (p *verifiedPack) verifyGraph() error {
	in := p.source.in
	expect := func(id, kind string) error {
		meta, ok := p.source.plan.Object(id)
		if !ok || meta.Kind != kind {
			return ErrSource
		}
		return nil
	}
	seen := map[string]bool{}
	edges := 0
	queue := []string{in.Head}
	for len(queue) > 0 {
		id := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		if len(seen) > in.Limits.Objects {
			return ErrLimit
		}
		if p.source.plan.IsKnown(id) {
			continue
		}
		v, err := p.load(id)
		if err != nil {
			return err
		}
		switch v.kind {
		case "commit":
			tree, parents, err := commitLinks(v.data, in.Format)
			if err != nil {
				return err
			}
			edges += 1 + len(parents)
			if edges > in.Limits.Objects*8 {
				return ErrLimit
			}
			if err := expect(tree, "tree"); err != nil {
				return err
			}
			queue = append(queue, tree)
			for _, parent := range parents {
				if err := expect(parent, "commit"); err != nil {
					return err
				}
				queue = append(queue, parent)
			}
		case "tree":
			links, err := treeLinks(v.data, in.Format, p.source.plan.OIDBytes(), in.Limits.Objects*8-edges)
			if err != nil {
				return err
			}
			edges += len(links)
			for _, link := range links {
				if err := expect(link.id, link.kind); err != nil {
					return err
				}
				queue = append(queue, link.id)
			}
		case "blob":
		default:
			return ErrSource
		}
	}
	for id := range p.objects {
		if !seen[id] && !p.source.plan.IsKnown(id) {
			return ErrSource
		}
	}
	// Known objects terminate content closure, but never fabricate an ancestry
	// proof. Read only declared known commits until both required ancestors occur.
	seen = map[string]bool{}
	edges = 0
	queue = []string{in.Head}
	hasBase, hasOld := false, strings.Trim(in.Old, "0") == ""
	for len(queue) > 0 && !(hasBase && hasOld) {
		id := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		if len(seen) > in.Limits.Objects {
			return ErrLimit
		}
		if id == in.Base {
			hasBase = true
		}
		if id == in.Old {
			hasOld = true
		}
		// Even a known, zero-object update must authenticate the head bytes.
		v, err := p.load(id)
		if err != nil {
			return err
		}
		if v.kind != "commit" {
			return ErrSource
		}
		_, parents, err := commitLinks(v.data, in.Format)
		if err != nil {
			return err
		}
		if hasBase && hasOld {
			break
		}
		edges += len(parents)
		if edges > in.Limits.Objects*8 {
			return ErrLimit
		}
		for _, parent := range parents {
			if err := expect(parent, "commit"); err != nil {
				return err
			}
			queue = append(queue, parent)
		}
	}
	if !hasBase || !hasOld {
		return ErrScope
	}
	return nil
}

func commitLinks(data []byte, format string) (string, []string, error) {
	end := bytes.Index(data, []byte("\n\n"))
	if end < 0 {
		return "", nil, ErrSource
	}
	header := data[:end]
	if bytes.IndexByte(header, 0) >= 0 {
		return "", nil, ErrSource
	}
	lines := bytes.Split(header, []byte{'\n'})
	if len(lines) == 0 || !bytes.HasPrefix(lines[0], []byte("tree ")) {
		return "", nil, ErrSource
	}
	tree := string(lines[0][5:])
	if !validObjectID(format, tree) {
		return "", nil, ErrSource
	}
	parents := []string{}
	seen := map[string]bool{}
	parentsEnded := false
	for _, line := range lines[1:] {
		if bytes.HasPrefix(line, []byte("tree ")) {
			return "", nil, ErrSource
		}
		if bytes.HasPrefix(line, []byte("parent ")) {
			id := string(line[7:])
			if parentsEnded || !validObjectID(format, id) || seen[id] {
				return "", nil, ErrSource
			}
			seen[id] = true
			if len(parents) >= 1024 {
				return "", nil, ErrLimit
			}
			parents = append(parents, id)
		} else {
			parentsEnded = true
		}
	}
	return tree, parents, nil
}
func validObjectID(format, id string) bool {
	n := 40
	if format == "sha256" {
		n = 64
	}
	if len(id) != n || strings.Trim(id, "0") == "" {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

type objectLink struct{ id, kind string }

func treeLinks(data []byte, format string, oidBytes int, maxLinks int) ([]objectLink, error) {
	links := []objectLink{}
	seen := map[string]bool{}
	for len(data) > 0 {
		if len(seen) >= maxLinks {
			return nil, ErrLimit
		}
		space := bytes.IndexByte(data, ' ')
		nul := bytes.IndexByte(data, 0)
		if space < 1 || nul <= space+1 || len(data)-nul-1 < oidBytes {
			return nil, ErrSource
		}
		mode := string(data[:space])
		name := data[space+1 : nul]
		if bytes.ContainsAny(name, "/") || bytes.Equal(name, []byte(".")) || bytes.Equal(name, []byte("..")) || seen[string(name)] {
			return nil, ErrSource
		}
		seen[string(name)] = true
		id := hex.EncodeToString(data[nul+1 : nul+1+oidBytes])
		if !validObjectID(format, id) {
			return nil, ErrSource
		}
		switch mode {
		case "40000":
			links = append(links, objectLink{id: id, kind: "tree"})
		case "100644", "100755", "120000":
			links = append(links, objectLink{id: id, kind: "blob"})
		case "160000": // gitlink is a separate repository, not an object to upload here
		default:
			return nil, ErrSource
		}
		data = data[nul+1+oidBytes:]
	}
	return links, nil
}
