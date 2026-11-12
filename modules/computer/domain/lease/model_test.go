package lease

import "testing"

const group = "11111111-2222-3333-4444-555555555555"
const boot = "66666666-7777-8888-9999-aaaaaaaaaaaa"

func fixtures() (Mount, Mount, Metadata, Metadata, Epoch) {
	root := Mount{Device: 2, Inode: 1, FSID: [2]int32{2, 5}, Filesystem: "apfs", MountedOn: SystemPath, MountedFrom: "disk3s1s1", Local: true, ReadOnly: true, Snapshot: true}
	data := Mount{Device: 3, Inode: 2, FSID: [2]int32{3, 6}, Filesystem: "apfs", MountedOn: DataPath, MountedFrom: "disk3s5", Local: true}
	rootInfo := Metadata{Filesystem: "apfs", MountPoint: SystemPath, GroupID: group, Internal: true, GlobalPermissions: true, Bootable: true, Snapshot: true}
	dataInfo := Metadata{Filesystem: "apfs", MountPoint: DataPath, GroupID: group, Internal: true, GlobalPermissions: true, Bootable: true}
	return root, data, rootInfo, dataInfo, Epoch{Boot: boot, Runtime: "runtime-one"}
}
func TestQualifiedStartupDataPair(t *testing.T) {
	r, d, ri, di, e := fixtures()
	if !Qualified(r, d, ri, di, e) {
		t.Fatal("valid pair refused")
	}
	cases := []struct {
		name   string
		change func(*Mount, *Mount, *Metadata, *Metadata, *Epoch)
	}{
		{"missing group", func(_, _ *Mount, _, di *Metadata, _ *Epoch) { di.GroupID = "" }},
		{"different volume group", func(_, _ *Mount, _, di *Metadata, _ *Epoch) { di.GroupID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }},
		{"malformed group", func(_, _ *Mount, ri, _ *Metadata, _ *Epoch) { ri.GroupID = "0" }},
		{"external data", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.Local = false }},
		{"readonly data", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.ReadOnly = true }},
		{"no current fsid", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.FSID = [2]int32{} }},
		{"snapshot data", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.Snapshot = true }},
		{"root not snapshot", func(r, _ *Mount, _, _ *Metadata, _ *Epoch) { r.Snapshot = false }},
		{"root not readonly", func(r, _ *Mount, _, _ *Metadata, _ *Epoch) { r.ReadOnly = false }},
		{"other mount path", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.MountedOn = "/Volumes/clone" }},
		{"data metadata mount mismatch", func(_, _ *Mount, _, di *Metadata, _ *Epoch) { di.MountPoint = "/Volumes/clone" }},
		{"data other filesystem", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.Filesystem = "hfs" }},
		{"data not internal", func(_, _ *Mount, _, di *Metadata, _ *Epoch) { di.Internal = false }},
		{"root not internal", func(_, _ *Mount, ri, _ *Metadata, _ *Epoch) { ri.Internal = false }},
		{"ownership ignored", func(_, d *Mount, _, _ *Metadata, _ *Epoch) { d.IgnoreOwnership = true }},
		{"permissions disabled", func(_, _ *Mount, _, di *Metadata, _ *Epoch) { di.GlobalPermissions = false }},
		{"not bootable", func(_, _ *Mount, ri, _ *Metadata, _ *Epoch) { ri.Bootable = false }},
		{"stale boot", func(_, _ *Mount, _, _ *Metadata, e *Epoch) { e.Boot = "" }},
		{"stale runtime", func(_, _ *Mount, _, _ *Metadata, e *Epoch) { e.Runtime = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, d, ri, di, e := fixtures()
			tc.change(&r, &d, &ri, &di, &e)
			if Qualified(r, d, ri, di, e) {
				t.Fatal("accepted invalid startup pairing")
			}
		})
	}
}
func TestCandidateCannotAuthorizeDifferentMount(t *testing.T) {
	_, data, _, _, _ := fixtures()
	same := data
	same.Inode = 55
	c := CurrentCandidate("/System/Volumes/Data/home", data, same)
	if c.Authority != "not-established" || c.Kind != "current-data-candidate" || c.Inode != 55 {
		t.Fatalf("bad candidate %+v", c)
	}
	clone := same
	clone.FSID = [2]int32{99, 100} // copied UUID is irrelevant
	if c = CurrentCandidate("/System/Volumes/Data/home", data, clone); c != (Candidate{}) {
		t.Fatalf("different FSID admitted %+v", c)
	}
	clone = same
	clone.Device = 999
	if c = CurrentCandidate("/System/Volumes/Data/home", data, clone); c != (Candidate{}) {
		t.Fatalf("different st_dev admitted %+v", c)
	}
}
