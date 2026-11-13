package port

import "testing"

func TestResultPublicationRequiresClosedBoundedPhysicalIdentity(t *testing.T) {
	valid := ResultPublication{Version: 1, Root: JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}, StorageRoot: JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}, Digest: [32]byte{7}, EncodedBytes: MaxResultRecordBytes}
	if !valid.Valid() || (ResultPublication{}).Valid() {
		t.Fatal("wrong publication admission")
	}
	for _, change := range []func(*ResultPublication){
		func(p *ResultPublication) { p.Version = 0 },
		func(p *ResultPublication) { p.Version = 2 },
		func(p *ResultPublication) { p.Root.Device = 0 },
		func(p *ResultPublication) { p.Root.Inode = 0 },
		func(p *ResultPublication) { p.StorageRoot.Inode = 0 },
		func(p *ResultPublication) { p.StorageRoot.Inode = p.Root.Inode },
		func(p *ResultPublication) { p.StorageRoot.Device++ },
		func(p *ResultPublication) { p.StorageRoot.OwnerUID++ },
		func(p *ResultPublication) { p.Digest = [32]byte{} },
		func(p *ResultPublication) { p.EncodedBytes = 0 },
		func(p *ResultPublication) { p.EncodedBytes++ },
	} {
		p := valid
		change(&p)
		if p.Valid() {
			t.Fatal("invalid publication accepted", p)
		}
	}
}
