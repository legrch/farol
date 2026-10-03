package boot

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Every OS operation below is an in-memory double. These tests create no files,
// explicit goroutines, filesystem locks/claims or native descriptors, and never
// call QualifyProfile. They do not qualify Darwin flags or real kernel races.
type profileEntry struct {
	parent int
	name   string
}
type profileDouble struct {
	metadata map[int]profileMetadata
	entries  map[profileEntry]int
	parents  map[int]int
	paths    map[int]string
	opened   []int
	closed   []int
	closeErr map[int]error
	openErr  map[int]error
	statErr  map[int]error
	onOpen   func(int)
}

var _ profileOS = (*profileDouble)(nil)

func newProfileDouble() (*profileDouble, ProfileBinding) {
	binding := ProfileBinding{ProfileID: "Selected/profile:One", Root: "/profiles/selected", Device: 7, Inode: 3}
	m := func(device, inode uint64, uid, mode uint32) profileMetadata {
		return profileMetadata{device: device, inode: inode, uid: uid, mode: profileDirectoryType | mode}
	}
	return &profileDouble{
		metadata: map[int]profileMetadata{0: m(1, 1, 0, 0755), 1: m(7, 2, 0, 0755), 2: m(7, 3, 501, 0700), 3: m(7, 4, 501, 0700), 4: m(7, 5, 501, 0700)},
		entries:  map[profileEntry]int{{0, "profiles"}: 1, {1, "selected"}: 2, {2, "computer"}: 3, {2, "chat"}: 4},
		parents:  map[int]int{1: 0, 2: 1, 3: 2, 4: 2},
		paths:    map[int]string{0: "/", 1: "/profiles", 2: binding.Root, 3: filepath.Join(binding.Root, "computer"), 4: filepath.Join(binding.Root, "chat")},
		closeErr: map[int]error{}, openErr: map[int]error{}, statErr: map[int]error{},
	}, binding
}
func (*profileDouble) uid() uint32 { return 501 }
func (d *profileDouble) openRoot() (int, error) {
	d.opened = append(d.opened, 0)
	return 0, nil
}
func (d *profileDouble) openDirectory(parent int, name string) (int, error) {
	fd, ok := d.entries[profileEntry{parent, name}]
	if !ok {
		return -1, profileFailure(ProfileUnavailable)
	}
	if err := d.openErr[fd]; err != nil {
		return -1, err
	}
	d.opened = append(d.opened, fd)
	if d.onOpen != nil {
		d.onOpen(fd)
	}
	return fd, nil
}
func (d *profileDouble) stat(fd int) (profileMetadata, error) {
	return d.metadata[fd], d.statErr[fd]
}
func (d *profileDouble) statRoot() (profileMetadata, error) { return d.metadata[0], nil }
func (d *profileDouble) statEntry(parent int, name string) (profileMetadata, error) {
	var fd int
	var ok bool
	if name == ".." {
		fd, ok = d.parents[parent]
	} else {
		fd, ok = d.entries[profileEntry{parent, name}]
	}
	if !ok {
		return profileMetadata{}, profileFailure(ProfileUnavailable)
	}
	return d.metadata[fd], nil
}
func (d *profileDouble) physicalPath(fd int) (string, error) { return d.paths[fd], nil }
func (d *profileDouble) close(fd int) error {
	d.closed = append(d.closed, fd)
	return d.closeErr[fd]
}
func requireProfileFailure(t *testing.T, err error, code ProfileCode) {
	t.Helper()
	var failure *ProfileFailure
	if !errors.As(err, &failure) || failure == nil || failure.Code != code || failure.Retry() != "never" || !errors.Is(err, code) {
		t.Fatalf("expected nonretryable %s; got %v", code, err)
	}
	if failure.OutcomeUnknown() != (code == ProfileCleanupUnknown) {
		t.Fatalf("unexpected descriptor cleanup outcome: %v", err)
	}
}
func requireExactProfileCleanup(t *testing.T, d *profileDouble) {
	t.Helper()
	want := append([]int(nil), d.opened...)
	for i, j := 0, len(want)-1; i < j; i, j = i+1, j-1 {
		want[i], want[j] = want[j], want[i]
	}
	if !reflect.DeepEqual(want, d.closed) {
		t.Fatalf("cleanup mismatch: opened %v; closed %v", d.opened, d.closed)
	}
}

