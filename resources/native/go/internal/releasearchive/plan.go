package releasearchive

import (
	"archive/zip"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/unicode/norm"
)

type kind uint8

const (
	regular kind = iota + 1
	directory
	symlink
)

type entry struct {
	file  *zip.File
	parts []string
	name  string
	kind  kind
	mode  uint32
	link  string
}
type node struct {
	name string
	kind kind
	link string
}
type plan struct {
	entries []*entry
	nodes   map[string]node
	app     string
}

func normalized(parts []string) string {
	// Python's contract is NFD followed by full default Unicode casefold.
	fold := cases.Fold()
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = fold.String(fullNFD(p))
	}
	return strings.Join(out, "/")
}

// x/text normalizes to stream-safe NFD and inserts CGJ after 30 non-starters.
// Python's unrestricted NFD does not. Preserve original CGJs and, only when
// insertion occurred, decompose individual runes and canonically order each
// combining sequence without inserting new characters.
func fullNFD(text string) string {
	normal := norm.NFD.String(text)
	if strings.Count(normal, "\u034f") == strings.Count(text, "\u034f") {
		return normal
	}
	type mark struct {
		value rune
		ccc   uint8
	}
	marks := []mark{}
	var out strings.Builder
	flush := func() {
		sort.SliceStable(marks, func(i, j int) bool { return marks[i].ccc < marks[j].ccc })
		for _, m := range marks {
			out.WriteRune(m.value)
		}
		marks = marks[:0]
	}
	for _, r := range text {
		for _, decomposed := range norm.NFD.String(string(r)) {
			ccc := norm.NFD.PropertiesString(string(decomposed)).CCC()
			if ccc == 0 {
				flush()
				out.WriteRune(decomposed)
			} else {
				marks = append(marks, mark{decomposed, ccc})
			}
		}
	}
	flush()
	return out.String()
}

func memberParts(name string) ([]string, error) {
	if name == "" || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") || strings.Contains(strings.SplitN(name, "/", 2)[0], ":") {
		return nil, refuse("ARCHIVE_PATH_INVALID")
	}
	parts := strings.Split(strings.TrimSuffix(name, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, refuse("ARCHIVE_PATH_INVALID")
		}
	}
	if parts[0] != previewApp && parts[0] != brandedApp && parts[0] != "artifact.json" {
		return nil, refuse("ARCHIVE_LAYOUT_INVALID")
	}
	if parts[0] == "artifact.json" && len(parts) != 1 {
		return nil, refuse("ARCHIVE_LAYOUT_INVALID")
	}
	if len(parts) > maxParts {
		return nil, refuse("ARCHIVE_PATH_DEPTH_LIMIT")
	}
	return parts, nil
}

func entryType(f *zip.File) (kind, uint32, error) {
	mode := f.ExternalAttrs >> 16
	bits, permissions := mode&0170000, mode&07777
	if strings.HasSuffix(f.Name, "/") {
		if bits != 0 && bits != 0040000 {
			return 0, 0, refuse("ARCHIVE_ENTRY_TYPE_INVALID")
		}
		return directory, permissions, nil
	}
	if bits == 0120000 {
		return symlink, permissions, nil
	}
	if bits != 0 && bits != 0100000 {
		return 0, 0, refuse("ARCHIVE_ENTRY_TYPE_INVALID")
	}
	if permissions == 0 {
		permissions = 0644
	}
	return regular, permissions, nil
}

// copyEntry always checks CRC, including an expected zero CRC (archive/zip does
// not check zero CRC without a descriptor). Reads are limited to declared size+1.
func copyEntry(f *zip.File, target io.Writer, buffer []byte) error {
	// admitDirectory already verified the descriptor against central CRC and
	// sizes. archive/zip otherwise mistakes an unsigned marker-valued CRC for
	// a signature. Suppress only that duplicate descriptor read in a local
	// header copy; bounded output and actual CRC remain checked below.
	header := *f
	header.Flags &^= 8
	source, err := header.Open()
	if err != nil {
		return refuse("ARCHIVE_READ_INVALID")
	}
	defer source.Close()
	hash := crc32.NewIEEE()
	copied, err := io.CopyBuffer(io.MultiWriter(target, hash), io.LimitReader(source, int64(f.UncompressedSize64)+1), buffer)
	if err != nil {
		if errors.Is(err, zip.ErrChecksum) {
			return refuse("ARCHIVE_CRC_INVALID")
		}
		return refuse("ARCHIVE_READ_INVALID")
	}
	if uint64(copied) != f.UncompressedSize64 {
		return refuse("ARCHIVE_SIZE_INVALID")
	}
	if hash.Sum32() != f.CRC32 {
		return refuse("ARCHIVE_CRC_INVALID")
	}
	return nil
}

