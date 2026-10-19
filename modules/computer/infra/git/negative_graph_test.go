package git

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

// graphCase builds a candidate update around the standard fixture. The head is
// the only object introduced unless build returns more.
type graphBuild func(t *testing.T, in *egress.Intent, known memoryObjects, objects []*object) (head *object, introduced []*object)

func runGraph(t *testing.T, build graphBuild) (*verifiedPack, error) {
	t.Helper()
	in, known, objects := packFixture(t, "sha1")
	head, introduced := build(t, &in, known, objects)
	in = setObjects(in, in.Format, head, introduced)
	return readWire(t, in, known, makePack(t, in.Format, introduced))
}

func addKnown(in *egress.Intent, known memoryObjects, v *object) string {
	m := meta(in.Format, v)
	in.Known = append(in.Known, m)
	known[m.OID] = v
	return m.OID
}

func treeID(in egress.Intent) string { return in.Known[1].OID } // the already-known base tree

func rawTree(format string, entries ...[2]string) *object {
	var data []byte
	for _, e := range entries {
		id, _ := hex.DecodeString(e[1])
		data = append(append(data, []byte(e[0]+"\x00")...), id...)
	}
	return &object{kind: "tree", data: data}
}

func fakeOID(i int) string { return fmt.Sprintf("%040x", i+1) }

func TestGraphRefusesHeadCommitsItCannotParse(t *testing.T) {
	cases := []struct {
		name   string
		header func(in egress.Intent) string
		want   error
	}{
		{"no header terminator", nil, ErrSource},
		{"NUL inside the header", func(in egress.Intent) string { return "tree " + treeID(in) + "\nauthor a\x00b" }, ErrSource},
		{"does not start with a tree", func(in egress.Intent) string { return "author a\ntree " + treeID(in) }, ErrSource},
		{"tree keyword with another separator", func(in egress.Intent) string { return "tree:" + treeID(in) }, ErrSource},
		{"short tree id", func(in egress.Intent) string { return "tree " + treeID(in)[:39] }, ErrSource},
		{"zero tree id", func(in egress.Intent) string { return "tree " + strings.Repeat("0", 40) }, ErrSource},
		{"uppercase tree id", func(in egress.Intent) string { return "tree " + strings.ToUpper(treeID(in)) }, ErrSource},
		{"second tree line", func(in egress.Intent) string { return "tree " + treeID(in) + "\ntree " + treeID(in) }, ErrSource},
		{"parent after another header", func(in egress.Intent) string {
			return "tree " + treeID(in) + "\nauthor a\nparent " + in.Base
		}, ErrSource},
		{"duplicate parent", func(in egress.Intent) string {
			return "tree " + treeID(in) + "\nparent " + in.Base + "\nparent " + in.Base
		}, ErrSource},
		{"short parent id", func(in egress.Intent) string { return "tree " + treeID(in) + "\nparent " + in.Base[:10] }, ErrSource},
		{"zero parent id", func(in egress.Intent) string { return "tree " + treeID(in) + "\nparent " + strings.Repeat("0", 40) }, ErrSource},
		{"parent missing from the manifest", func(in egress.Intent) string { return "tree " + treeID(in) + "\nparent " + fakeOID(1) }, ErrSource},
		{"more than 1024 parents", func(in egress.Intent) string {
			h := "tree " + treeID(in)
			for i := 0; i <= 1024; i++ {
				h += "\nparent " + fakeOID(i)
			}
			return h
		}, ErrLimit},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runGraph(t, func(t *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
				head := &object{kind: "commit", data: []byte("tree " + treeID(*in))}
				if tc.header != nil {
					head = opaqueCommit(tc.header(*in))
				}
				return head, []*object{head}
			})
			wantIs(t, err, tc.want)
		})
	}
}

// The edge budget is checked before the manifest, so a hostile commit cannot
// make the graph walk do unbounded work by naming parents it never ships.
func TestGraphEdgeBudgetIsInclusive(t *testing.T) {
	for _, tc := range []struct {
		parents int
		want    error
	}{{46, ErrSource}, {47, ErrSource}, {48, ErrLimit}, {200, ErrLimit}} {
		t.Run(fmt.Sprint(tc.parents), func(t *testing.T) {
			_, err := runGraph(t, func(t *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
				in.Limits.Objects = 6
				h := "tree " + treeID(*in)
				for i := 0; i < tc.parents; i++ {
					h += "\nparent " + fakeOID(i)
				}
				head := opaqueCommit(h)
				return head, []*object{head}
			})
			wantIs(t, err, tc.want)
		})
	}
}

