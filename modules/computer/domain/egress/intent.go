// Package egress describes immutable, source-bound outbound intent. A Plan is
// data, NOT permission. Only the existing Computer owner may admit a digest
// computed from its canonical encoding by the transport boundary.
package egress

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

var ErrIntent = errors.New("EGRESS_INVALID_INTENT")

// Object is a trusted source-manifest entry. Digest is SHA-256 of the canonical
// Git object (type, space, decimal size, NUL, content), even for SHA-1 repos.
// Comparing both digests prevents a SHA-1 alias from substituting approved bytes
// that the gate handles; a known object only referenced by OID is not read.
type Object struct {
	OID, Kind, Digest string
	Size              int64
}

// Limits bound untrusted protocol and decompression work. Zero is never unlimited.
type Limits struct {
	PackBytes, ExpandedBytes, ObjectBytes             int64
	Objects, DeltaDepth, AdvertisementBytes, RefCount int
}

func DefaultLimits() Limits {
	return Limits{PackBytes: 32 << 20, ExpandedBytes: 64 << 20, ObjectBytes: 8 << 20,
		Objects: 16384, DeltaDepth: 32, AdvertisementBytes: 2 << 20, RefCount: 16384}
}

// Binding is copied from trusted composition, not from shell text, Git config,
// a model-supplied environment or a replacement operation after reconnect.
type Binding struct {
	OperationID, WorkspaceID, RuntimeID, GrantID, RepositoryID string
	SourceSeal, DestinationSeal                                string
}

// Target names the effective, authenticated Git service, after config/URL
// resolution. It does not discover a host, request keys or grant network access.
type Target struct {
	Host, User, Repository string
	Port                   int
}

// Intent describes one non-deleting feature-ref update. Base is the accepted
// task baseline. Old is the expected remote OID; all-zero means proven absent,
// never "whatever is currently there". The owner must independently establish
// task ownership, real physical roots, repository identity and source custody.
type Intent struct {
	Binding                                        Binding
	Target                                         Target
	Format                                         string
	Ref, BranchPrefix, DefaultRef, Base, Head, Old string
	Objects                                        []Object
	Known                                          []Object
	Limits                                         Limits
}

// Plan holds a defensive canonical copy, including all manifest entries.
// Its zero value is invalid. Construction and canonical encoding mint no authority.
type Plan struct {
	intent         Intent
	canonical      string
	objects, known map[string]Object
}

func NewPlan(in Intent) (*Plan, error) {
	if !validBinding(in.Binding) || !validTarget(in.Target) ||
		(in.Format != "sha1" && in.Format != "sha256") || !validLimits(in.Limits) ||
		!ValidRef(in.Ref) || !ValidRef(in.DefaultRef) || in.Ref == in.DefaultRef ||
		!strings.HasPrefix(in.DefaultRef, "refs/heads/") ||
		!strings.HasPrefix(in.BranchPrefix, "refs/heads/") ||
		in.BranchPrefix == "refs/heads/" || !strings.HasSuffix(in.BranchPrefix, "/") ||
		!ValidRef(in.BranchPrefix+"scope") || !strings.HasPrefix(in.Ref, in.BranchPrefix) ||
		!ValidOID(in.Format, in.Base, false) || !ValidOID(in.Format, in.Head, false) ||
		!ValidOID(in.Format, in.Old, true) ||
		len(in.Objects) > in.Limits.Objects ||
		len(in.Known) > in.Limits.Objects || len(in.Objects)+len(in.Known) > in.Limits.Objects {
		return nil, ErrIntent
	}
	p := &Plan{intent: in, objects: map[string]Object{}, known: map[string]Object{}}
	for _, group := range []struct {
		items []Object
		dest  map[string]Object
	}{{in.Objects, p.objects}, {in.Known, p.known}} {
		for _, o := range group.items {
			if !ValidOID(in.Format, o.OID, false) || !hexDigest(o.Digest, 64) ||
				(o.Kind != "blob" && o.Kind != "tree" && o.Kind != "commit") ||
				o.Size < 0 || o.Size > in.Limits.ObjectBytes {
				return nil, ErrIntent
			}
			if _, exists := p.objects[o.OID]; exists {
				return nil, ErrIntent
			}
			if _, exists := p.known[o.OID]; exists {
				return nil, ErrIntent
			}
			group.dest[o.OID] = o
		}
	}
	for _, id := range []string{in.Base, in.Head} {
		o, ok := p.Object(id)
		if !ok || o.Kind != "commit" {
			return nil, ErrIntent
		}
	}
	if !IsZero(in.Old) {
		o, ok := p.Object(in.Old)
		if !ok || o.Kind != "commit" {
			return nil, ErrIntent
		}
	}
	p.intent.Objects = append([]Object(nil), in.Objects...)
	p.intent.Known = append([]Object(nil), in.Known...)
	sort.Slice(p.intent.Objects, func(i, j int) bool { return p.intent.Objects[i].OID < p.intent.Objects[j].OID })
	sort.Slice(p.intent.Known, func(i, j int) bool { return p.intent.Known[i].OID < p.intent.Known[j].OID })
	encoded, err := json.Marshal(p.intent)
	if err != nil {
		return nil, ErrIntent
	}
	p.canonical = string(encoded)
	return p, nil
}

