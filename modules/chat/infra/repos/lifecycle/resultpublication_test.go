package lifecycle

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func TestResultPublicationCodecJoinsOnlyOriginalTerminalAndRetirement(t *testing.T) {
	r, p, s, _ := liveFixture(t, true)
	if _, err := s.Retire(context.Background()); err != nil {
		t.Fatal(err)
	}
	original, err := decode(p.raw, r.owner.limits)
	if err != nil {
		t.Fatal(err)
	}
	publication := port.ResultPublication{Version: 1, Root: fixtureRoot, StorageRoot: port.JournalRoot{Device: fixtureRoot.Device, Inode: fixtureRoot.Inode + 1, OwnerUID: fixtureRoot.OwnerUID}, Digest: [32]byte{7}, EncodedBytes: 1024}
	var terminal int
	for n, write := range original.Writes {
		if write.Entry.Kind == "finish" {
			terminal = n
		}
	}
	// This constructed codec vector is not live origin/retirement authority.
	original.Writes[terminal].Entry.ResultPublication = publication
	original.Retirement.Turns[0].ResultPublication = publication
	raw, err := encode(original, r.owner.limits)
	if err != nil {
		t.Fatal("closed reference rejected", err)
	}
	for name, mutate := range map[string]func(*record){
		"removed-terminal":   func(x *record) { x.Writes[terminal].Entry.ResultPublication = port.ResultPublication{} },
		"removed-retirement": func(x *record) { x.Retirement.Turns[0].ResultPublication = port.ResultPublication{} },
		"crossed-retirement": func(x *record) { x.Retirement.Turns[0].ResultPublication.Digest[0]++ },
		"wrong-root": func(x *record) {
			x.Writes[terminal].Entry.ResultPublication.Root.Inode++
			x.Retirement.Turns[0].ResultPublication = x.Writes[terminal].Entry.ResultPublication
		},
		"missing-storage-root": func(x *record) {
			x.Writes[terminal].Entry.ResultPublication.StorageRoot = port.JournalRoot{}
			x.Retirement.Turns[0].ResultPublication = x.Writes[terminal].Entry.ResultPublication
		},
		"not-terminal": func(x *record) { x.Writes[0].Entry.ResultPublication = publication },
		"old-format":   func(x *record) { x.Version = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			changed, err := decode(raw, r.owner.limits)
			if err != nil {
				t.Fatal(err)
			}
			mutate(&changed)
			if _, err := encode(changed, r.owner.limits); err == nil {
				t.Fatal("unjoined publication accepted")
			}
		})
	}
}

func TestVersionTwoWithoutPublicationsKeepsCanonicalMeaning(t *testing.T) {
	r, p, _, _ := liveFixture(t, false)
	stored, err := decode(p.raw, r.owner.limits)
	if err != nil || stored.Version != 3 {
		t.Fatal(err)
	}
	stored.Version = 2
	raw, err := encode(stored, r.owner.limits)
	if err != nil {
		t.Fatal(err)
	}
	old, err := decode(raw, r.owner.limits)
	if err != nil || old.Version != 2 || len(old.Writes) != len(stored.Writes) {
		t.Fatal("legacy metadata was upgraded or reinterpreted", err)
	}
	for _, w := range old.Writes {
		if w.Entry.ResultPublication != (port.ResultPublication{}) {
			t.Fatal("invented durable result")
		}
	}
}