func TestProfileBindingParsing(t *testing.T) {
	_, binding := newProfileDouble()
	for _, id := range []string{"A", "profile-1._:/Z", strings.Repeat("a", 120)} {
		candidate := binding
		candidate.ProfileID = id
		if !validProfileBinding(candidate) {
			t.Fatalf("canonical exact ID rejected: %q", id)
		}
	}
	for _, id := range []string{"", ".profile", "_profile", " profile", "profile ", "é", "a\x00b", "a\\b", strings.Repeat("a", 121), strings.Repeat("a", 128)} {
		candidate := binding
		candidate.ProfileID = id
		d, _ := newProfileDouble()
		q, err := qualifyProfile(candidate, d)
		if q != nil || len(d.opened) != 0 {
			t.Fatal("invalid ID performed IO")
		}
		requireProfileFailure(t, err, ProfileInvalid)
	}
	for _, path := range []string{"", "/", "profiles/selected", "/profiles//selected", "/profiles/./selected", "/profiles/../selected", "/profiles/selected/", "/profiles/\x00selected", "/profiles/\nselected", "/" + strings.Repeat("a", 256), "/" + string([]byte{255}), "/" + strings.Repeat("a/", 2048) + "a"} {
		candidate := binding
		candidate.Root = path
		d, _ := newProfileDouble()
		q, err := qualifyProfile(candidate, d)
		if q != nil || len(d.opened) != 0 {
			t.Fatal("invalid path performed IO")
		}
		requireProfileFailure(t, err, ProfileInvalid)
	}
	for _, field := range []string{"device", "inode"} {
		candidate := binding
		if field == "device" {
			candidate.Device = 0
		} else {
			candidate.Inode = 0
		}
		d, _ := newProfileDouble()
		_, err := qualifyProfile(candidate, d)
		requireProfileFailure(t, err, ProfileInvalid)
		if len(d.opened) != 0 {
			t.Fatal("missing trusted identity performed IO")
		}
	}
}

func TestProfileQualifiedRootsAndSharedCleanup(t *testing.T) {
	d, binding := newProfileDouble()
	q, err := qualifyProfile(binding, d)
	if err != nil {
		t.Fatal(err)
	}
	alias := *q
	computer, chat, err := alias.Roots()
	wantComputer := NativeRoot{Path: "/profiles/selected/computer", ProfileID: binding.ProfileID, Device: 7, Inode: 4, OwnerUID: 501, Mode: 0700}
	wantChat := NativeRoot{Path: "/profiles/selected/chat", ProfileID: binding.ProfileID, Device: 7, Inode: 5, OwnerUID: 501, Mode: 0700}
	if err != nil || computer != wantComputer || chat != wantChat || len(d.closed) != 0 {
		t.Fatalf("roots/lifetime mismatch: %v %v %v", computer, chat, err)
	}
	computer.Path = "/alternate"
	binding.Root = "/alternate"
	again, _, err := q.Roots()
	if err != nil || again != wantComputer {
		t.Fatal("caller mutated the retained binding")
	}
	if err := alias.Close(); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	requireExactProfileCleanup(t, d)
	computer, chat, err = q.Roots()
	requireProfileFailure(t, err, ProfileUnavailable)
	if computer != (NativeRoot{}) || chat != (NativeRoot{}) {
		t.Fatal("closed qualification returned usable values")
	}
}

func TestProfileQualificationRefusesPhysicalMismatch(t *testing.T) {
	cases := []struct {
		name   string
		change func(*profileDouble, *ProfileBinding)
		code   ProfileCode
	}{
		{"root identity", func(d *profileDouble, b *ProfileBinding) { b.Inode++ }, ProfileRefused},
		{"root device", func(d *profileDouble, b *ProfileBinding) { b.Device++ }, ProfileRefused},
		{"root owner", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[2]; m.uid++; d.metadata[2] = m }, ProfileRefused},
		{"root permissions", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[2]; m.mode |= 0050; d.metadata[2] = m }, ProfileRefused},
		{"special permissions", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[3]; m.mode |= 02000; d.metadata[3] = m }, ProfileRefused},
		{"shared ancestor", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[1]; m.mode |= 0002; d.metadata[1] = m }, ProfileRefused},
		{"foreign ancestor", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[1]; m.uid = 502; d.metadata[1] = m }, ProfileRefused},
		{"component symlink", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[1]; m.mode = 0120755; d.metadata[1] = m }, ProfileRefused},
		{"child symlink", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[3]; m.mode = 0120700; d.metadata[3] = m }, ProfileRefused},
		{"child file", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[4]; m.mode = 0100700; d.metadata[4] = m }, ProfileRefused},
		{"foreign child", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[4]; m.uid++; d.metadata[4] = m }, ProfileRefused},
		{"child permissions", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[4]; m.mode |= 0001; d.metadata[4] = m }, ProfileRefused},
		{"missing computer", func(d *profileDouble, b *ProfileBinding) { delete(d.entries, profileEntry{2, "computer"}) }, ProfileUnavailable},
		{"missing chat", func(d *profileDouble, b *ProfileBinding) { delete(d.entries, profileEntry{2, "chat"}) }, ProfileUnavailable},
		{"different device", func(d *profileDouble, b *ProfileBinding) { m := d.metadata[3]; m.device++; d.metadata[3] = m }, ProfileRefused},
		{"aliased children", func(d *profileDouble, b *ProfileBinding) { d.metadata[4] = d.metadata[3] }, ProfileRefused},
		{"different parent", func(d *profileDouble, b *ProfileBinding) { d.parents[3] = 1 }, ProfileRefused},
		{"case alias", func(d *profileDouble, b *ProfileBinding) { d.paths[2] = "/profiles/Selected" }, ProfileRefused},
		{"child path alias", func(d *profileDouble, b *ProfileBinding) { d.paths[3] = "/alternate/computer" }, ProfileRefused},
		{"open refused", func(d *profileDouble, b *ProfileBinding) { d.openErr[3] = profileFailure(ProfileRefused) }, ProfileRefused},
		{"unclassified boundary", func(d *profileDouble, b *ProfileBinding) { d.statErr[3] = errors.New("private raw diagnostic") }, ProfileUnavailable},
		{"open race", func(d *profileDouble, b *ProfileBinding) {
			d.onOpen = func(fd int) {
				if fd == 3 {
					m := d.metadata[3]
					m.inode++
					d.metadata[3] = m
				}
			}
		}, ProfileRefused},
	}
	for _, tc := range cases {
		t.Log(tc.name)
		d, binding := newProfileDouble()
		tc.change(d, &binding)
		q, err := qualifyProfile(binding, d)
		if q != nil {
			t.Fatal("mismatch returned qualification")
		}
		requireProfileFailure(t, err, tc.code)
		requireExactProfileCleanup(t, d)
	}
}

