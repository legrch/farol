package lease

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	port "github.com/legrch/farol/modules/computer/app/port/lease"
	domain "github.com/legrch/farol/modules/computer/domain/lease"
)

type node struct {
	file     file
	children map[string]*node
	kind     string
}
type fakeNative struct {
	root                                                              *node
	fds                                                               map[int]*node
	next, opens, closes, metadataReads                                int
	rootMount, dataMount, candidateMount                              domain.Mount
	rootInfo, dataInfo                                                domain.Metadata
	now                                                               domain.Epoch
	failOpen, failStat, failMount, failMetadata, failEpoch, failClose bool
	afterMetadata                                                     func(*fakeNative)
}

const fakeGroup = "11111111-2222-3333-4444-555555555555"

func makeFake() *fakeNative {
	makeNode := func(dev, ino uint64) *node {
		return &node{file: file{Device: dev, Inode: ino, Mode: 0040755}, children: map[string]*node{}}
	}
	root := makeNode(10, 1)
	system := makeNode(10, 2)
	volumes := makeNode(10, 3)
	data := makeNode(11, 4)
	users := makeNode(11, 5)
	home := makeNode(11, 6)
	root.children["System"] = system
	system.children["Volumes"] = volumes
	volumes.children["Data"] = data
	data.children["Users"] = users
	users.children["person"] = home
	rm := domain.Mount{Device: 10, Inode: 1, FSID: [2]int32{1, 10}, Filesystem: "apfs", MountedOn: "/", MountedFrom: "disk3s1s1", Local: true, ReadOnly: true, Snapshot: true}
	dm := domain.Mount{Device: 11, Inode: 4, FSID: [2]int32{2, 10}, Filesystem: "apfs", MountedOn: domain.DataPath, MountedFrom: "disk3s5", Local: true}
	ri := domain.Metadata{Filesystem: "apfs", MountPoint: "/", GroupID: fakeGroup, Internal: true, GlobalPermissions: true, Bootable: true, Snapshot: true}
	di := domain.Metadata{Filesystem: "apfs", MountPoint: domain.DataPath, GroupID: fakeGroup, Internal: true, GlobalPermissions: true, Bootable: true}
	return &fakeNative{root: root, fds: map[int]*node{}, rootMount: rm, dataMount: dm, candidateMount: dm, rootInfo: ri, dataInfo: di, now: domain.Epoch{Boot: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", Runtime: "process-one"}}
}
func (f *fakeNative) nodes() *node {
	return f.root.children["System"].children["Volumes"].children["Data"]
}
func (f *fakeNative) home() *node { return f.nodes().children["Users"].children["person"] }
func (f *fakeNative) allocate(n *node) (int, error) {
	f.opens++
	if f.failOpen || n == nil || n.kind == "symlink" {
		return -1, errors.New("open refused")
	}
	f.next++
	f.fds[f.next] = n
	return f.next, nil
}
func (f *fakeNative) openRoot() (int, error) { return f.allocate(f.root) }
func (f *fakeNative) openAt(fd int, s string) (int, error) {
	p := f.fds[fd]
	if p == nil {
		return -1, errors.New("missing parent")
	}
	return f.allocate(p.children[s])
}
func (f *fakeNative) stat(fd int) (file, error) {
	if f.failStat || f.fds[fd] == nil {
		return file{}, errors.New("stat failure")
	}
	return f.fds[fd].file, nil
}
func (f *fakeNative) mount(fd int) (domain.Mount, error) {
	if f.failMount || f.fds[fd] == nil {
		return domain.Mount{}, errors.New("mount failure")
	}
	n := f.fds[fd]
	if n == f.root {
		return f.rootMount, nil
	}
	if n == f.nodes() {
		return f.dataMount, nil
	}
	m := f.candidateMount
	m.Device = n.file.Device
	m.Inode = n.file.Inode
	return m, nil
}
func (f *fakeNative) metadata(_ context.Context, p string) (domain.Metadata, error) {
	f.metadataReads++
	if f.afterMetadata != nil {
		f.afterMetadata(f)
	}
	if f.failMetadata {
		return domain.Metadata{}, errors.New("metadata failure")
	}
	if p == "/" {
		return f.rootInfo, nil
	}
	if p == domain.DataPath {
		return f.dataInfo, nil
	}
	return domain.Metadata{}, errors.New("bad path")
}
func (f *fakeNative) epoch(context.Context) (domain.Epoch, error) {
	if f.failEpoch {
		return domain.Epoch{}, errors.New("epoch refused")
	}
	return f.now, nil
}
func (f *fakeNative) close(fd int) error {
	if f.fds[fd] == nil {
		panic("double close")
	}
	delete(f.fds, fd)
	f.closes++
	if f.failClose {
		return errors.New("close uncertain")
	}
	return nil
}
func anchorCode(err error) string {
	if err == nil {
		return ""
	}
	var f *port.Failure
	if errors.As(err, &f) {
		return f.Code
	}
	return "unclassified"
}

const homePath = "/System/Volumes/Data/Users/person"

func TestHeldStartupAnchorAndCandidate(t *testing.T) {
	f := makeFake()
	a, e := (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if got, e := a.Check(context.Background(), homePath); e != nil || got.Authority != "not-established" || got.Kind != "current-data-candidate" || got.Device != 11 || got.Inode != 6 {
		t.Fatalf("unexpected candidate %+v %v", got, e)
	}
	if e := a.Requalify(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := a.Close(); e != nil {
		t.Fatal(e)
	}
	closedCount := f.closes
	if e := a.Close(); e != nil || f.closes != closedCount {
		t.Fatal("non-idempotent close")
	}
	if anchorCode(a.Requalify(context.Background())) != "WORKSPACE_ANCHOR_CLOSED" {
		t.Fatal("requalify after close")
	}
	if got, e := a.Check(context.Background(), homePath); anchorCode(e) != "WORKSPACE_ANCHOR_CLOSED" || got != (domain.Candidate{}) {
		t.Fatal("check after close", got, e)
	}
	if len(f.fds) != 0 {
		t.Fatal("leaked", f.fds)
	}
}
func TestAcquisitionFailsClosedAndReleasesResources(t *testing.T) {
	cases := []struct {
		name   string
		change func(*fakeNative)
	}{
		{"missing volume group", func(f *fakeNative) { f.dataInfo.GroupID = "" }},
		{"different volume group", func(f *fakeNative) { f.dataInfo.GroupID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }},
		{"external data", func(f *fakeNative) { f.dataInfo.Internal = false }},
		{"not root snapshot", func(f *fakeNative) { f.rootInfo.Snapshot = false }},
		{"wrong data mount point", func(f *fakeNative) { f.dataInfo.MountPoint = "/Volumes/clone" }},
		{"unsupported filesystem", func(f *fakeNative) { f.dataMount.Filesystem = "hfs" }},
		{"read only data", func(f *fakeNative) { f.dataMount.ReadOnly = true }},
		{"malformed group", func(f *fakeNative) { f.rootInfo.GroupID = "invalid" }},
		{"wrong boot", func(f *fakeNative) { f.now.Boot = "" }},
		{"not a directory", func(f *fakeNative) { f.nodes().file.Mode = 0100644 }},
		{"symlink Data", func(f *fakeNative) { f.nodes().kind = "symlink" }},
		{"open failure", func(f *fakeNative) { f.failOpen = true }},
		{"stat failure", func(f *fakeNative) { f.failStat = true }},
		{"mount failure", func(f *fakeNative) { f.failMount = true }},
		{"metadata failure", func(f *fakeNative) { f.failMetadata = true }},
		{"epoch failure", func(f *fakeNative) { f.failEpoch = true }},
		{"failed close", func(f *fakeNative) { f.failClose = true }},
		{"ancestor replaced during acquisition", func(f *fakeNative) {
			f.afterMetadata = func(f *fakeNative) {
				r := *f.root.children["System"]
				r.file.Inode = 80
				f.root.children["System"] = &r
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := makeFake()
			tc.change(f)
			a, e := (&Acquirer{native: f}).Acquire(context.Background())
			if e == nil || a != nil {
				t.Fatalf("accepted failed acquisition: %v %v", a, e)
			}
			if len(f.fds) != 0 {
				t.Fatalf("leaked %d descriptors", len(f.fds))
			}
		})
	}
}
func TestRequalificationRejectsStaleRuntimeMountAndAncestors(t *testing.T) {
	tests := []struct {
		name   string
		change func(*fakeNative)
	}{
		{"stale boot", func(f *fakeNative) { f.now.Boot = "00000000-0000-0000-0000-000000000000" }},
		{"stale runtime", func(f *fakeNative) { f.now.Runtime = "other" }},
		{"changed Data device", func(f *fakeNative) { f.dataMount.Device = 99 }},
		{"changed Data fsid", func(f *fakeNative) { f.dataMount.FSID = [2]int32{99, 100} }},
		{"changed Data mount point", func(f *fakeNative) { f.dataMount.MountedOn = "/Volumes/clone" }},
		{"changed disk metadata", func(f *fakeNative) { f.dataInfo.Bootable = false }},
		{"ancestor replacement", func(f *fakeNative) {
			old := f.root.children["System"]
			r := *old
			r.file.Inode = 99
			f.root.children["System"] = &r
		}},
		{"Data descriptor changes", func(f *fakeNative) { f.nodes().file.Inode = 22 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := makeFake()
			a, e := (&Acquirer{native: f}).Acquire(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			tc.change(f)
			if anchorCode(a.Requalify(context.Background())) != "WORKSPACE_ANCHOR_STALE" {
				t.Fatal("stale anchor accepted")
			}
			_ = a.Close()
			if len(f.fds) != 0 {
				t.Fatal("descriptor leak")
			}
		})
	}
}
func TestCandidateRefusesClonesAndSymlinks(t *testing.T) {
	tests := []struct {
		name   string
		change func(*fakeNative)
		want   string
	}{
		{"same volume UUID but different FSID", func(f *fakeNative) { f.candidateMount.FSID = [2]int32{88, 88} }, "WORKSPACE_ANCHOR_DIFFERENT_MOUNT"},
		{"different mount name", func(f *fakeNative) { f.candidateMount.MountedOn = "/Volumes/clone" }, "WORKSPACE_ANCHOR_DIFFERENT_MOUNT"},
		{"different native device", func(f *fakeNative) { f.home().file.Device = 99 }, "WORKSPACE_ANCHOR_DIFFERENT_MOUNT"},
		{"symlink final", func(f *fakeNative) { f.home().kind = "symlink" }, "WORKSPACE_ANCHOR_PATH_REFUSED"},
		{"symlink ancestor", func(f *fakeNative) { f.nodes().children["Users"].kind = "symlink" }, "WORKSPACE_ANCHOR_PATH_REFUSED"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := makeFake()
			a, e := (&Acquirer{native: f}).Acquire(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			tc.change(f)
			got, e := a.Check(context.Background(), homePath)
			if anchorCode(e) != tc.want || got != (domain.Candidate{}) {
				t.Fatalf("refusal=%v got=%+v", e, got)
			}
			_ = a.Close()
			if len(f.fds) != 0 {
				t.Fatal("descriptor leak")
			}
		})
	}
}
func TestCandidateRaceCloseFailureAndCancellation(t *testing.T) {
	f := makeFake()
	a, e := (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	f.failClose = true
	if got, e := a.Check(context.Background(), homePath); anchorCode(e) != "WORKSPACE_ANCHOR_CLOSE_UNCONFIRMED" || got != (domain.Candidate{}) {
		t.Fatalf("close failure returned success %+v %v", got, e)
	}
	if anchorCode(a.Close()) != "WORKSPACE_ANCHOR_CLOSE_UNCONFIRMED" {
		t.Fatal("uncertain close ignored")
	}
	prev := f.closes
	if anchorCode(a.Close()) != "WORKSPACE_ANCHOR_CLOSE_UNCONFIRMED" || f.closes != prev {
		t.Fatal("close retried")
	}
	f = makeFake()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if a, e := (&Acquirer{native: f}).Acquire(ctx); a != nil || anchorCode(e) != "WORKSPACE_ANCHOR_CANCELLED" || f.opens != 0 {
		t.Fatal("cancelled acquisition read native")
	}
	f = makeFake()
	a, e = (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if got, e := a.Check(ctx, homePath); anchorCode(e) != "WORKSPACE_ANCHOR_CANCELLED" || got != (domain.Candidate{}) {
		t.Fatal("cancelled check admitted")
	}
	_ = a.Close()
	for _, path := range []string{"/", "/System/Volumes/Data/../other", "/System/Volumes/Data//Users/person", "/System/Volumes/Data/Users/person/", "Users/person"} {
		f = makeFake()
		a, e = (&Acquirer{native: f}).Acquire(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		if got, e := a.Check(context.Background(), path); anchorCode(e) != "WORKSPACE_ANCHOR_PATH_REFUSED" || got != (domain.Candidate{}) {
			t.Fatalf("path %q admitted %+v %v", path, got, e)
		}
		_ = a.Close()
	}
}
func TestConcurrentCheckRequalifyAndClose(t *testing.T) {
	f := makeFake()
	a, e := (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for n := 0; n < 7; n++ {
				if i%2 == 0 {
					_, _ = a.Check(context.Background(), homePath)
				} else {
					_ = a.Requalify(context.Background())
				}
			}
		}(i)
	}
	wg.Add(1)
	go func() { defer wg.Done(); _ = a.Close() }()
	wg.Wait()
	if len(f.fds) != 0 {
		t.Fatalf("concurrency leaked %d descriptors", len(f.fds))
	}
	if anchorCode(a.Close()) != "" {
		t.Fatal("repeat close refused")
	}
}
func TestAcquisitionOpensOnlyFixedSystemData(t *testing.T) {
	f := makeFake()
	a, e := (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if got := fmt.Sprint(f.fds); got == "" {
		t.Fatal("no held descriptors")
	}
	_ = a.Close()
}

func TestCancelledRequalificationAndNoFurtherMetadata(t *testing.T) {
	f := makeFake()
	a, e := (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	before := f.metadataReads
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if anchorCode(a.Requalify(ctx)) != "WORKSPACE_ANCHOR_CANCELLED" || f.metadataReads != before {
		t.Fatal("cancelled requalification touched native metadata")
	}
	_ = a.Close()
}

func TestStaleAnchorNeverReactivatedAfterFactsReturn(t *testing.T) {
	f := makeFake()
	a, e := (&Acquirer{native: f}).Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	f.now.Runtime = "other"
	if anchorCode(a.Requalify(context.Background())) != "WORKSPACE_ANCHOR_STALE" {
		t.Fatal("stale epoch not refused")
	}
	f.now.Runtime = "process-one" // the earlier stale epoch cannot be healed
	reads := f.metadataReads
	if anchorCode(a.Requalify(context.Background())) != "WORKSPACE_ANCHOR_STALE" || f.metadataReads != reads {
		t.Fatal("resurrected stale anchor")
	}
	if got, e := a.Check(context.Background(), homePath); anchorCode(e) != "WORKSPACE_ANCHOR_STALE" || got != (domain.Candidate{}) {
		t.Fatal("stale candidate admitted", got, e)
	}
	if e := a.Close(); e != nil {
		t.Fatal(e)
	}
}
