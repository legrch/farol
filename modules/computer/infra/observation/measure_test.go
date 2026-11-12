package observation

import (
	"context"
	"errors"
	"fmt"
	identityport "github.com/legrch/farol/modules/computer/app/port/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
	"strconv"
	"testing"
)

// Descriptor graph, not a path-stat mock: a descriptor retains its node after
// the parent link is substituted. The parent graph and open handles are distinct.
type node struct {
	identity fileIdentity
	children map[string]*node
	symlink  bool
}
type fakeOperations struct {
	volume                                string
	evidenceEdit                          func(*identity.Evidence)
	root                                  *node
	fds                                   map[int]*node
	next, opens, stats, closes, factCalls int
	failOpen, failStat                    int
	closeFail                             bool
	failFacts                             error
	hook                                  func(*fakeOperations)
	cancel                                context.CancelFunc
}

func newFake() *fakeOperations {
	mk := func(id uint64) *node {
		return &node{identity: fileIdentity{Device: 1, Inode: id, Mode: 0040700, UID: 501, BirthSeconds: 123, BirthNanoseconds: 4}, children: map[string]*node{}}
	}
	root, approved, work := mk(1), mk(2), mk(3)
	root.children["approved"] = approved
	approved.children["work"] = work
	return &fakeOperations{root: root, fds: map[int]*node{}, volume: "11111111-2222-3333-4444-555555555555"}
}
func (o *fakeOperations) target() *node { return o.root.children["approved"].children["work"] }
func (o *fakeOperations) open(n *node) (int, error) {
	o.opens++
	if o.opens == o.failOpen || n == nil || n.symlink {
		return 0, errors.New("no-follow refusal")
	}
	o.next++
	o.fds[o.next] = n
	return o.next, nil
}
func (o *fakeOperations) openRoot() (int, error) { return o.open(o.root) }
func (o *fakeOperations) openAt(fd int, name string) (int, error) {
	p := o.fds[fd]
	if p == nil {
		return 0, errors.New("closed parent")
	}
	return o.open(p.children[name])
}
func (o *fakeOperations) stat(fd int) (fileIdentity, error) {
	o.stats++
	if o.stats == o.failStat {
		return fileIdentity{}, errors.New("stat refused")
	}
	n := o.fds[fd]
	if n == nil {
		return fileIdentity{}, errors.New("closed descriptor")
	}
	return n.identity, nil
}
func (o *fakeOperations) close(fd int) error {
	o.closes++
	if o.fds[fd] == nil {
		panic("double close")
	}
	delete(o.fds, fd)
	if o.closeFail {
		return errors.New("close uncertain; no retry")
	}
	return nil
}
func (o *fakeOperations) uid() uint32 { return 501 }
func (o *fakeOperations) facts(ctx context.Context, fd int) (identity.Evidence, error) {
	o.factCalls++
	n := o.fds[fd]
	if n == nil {
		panic("closed descriptor used")
	}
	f := n.identity
	e := identity.Evidence{Schema: identity.EvidenceSchema, Filesystem: "apfs", VolumeUUID: o.volume, FileID: strconv.FormatUint(f.Inode, 10), BirthSeconds: strconv.FormatInt(f.BirthSeconds, 10), BirthNanoseconds: strconv.FormatInt(f.BirthNanoseconds, 10)}
	if o.evidenceEdit != nil {
		o.evidenceEdit(&e)
	}
	if o.hook != nil {
		o.hook(o)
	}
	if o.cancel != nil {
		o.cancel()
	}
	return e, o.failFacts
}
func code(err error) string {
	var f *identityport.Failure
	if errors.As(err, &f) {
		return f.Code
	}
	if err == nil {
		return ""
	}
	return "unclassified"
}
func TestObservationUsesHeldDescriptorsAndClosesAll(t *testing.T) {
	o := newFake()
	got, err := observe(context.Background(), "/approved/work", o)
	if err != nil || !got.Valid() || got.Binding.Device != "1" || got.Binding.Inode != "3" {
		t.Fatalf("%v %v", got, err)
	}
	if len(o.fds) != 0 || o.factCalls != 2 || o.closes != o.next {
		t.Fatalf("leak: %+v", o)
	}
	// Unrelated child content can change without invalidating directory identity.
	o = newFake()
	o.hook = func(o *fakeOperations) { o.target().children["new"] = &node{} }
	if _, err := observe(context.Background(), "/approved/work", o); err != nil {
		t.Fatal(err)
	}
}
func TestNegativeNativeBoundaries(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeOperations)
		want      string
	}{
		{"symlink target", func(o *fakeOperations) { o.target().symlink = true }, "WORKSPACE_PATH_REFUSED"},
		{"symlink ancestor", func(o *fakeOperations) { o.root.children["approved"].symlink = true }, "WORKSPACE_PATH_REFUSED"},
		{"not directory", func(o *fakeOperations) { o.target().identity.Mode = 0100600 }, "WORKSPACE_PATH_REFUSED"},
		{"different owner", func(o *fakeOperations) { o.target().identity.UID = 502 }, "WORKSPACE_PATH_REFUSED"},
		{"writable by group", func(o *fakeOperations) { o.target().identity.Mode |= 0020 }, "WORKSPACE_PATH_REFUSED"},
		{"writable by other", func(o *fakeOperations) { o.target().identity.Mode |= 0002 }, "WORKSPACE_PATH_REFUSED"},
		{"named folder substitution", func(o *fakeOperations) {
			o.hook = func(o *fakeOperations) {
				n := *o.target()
				n.identity.Inode = 9
				o.root.children["approved"].children["work"] = &n
			}
		}, "WORKSPACE_RACE_DETECTED"},
		{"symlink after measurement", func(o *fakeOperations) {
			o.hook = func(o *fakeOperations) {
				n := *o.target()
				n.symlink = true
				o.root.children["approved"].children["work"] = &n
			}
		}, "WORKSPACE_RACE_DETECTED"},
		{"ancestor substitution same target", func(o *fakeOperations) {
			o.hook = func(o *fakeOperations) {
				n := *o.root.children["approved"]
				n.identity.Inode = 19
				o.root.children["approved"] = &n
			}
		}, "WORKSPACE_RACE_DETECTED"},
		{"live device changes during operation", func(o *fakeOperations) { o.hook = func(o *fakeOperations) { o.target().identity.Device = 2 } }, "WORKSPACE_RACE_DETECTED"},
		{"permissions change during operation", func(o *fakeOperations) { o.hook = func(o *fakeOperations) { o.target().identity.Mode |= 0020 } }, "WORKSPACE_RACE_DETECTED"},
		{"volume changes between descriptor observations", func(o *fakeOperations) {
			o.hook = func(o *fakeOperations) { o.volume = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
		}, "WORKSPACE_RACE_DETECTED"},
		{"missing native UUID", func(o *fakeOperations) { o.volume = "" }, "WORKSPACE_IDENTITY_INVALID"},
		{"file ID disagrees with held descriptor", func(o *fakeOperations) { o.evidenceEdit = func(e *identity.Evidence) { e.FileID = "999" } }, "WORKSPACE_IDENTITY_INVALID"},
		{"unsupported evidence", func(o *fakeOperations) { o.failFacts = fail("WORKSPACE_IDENTITY_UNSUPPORTED") }, "WORKSPACE_IDENTITY_UNSUPPORTED"},
		{"close failure invalidates success", func(o *fakeOperations) { o.closeFail = true }, "WORKSPACE_IDENTITY_UNAVAILABLE"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := newFake()
			tc.configure(o)
			got, err := observe(context.Background(), "/approved/work", o)
			if code(err) != tc.want || got != (identity.Observation{}) {
				t.Fatalf("got %v err %v", got, err)
			}
			if len(o.fds) != 0 {
				t.Fatalf("%d unclosed descriptors", len(o.fds))
			}
		})
	}
}
func TestEveryOpenAndStatFailureClosesDescriptorsWithoutRetries(t *testing.T) {
	for _, kind := range []string{"open", "stat"} {
		limit := 9
		if kind == "stat" {
			limit = 15
		}
		for i := 1; i <= limit; i++ {
			t.Run(fmt.Sprintf("%s-%d", kind, i), func(t *testing.T) {
				o := newFake()
				if kind == "open" {
					o.failOpen = i
				} else {
					o.failStat = i
				}
				got, err := observe(context.Background(), "/approved/work", o)
				if err == nil || got != (identity.Observation{}) {
					t.Fatalf("fault %s %d accepted", kind, i)
				}
				if len(o.fds) != 0 {
					t.Fatalf("leaked %d", len(o.fds))
				}
				if kind == "open" && o.opens != i {
					t.Fatal("retried failed open")
				}
				if kind == "stat" && o.stats != i {
					t.Fatal("retried failed stat")
				}
			})
		}
	}
}
func TestCancellationAndNoPathTraversal(t *testing.T) {
	for _, path := range []string{"/", "../work", "/approved/../work", "/approved/work/", "/approved//work"} {
		o := newFake()
		if _, err := observe(context.Background(), path, o); err == nil || o.opens != 0 {
			t.Fatalf("path %q caused reads", path)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	o := newFake()
	o.cancel = cancel
	got, err := observe(ctx, "/approved/work", o)
	if code(err) != "WORKSPACE_REQUEST_CANCELLED" || got != (identity.Observation{}) || len(o.fds) != 0 || o.factCalls != 1 {
		t.Fatalf("%v %v", got, err)
	}
	o = newFake()
	if _, err := observe(nil, "/approved/work", o); code(err) != "WORKSPACE_REQUEST_CANCELLED" || o.opens != 0 {
		t.Fatal("nil context admitted")
	}
}