func TestGraphRefusesTreesItCannotParse(t *testing.T) {
	blob := func(in egress.Intent) string { return in.Known[2].OID } // the known base blob
	cases := []struct {
		name string
		tree func(in egress.Intent) *object
		want error
	}{
		{"mode with group write", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100664 f", blob(in)}) }, ErrSource},
		{"zero padded directory mode", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"040000 f", blob(in)}) }, ErrSource},
		{"unknown gitlink-like mode", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"160001 f", blob(in)}) }, ErrSource},
		{"mode with trailing garbage", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100644x f", blob(in)}) }, ErrSource},
		{"empty mode", func(in egress.Intent) *object { return rawTree("sha1", [2]string{" f", blob(in)}) }, ErrSource},
		{"empty name", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100644 ", blob(in)}) }, ErrSource},
		{"name with slash", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100644 a/b", blob(in)}) }, ErrSource},
		{"dot name", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100644 .", blob(in)}) }, ErrSource},
		{"dot dot name", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100644 ..", blob(in)}) }, ErrSource},
		{"duplicate name", func(in egress.Intent) *object {
			return rawTree("sha1", [2]string{"100644 f", blob(in)}, [2]string{"100755 f", blob(in)})
		}, ErrSource},
		{"zero object id", func(in egress.Intent) *object {
			return rawTree("sha1", [2]string{"100644 f", strings.Repeat("0", 40)})
		}, ErrSource},
		{"object not in the manifest", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"100644 f", fakeOID(7)}) }, ErrSource},
		{"no NUL terminator", func(egress.Intent) *object {
			return &object{kind: "tree", data: []byte("100644 name")}
		}, ErrSource},
		{"truncated object id", func(egress.Intent) *object {
			return &object{kind: "tree", data: append([]byte("100644 f\x00"), bytes.Repeat([]byte{1}, 10)...)}
		}, ErrSource},
		{"directory that is a blob", func(in egress.Intent) *object { return rawTree("sha1", [2]string{"40000 d", blob(in)}) }, ErrSource},
		{"entries out of Git order", func(in egress.Intent) *object {
			return rawTree("sha1", [2]string{"100644 b", blob(in)}, [2]string{"100644 a", blob(in)})
		}, ErrSource},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runGraph(t, func(t *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
				tr := tc.tree(*in)
				head := commit(in.Format, objID(in.Format, tr), in.Base)
				return head, []*object{head, tr}
			})
			wantIs(t, err, tc.want)
		})
	}
}

func TestGraphTreeEntryBudgetIsInclusive(t *testing.T) {
	for _, tc := range []struct {
		entries int
		want    error
	}{{46, nil}, {47, ErrLimit}} {
		t.Run(fmt.Sprint(tc.entries), func(t *testing.T) {
			_, err := runGraph(t, func(t *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
				in.Limits.Objects = 6
				var entries [][2]string
				for i := 0; i < tc.entries; i++ {
					entries = append(entries, [2]string{fmt.Sprintf("160000 module%02d", i), fakeOID(i)})
				}
				tr := rawTree("sha1", entries...)
				head := commit(in.Format, objID(in.Format, tr), in.Base)
				return head, []*object{head, tr}
			})
			if tc.want == nil && err != nil {
				t.Fatal(err)
			}
			if tc.want != nil {
				wantIs(t, err, tc.want)
			}
		})
	}
}

// A submodule commit lives in another repository. It is neither required in the
// manifest nor uploaded; treating it as a blob would demand a missing object.
func TestGraphGitlinkIsNotAnObjectToUpload(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	blobID := objID(in.Format, objects[2])
	tr := rawTree("sha1", [2]string{"100644 file.txt", blobID}, [2]string{"160000 vendor", fakeOID(99)})
	head := commit(in.Format, objID(in.Format, tr), in.Base)
	introduced := []*object{head, tr, objects[2]}
	in = setObjects(in, in.Format, head, introduced)
	p, err := readWire(t, in, known, makePack(t, in.Format, introduced))
	if err != nil {
		t.Fatal(err)
	}
	if _, present := p.objects[fakeOID(99)]; present {
		t.Fatal("gitlink became an uploaded object")
	}
	if _, n, err := p.canonical(); err != nil || n != 3 {
		t.Fatal(n, err)
	}
}