func validLink(link string) error {
	if link == "" || !utf8.ValidString(link) || strings.ContainsAny(link, "\\\x00") || strings.HasPrefix(link, "/") || len(link) > maxLink {
		return refuse("ARCHIVE_LINK_INVALID")
	}
	return nil
}

func preflight(archive *zip.Reader, stage *stage) (*plan, error) {
	p := &plan{nodes: make(map[string]node)}
	seen := make(map[string]kind)
	tree := make(map[string]struct{})
	apps := make(map[string]bool)
	var expanded uint64
	for _, f := range archive.File {
		if f.Flags&(1|0x40) != 0 {
			return nil, refuse("ARCHIVE_ENCRYPTED")
		}
		if f.Method != zip.Store && f.Method != zip.Deflate {
			return nil, refuse("ARCHIVE_COMPRESSION_INVALID")
		}
		name := f.Name
		if f.Flags&0x800 != 0 {
			if !utf8.ValidString(name) {
				return nil, refuse("ARCHIVE_PATH_INVALID")
			}
		} else {
			decoded, err := charmap.CodePage437.NewDecoder().String(name)
			if err != nil {
				return nil, refuse("ARCHIVE_PATH_INVALID")
			}
			name = decoded
		}
		parts, err := memberParts(name)
		if err != nil {
			return nil, err
		}
		k, mode, err := entryType(f)
		if err != nil {
			return nil, err
		}
		if k == directory && f.UncompressedSize64 != 0 {
			return nil, refuse("ARCHIVE_DIRECTORY_DATA")
		}
		if k == directory && mode != 0 && mode&0700 != 0700 {
			return nil, refuse("ARCHIVE_DIRECTORY_MODE")
		}
		if k == symlink && f.UncompressedSize64 > maxLink {
			return nil, refuse("ARCHIVE_LINK_INVALID")
		}
		key := normalized(parts)
		if _, ok := seen[key]; ok {
			return nil, refuse("ARCHIVE_DUPLICATE_ENTRY")
		}
		seen[key] = k
		expanded += f.UncompressedSize64
		if expanded > maxExpanded {
			return nil, refuse("ARCHIVE_EXPANDED_LIMIT")
		}
		if f.UncompressedSize64 > max(f.CompressedSize64*100, chunk) {
			return nil, refuse("ARCHIVE_RATIO_LIMIT")
		}
		e := &entry{file: f, parts: parts, name: strings.Join(parts, "/"), kind: k, mode: mode}
		p.entries = append(p.entries, e)
		if parts[0] != "artifact.json" && len(parts) > 1 {
			apps[parts[0]] = true
		}
		for i := 1; i <= len(parts); i++ {
			prefix := normalized(parts[:i])
			raw := strings.Join(parts[:i], "/")
			if old, ok := p.nodes[prefix]; ok && old.name != raw {
				return nil, refuse("ARCHIVE_DUPLICATE_ENTRY")
			}
			if _, ok := p.nodes[prefix]; !ok {
				p.nodes[prefix] = node{name: raw, kind: directory}
			}
			if i == len(parts) {
				p.nodes[prefix] = node{name: raw, kind: k}
			}
			if parts[0] != "artifact.json" && i >= 2 {
				tree[prefix] = struct{}{}
				if len(tree) > maxEntries {
					return nil, refuse("ARCHIVE_ENTRY_COUNT_INVALID")
				}
			}
		}
	}
	for _, e := range p.entries {
		for i := 1; i < len(e.parts); i++ {
			if k, ok := seen[normalized(e.parts[:i])]; ok && k != directory {
				return nil, refuse("ARCHIVE_PARENT_TYPE_INVALID")
			}
		}
	}
	if seen[normalized([]string{"artifact.json"})] != regular {
		return nil, refuse("ARCHIVE_ARTIFACT_MISSING")
	}
	if len(apps) != 1 {
		return nil, refuse("ARCHIVE_APP_SET_INVALID")
	}
	for app := range apps {
		p.app = app
	}
	// Admission of existing paths permits the trusted copied extractor in stage,
	// while refusing pre-existing symlink parents or destinations before any writes.
	for _, e := range p.entries {
		for i := 1; i <= len(e.parts); i++ {
			name := strings.Join(e.parts[:i], "/")
			info, err := stage.root.Lstat(name)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if i < len(e.parts) && !info.IsDir() {
				return nil, refuse("ARCHIVE_PARENT_TYPE_INVALID")
			}
			if i == len(e.parts) && (e.kind != directory || !info.IsDir()) {
				return nil, refuse("ARCHIVE_ENTRY_EXISTS")
			}
		}
	}
	// Symlink data and graph errors are preflight failures, never partial extraction.
	buffer := make([]byte, maxLink+1)
	for _, e := range p.entries {
		if e.kind != symlink {
			continue
		}
		var payload strings.Builder
		if err := copyEntry(e.file, &payload, buffer); err != nil {
			return nil, err
		}
		e.link = payload.String()
		if err := validLink(e.link); err != nil {
			return nil, err
		}
		p.nodes[normalized(e.parts)] = node{name: e.name, kind: symlink, link: e.link}
	}
	resolver := newLinkResolver(stage, p.nodes)
	for _, e := range p.entries {
		if e.kind == symlink {
			if _, err := resolver.resolve(e.name); err != nil {
				return nil, err
			}
		}
	}
	return p, nil
}