// Canonical is immutable deterministic JSON for hashing at the infrastructure
// boundary. Returning a string cannot expose a writable manifest alias.
func (p *Plan) Canonical() string {
	if p == nil {
		return ""
	}
	return p.canonical
}
func (p *Plan) Intent() Intent {
	if p == nil {
		return Intent{}
	}
	out := p.intent
	out.Objects = append([]Object(nil), out.Objects...)
	out.Known = append([]Object(nil), out.Known...)
	return out
}
func (p *Plan) Object(id string) (Object, bool) {
	if p == nil {
		return Object{}, false
	}
	if v, ok := p.objects[id]; ok {
		return v, true
	}
	v, ok := p.known[id]
	return v, ok
}
func (p *Plan) IsKnown(id string) bool {
	if p == nil {
		return false
	}
	_, ok := p.known[id]
	return ok
}
func (p *Plan) OIDBytes() int {
	if p != nil && p.intent.Format == "sha256" {
		return 32
	}
	return 20
}

func validBinding(b Binding) bool {
	for _, id := range []string{b.OperationID, b.WorkspaceID, b.RuntimeID, b.GrantID, b.RepositoryID} {
		if !token(id, 160) {
			return false
		}
	}
	return hexDigest(b.SourceSeal, 64) && !IsZero(b.SourceSeal) && hexDigest(b.DestinationSeal, 64) && !IsZero(b.DestinationSeal)
}
func validTarget(t Target) bool {
	if len(t.Host) == 0 || len(t.Host) > 253 || strings.ToLower(t.Host) != t.Host ||
		t.Port < 1 || t.Port > 65535 || !token(t.User, 64) || strings.HasPrefix(t.User, "-") {
		return false
	}
	for _, label := range strings.Split(t.Host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	// v1 supports a canonical service-relative repository path, not arbitrary
	// shell commands, userinfo, tilde expansion, options or URL rewrite syntax.
	if len(t.Repository) > 1024 || !strings.HasSuffix(t.Repository, ".git") {
		return false
	}
	parts := strings.Split(t.Repository, "/")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if !token(part, 255) || part == "." || part == ".." || strings.HasPrefix(part, "-") {
			return false
		}
	}
	return true
}
func validLimits(l Limits) bool {
	return l.PackBytes >= 32 && l.PackBytes <= 64<<20 && l.ExpandedBytes > 0 && l.ExpandedBytes <= 128<<20 &&
		l.ObjectBytes > 0 && l.ObjectBytes <= 16<<20 && l.ObjectBytes <= l.ExpandedBytes &&
		l.Objects > 0 && l.Objects <= 65536 && l.DeltaDepth > 0 && l.DeltaDepth <= 64 &&
		l.AdvertisementBytes >= 64 && l.AdvertisementBytes <= 4<<20 && l.RefCount > 0 && l.RefCount <= 65536
}
func token(s string, max int) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}
func hexDigest(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func IsZero(s string) bool { return s != "" && strings.Trim(s, "0") == "" }
func ValidOID(format, id string, zero bool) bool {
	n := 40
	if format == "sha256" {
		n = 64
	} else if format != "sha1" {
		return false
	}
	return hexDigest(id, n) && (zero || !IsZero(id))
}

// ValidRef applies the conservative fully-qualified ref subset supported by the
// managed transport. It deliberately refuses ambiguous or option-like input.
func ValidRef(ref string) bool {
	if len(ref) > 1024 || !strings.HasPrefix(ref, "refs/") || strings.Contains(ref, "..") ||
		strings.Contains(ref, "@{") || strings.ContainsAny(ref, " ~^:?*[\\\x00\r\n\t") || strings.HasSuffix(ref, ".") {
		return false
	}
	for _, c := range ref {
		if c < 33 || c > 126 {
			return false
		}
	}
	for _, part := range strings.Split(ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasPrefix(part, "-") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}