func TestProfileContinuityFailureIsSticky(t *testing.T) {
	for _, kind := range []string{"named replacement", "permissions", "reparent", "physical path", "ancestor"} {
		t.Log(kind)
		d, binding := newProfileDouble()
		q, err := qualifyProfile(binding, d)
		if err != nil {
			t.Fatal(err)
		}
		original := d.metadata[3]
		switch kind {
		case "named replacement":
			d.metadata[9] = original
			d.entries[profileEntry{2, "computer"}] = 9
			m := d.metadata[9]
			m.inode++
			d.metadata[9] = m
		case "permissions":
			m := original
			m.mode |= 0004
			d.metadata[3] = m
		case "reparent":
			d.parents[3] = 1
		case "physical path":
			d.paths[3] = "/alternate/computer"
		case "ancestor":
			m := d.metadata[1]
			m.inode++
			d.metadata[1] = m
		}
		computer, chat, first := q.Roots()
		requireProfileFailure(t, first, ProfileRefused)
		if computer != (NativeRoot{}) || chat != (NativeRoot{}) {
			t.Fatal("failed continuity returned roots")
		}
		fresh, _ := newProfileDouble()
		d.metadata, d.entries, d.parents, d.paths = fresh.metadata, fresh.entries, fresh.parents, fresh.paths
		_, _, next := q.Roots()
		if next != first {
			t.Fatal("failure allowed recovery/requalification")
		}
		if err := q.Close(); err != nil {
			t.Fatal(err)
		}
		requireExactProfileCleanup(t, d)
	}
}

func TestProfileCleanupUnknownNeverRetries(t *testing.T) {
	d, binding := newProfileDouble()
	q, err := qualifyProfile(binding, d)
	if err != nil {
		t.Fatal(err)
	}
	d.closeErr[3] = errors.New("close outcome unknown")
	first := q.Close()
	requireProfileFailure(t, first, ProfileCleanupUnknown)
	if q.Close() != first {
		t.Fatal("close failure was not retained")
	}
	requireExactProfileCleanup(t, d)
	d, binding = newProfileDouble()
	d.closeErr[0] = errors.New("close outcome unknown")
	binding.Inode++
	q, err = qualifyProfile(binding, d)
	if q != nil {
		t.Fatal("failed cleanup returned qualification")
	}
	requireProfileFailure(t, err, ProfileCleanupUnknown)
	requireExactProfileCleanup(t, d)
}

func TestProfileFailureAndZeroValueClassification(t *testing.T) {
	for _, err := range []error{errors.New("private diagnostic"), profileFailure(ProfileCode("unrecognized"))} {
		requireProfileFailure(t, classifiedProfileFailure(err), ProfileUnavailable)
	}
	for _, q := range []*QualifiedProfile{nil, {}} {
		computer, chat, err := q.Roots()
		requireProfileFailure(t, err, ProfileUnavailable)
		if computer != (NativeRoot{}) || chat != (NativeRoot{}) || q.Close() != nil {
			t.Fatal("zero value created roots or cleanup authority")
		}
	}
}