// Resolve component by component, following symlinks BEFORE processing '..'.
// filepath.Clean alone would incorrectly accept links through escaping parents.
// Memoized targets keep many long chains from causing quadratic graph walks.
// A fresh resolver is used after extraction so planned data is not FS evidence.
type linkResolver struct {
	stage   *stage
	nodes   map[string]node
	targets map[string]node
	active  map[string]bool
}

func newLinkResolver(stage *stage, nodes map[string]node) *linkResolver {
	return &linkResolver{stage: stage, nodes: nodes, targets: make(map[string]node), active: make(map[string]bool)}
}

func (r *linkResolver) resolve(name string) (node, error) {
	pending := strings.Split(name, "/")
	resolved := []string{}
	last := node{kind: directory}
	for len(pending) > 0 {
		part := pending[0]
		pending = pending[1:]
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(resolved) == 0 {
				return node{}, refuse("ARCHIVE_LINK_ESCAPE")
			}
			resolved = resolved[:len(resolved)-1]
			last = node{name: strings.Join(resolved, "/"), kind: directory}
			continue
		}
		candidate := append(append([]string(nil), resolved...), part)
		path := strings.Join(candidate, "/")
		key := normalized(candidate)
		n, ok := r.nodes[key]
		if !ok {
			info, err := r.stage.root.Lstat(path)
			if err != nil {
				return node{}, refuse("ARCHIVE_LINK_INVALID")
			}
			n = node{name: path, kind: regular}
			if info.IsDir() {
				n.kind = directory
			}
			if info.Mode()&os.ModeSymlink != 0 {
				n.kind = symlink
				n.link, err = r.stage.root.Readlink(path)
				if err != nil {
					return node{}, refuse("ARCHIVE_LINK_INVALID")
				}
			}
		}
		if n.kind == symlink {
			_, cached := r.targets[key]
			if !cached {
				if err := validLink(n.link); err != nil {
					return node{}, err
				}
				if r.active[key] || len(r.active) >= maxEntries {
					return node{}, refuse("ARCHIVE_LINK_INVALID")
				}
				r.active[key] = true
				// Keep target components uncleaned until recursive resolution follows all
				// intermediate links; concatenation is relative to the link's parent.
				targetName := strings.Join(resolved, "/") + "/" + n.link
				target, err := r.resolve(targetName)
				delete(r.active, key)
				if err != nil {
					return node{}, err
				}
				r.targets[key] = target
			}
			n = r.targets[key]
		}
		if len(pending) > 0 && n.kind != directory {
			return node{}, refuse("ARCHIVE_LINK_INVALID")
		}
		if n.name == "" {
			resolved = nil
		} else {
			resolved = strings.Split(n.name, "/")
		}
		last = n
	}
	return last, nil
}