func TestGraphTreeMayReferenceAKnownObject(t *testing.T) {
	_, err := runGraph(t, func(t *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
		tr := rawTree("sha1", [2]string{"100644 unchanged.txt", in.Known[2].OID})
		head := commit(in.Format, objID(in.Format, tr), in.Base)
		return head, []*object{head, tr}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGraphRefusesUnreachableAndUnprovenUpdates(t *testing.T) {
	cases := []struct {
		name  string
		build graphBuild
		want  error
	}{
		{"missing tree object", func(_ *testing.T, in *egress.Intent, _ memoryObjects, o []*object) (*object, []*object) {
			return o[0], []*object{o[0], o[2]}
		}, ErrSource},
		{"object only reachable through a known object", func(_ *testing.T, in *egress.Intent, known memoryObjects, o []*object) (*object, []*object) {
			head := commit(in.Format, in.Known[1].OID, in.Base)
			return head, []*object{head, o[2]}
		}, ErrSource},
		{"unreachable object", func(_ *testing.T, in *egress.Intent, _ memoryObjects, o []*object) (*object, []*object) {
			extra := &object{kind: "blob", data: []byte("approved but unreachable")}
			return o[0], []*object{o[0], o[1], o[2], extra}
		}, ErrSource},
		{"head does not descend from the task base", func(_ *testing.T, in *egress.Intent, known memoryObjects, o []*object) (*object, []*object) {
			other := opaqueCommit("tree " + in.Known[1].OID)
			in.Base = addKnown(in, known, other)
			return o[0], []*object{o[0], o[1], o[2]}
		}, ErrScope},
		{"head does not descend from the remote predecessor", func(_ *testing.T, in *egress.Intent, known memoryObjects, o []*object) (*object, []*object) {
			other := opaqueCommit("tree " + in.Known[1].OID)
			in.Old = addKnown(in, known, other)
			return o[0], []*object{o[0], o[1], o[2]}
		}, ErrScope},
		{"known ancestor is not parseable", func(_ *testing.T, in *egress.Intent, known memoryObjects, o []*object) (*object, []*object) {
			broken := &object{kind: "commit", data: []byte("not a commit at all")}
			base := addKnown(in, known, broken)
			head := commit(in.Format, in.Known[1].OID, base)
			in.Base = base
			return head, []*object{head}
		}, ErrSource},
		{"parent is a tree", func(_ *testing.T, in *egress.Intent, _ memoryObjects, o []*object) (*object, []*object) {
			head := commit(in.Format, objID(in.Format, o[1]), objID(in.Format, o[1]))
			return head, []*object{head, o[1], o[2]}
		}, ErrSource},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runGraph(t, tc.build)
			wantIs(t, err, tc.want)
		})
	}
}

// The predecessor and the baseline are both proven from actual commit bytes,
// across merges and shared ancestors, never by name or claim.
func TestGraphProvesBothAncestorsThroughAMergeDiamond(t *testing.T) {
	build := func(withPredecessor bool) graphBuild {
		return func(_ *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
			root := in.Known[1].OID
			z := addKnown(in, known, opaqueCommit("tree "+root+"\nauthor z"))
			a := opaqueCommit("tree " + root + "\nparent " + in.Base + "\nauthor a")
			if withPredecessor {
				a = opaqueCommit("tree " + root + "\nparent " + z + "\nparent " + in.Base)
			}
			b := opaqueCommit("tree " + root + "\nparent " + in.Base + "\nauthor b")
			head := opaqueCommit("tree " + root + "\nparent " + objID(in.Format, a) + "\nparent " + objID(in.Format, b))
			in.Old = z
			return head, []*object{head, a, b}
		}
	}
	if _, err := runGraph(t, build(true)); err != nil {
		t.Fatal(err)
	}
	_, err := runGraph(t, build(false))
	wantIs(t, err, ErrScope)
}

// Content-addressed trees may share subtrees. A chain of trees that each name
// the next twice is legitimate and small, but would take exponential work if
// the walk did not visit every object once.
func TestGraphWalksSharedSubtreesOnce(t *testing.T) {
	const depth = 8
	_, err := runGraph(t, func(_ *testing.T, in *egress.Intent, known memoryObjects, objects []*object) (*object, []*object) {
		blob := objects[2]
		introduced := []*object{blob}
		child := objID(in.Format, blob)
		kind := "100644"
		for i := 0; i < depth; i++ {
			tr := rawTree(in.Format, [2]string{kind + " a", child}, [2]string{kind + " b", child})
			introduced = append(introduced, tr)
			child = objID(in.Format, tr)
			kind = "40000"
		}
		head := commit(in.Format, child, in.Base)
		in.Limits.Objects = len(introduced) + 1 + len(in.Known)
		return head, append([]*object{head}, introduced...)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Real baselines have history of their own. The walk stops at the commits it
// was asked to prove and must not demand that older ancestors be declared.
func TestGraphDoesNotDemandTheHistoryBehindTheProvenAncestors(t *testing.T) {
	// Creating a new branch (no predecessor): the baseline is the last proof
	// required, so its own undeclared parents are never consulted.
	_, err := runGraph(t, func(_ *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
		root := in.Known[1].OID
		base := addKnown(in, known, opaqueCommit("tree "+root+"\nparent "+fakeOID(40)+"\nparent "+fakeOID(41)+"\nauthor base"))
		in.Base = base
		head := opaqueCommit("tree " + root + "\nparent " + base)
		return head, []*object{head}
	})
	if err != nil {
		t.Fatal(err)
	}
	// Fail closed: while a proof is still outstanding the walk may only step
	// through declared commits. It does not guess past an undeclared parent.
	_, err = runGraph(t, func(_ *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
		root := in.Known[1].OID
		base := addKnown(in, known, opaqueCommit("tree "+root+"\nparent "+fakeOID(40)+"\nauthor base"))
		old := addKnown(in, known, opaqueCommit("tree "+root+"\nauthor old"))
		in.Base, in.Old = base, old
		head := opaqueCommit("tree " + root + "\nparent " + old + "\nparent " + base)
		return head, []*object{head}
	})
	wantIs(t, err, ErrSource)
}

// The empty file is an ordinary Git object; it costs nothing to expand and
// must not be mistaken for a refused zero-length charge.
func TestGraphAcceptsTheEmptyBlobAndEmptyTree(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			in, known, _ := packFixture(t, format)
			empty := &object{kind: "blob"}
			emptyTree := &object{kind: "tree"}
			tr := rawTree(format, [2]string{"40000 dir", objID(format, emptyTree)}, [2]string{"100644 empty.txt", objID(format, empty)})
			head := commit(format, objID(format, tr), in.Base)
			objects := []*object{head, tr, empty, emptyTree}
			in = setObjects(in, format, head, objects)
			p, err := readWire(t, in, known, makePack(t, format, objects))
			if err != nil {
				t.Fatal(err)
			}
			out, n, err := p.canonical()
			if err != nil || n != 4 {
				t.Fatal(n, err)
			}
			if _, err = readWire(t, in, known, out); err != nil {
				t.Fatal("canonical form with empty objects does not round-trip:", err)
			}
		})
	}
}

func TestGraphAcceptsAPredecessorInsideThePack(t *testing.T) {
	_, err := runGraph(t, func(_ *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
		root := in.Known[1].OID
		mid := opaqueCommit("tree " + root + "\nparent " + in.Base + "\nauthor mid")
		head := opaqueCommit("tree " + root + "\nparent " + objID(in.Format, mid))
		in.Old = objID(in.Format, mid)
		return head, []*object{head, mid}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTreeEntriesFollowGitOrderWithSubtreesComparedAsNameSlash(t *testing.T) {
	id := bytes.Repeat([]byte{1}, 20)
	entry := func(mode, name string) []byte { return append([]byte(mode+" "+name+"\x00"), id...) }
	// "a.c" (0x2e) sorts before the subtree "a" compared as "a/" (0x2f).
	if _, err := treeLinks(join(entry("100644", "a.c"), entry("40000", "a")), "sha1", 20, 16); err != nil {
		t.Fatalf("valid Git order refused: %v", err)
	}
	for name, data := range map[string][]byte{
		"subtree before a name it sorts after": join(entry("40000", "a"), entry("100644", "a.c")),
		"plain reverse order":                  join(entry("100644", "b"), entry("100644", "a")),
	} {
		if _, err := treeLinks(data, "sha1", 20, 16); !errors.Is(err, ErrSource) {
			t.Fatalf("%s: got %v, want ErrSource", name, err)
		}
	}
}
