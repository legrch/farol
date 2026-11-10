package observation

import (
	"strings"
	"testing"
)

func validObservation() Observation {
	return Observation{Binding{Path: "/approved/work", Device: "16777234", Inode: "335036"}, Evidence{
		Schema: EvidenceSchema, Filesystem: "apfs", VolumeUUID: "11111111-2222-3333-4444-555555555555", FileID: "335036", BirthSeconds: "1700000000", BirthNanoseconds: "123"}}
}
func TestContinuityClassifications(t *testing.T) {
	tests := []struct {
		name   string
		change func(*Saved, *Observation, *Settlement)
		want   Assessment
	}{
		{"ordinary restart same observations", func(*Saved, *Observation, *Settlement) {}, SameMountCandidate},
		{"synthetic same volume folder new device", func(_ *Saved, c *Observation, _ *Settlement) { c.Binding.Device = "16777231" }, RemountCandidate},
		{"different volume same inode and device", func(_ *Saved, c *Observation, _ *Settlement) {
			c.Evidence.VolumeUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
		}, DifferentVolume},
		{"different folder at same path", func(_ *Saved, c *Observation, _ *Settlement) {
			c.Binding.Inode = "335037"
			c.Evidence.FileID = "335037"
		}, DifferentDirectory},
		{"reused inode different birth", func(_ *Saved, c *Observation, _ *Settlement) { c.Evidence.BirthNanoseconds = "124" }, DifferentDirectory},
		{"different path same identity", func(_ *Saved, c *Observation, _ *Settlement) { c.Binding.Path = "/approved/other" }, DifferentPath},
		{"legacy needs owner", func(s *Saved, _ *Observation, _ *Settlement) { s.Evidence = nil }, ReconfirmationRequired},
		{"missing volume UUID", func(_ *Saved, c *Observation, _ *Settlement) { c.Evidence.VolumeUUID = "" }, InvalidEvidence},
		{"unsupported filesystem", func(_ *Saved, c *Observation, _ *Settlement) { c.Evidence.Filesystem = "hfs" }, InvalidEvidence},
		{"saved ID inconsistent", func(s *Saved, _ *Observation, _ *Settlement) { s.Evidence.FileID = "9" }, InvalidEvidence},
		{"observed ID inconsistent", func(_ *Saved, c *Observation, _ *Settlement) { c.Evidence.FileID = "9" }, InvalidEvidence},
		{"unknown persisted result", func(_ *Saved, _ *Observation, s *Settlement) { *s = "outcome-unknown" }, Unresolved},
		{"missing settlement", func(_ *Saved, _ *Observation, s *Settlement) { *s = "" }, Unresolved},
		{"unknown dominates legacy", func(s *Saved, _ *Observation, v *Settlement) { s.Evidence = nil; *v = "unknown" }, Unresolved},
		{"unknown dominates malformed", func(s *Saved, _ *Observation, v *Settlement) { s.Evidence.Schema = "bad"; *v = "unknown" }, Unresolved},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cur := validObservation()
			old := cur.Evidence
			saved := Saved{cur.Binding, &old}
			state := Settled
			tc.change(&saved, &cur, &state)
			if got := Compare(saved, cur, state); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
func TestIndistinguishableCloneIsOnlyCandidateNeverAuthority(t *testing.T) {
	// A byte-for-byte clone/restore can duplicate UUID, ID and birth time. The
	// comparator cannot resolve that threat: neither label is an approval.
	cur := validObservation()
	old := cur.Evidence
	saved := Saved{cur.Binding, &old}
	cur.Binding.Device = "77"
	if Compare(saved, cur, Settled) != RemountCandidate {
		t.Fatal("expected diagnostic candidate only")
	}
}
func TestCanonicalAndNumericBounds(t *testing.T) {
	for _, path := range []string{"", "/", "relative", "/a/", "/a//b", "/a/../b", "/a/./b", "/a\\b", "/a\x00b", "/a\nb", "/" + strings.Repeat("a", 256), "/" + strings.Repeat("a/", 256) + "b"} {
		if CanonicalPath(path) {
			t.Errorf("accepted %q", path)
		}
	}
	for _, path := range []string{"/a", "/a b/é", "/a/.hidden"} {
		if !CanonicalPath(path) {
			t.Errorf("refused %q", path)
		}
	}
	for _, v := range []string{"0", "-1", "+1", "01", "18446744073709551616", "1e3", " 1"} {
		o := validObservation()
		o.Binding.Device = v
		if o.Valid() {
			t.Errorf("accepted device %s", v)
		}
	}
	o := validObservation()
	o.Binding.Inode = "18446744073709551615"
	o.Evidence.FileID = o.Binding.Inode
	if !o.Valid() {
		t.Fatal("uint64 must remain lossless")
	}
}
func TestEvidenceCodecStrict(t *testing.T) {
	base := validObservation().Evidence
	raw, err := EncodeEvidence(base)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseEvidence(raw)
	if err != nil || got != base {
		t.Fatalf("roundtrip %v %v", got, err)
	}
	s := string(raw)
	bad := []string{"", "null", "[]", "{}", s + "{}", s + " false", s[:len(s)-1], strings.Repeat(" ", 2049),
		strings.Replace(s, `"fileId":"335036"`, `"fileId":335036`, 1),
		strings.Replace(s, `"fileId":"335036"`, `"fileId":null`, 1),
		strings.Replace(s, `"fileId":"335036"`, `"fileId":"01"`, 1),
		strings.Replace(s, `"fileId":"335036"`, `"fileId":"335036","fileId":"335036"`, 1),
		strings.Replace(s, `"fileId":"335036"`, `"fileId":"335036","\u0066ileId":"335036"`, 1),
		strings.Replace(s, `"fileId":"335036"`, `"other":"335036"`, 1),
		strings.Replace(s, EvidenceSchema, "future/2", 1),
		strings.Replace(s, "apfs", "smbfs", 1),
		strings.Replace(s, "11111111-2222-3333-4444-555555555555", "00000000-0000-0000-0000-000000000000", 1),
		strings.Replace(s, "11111111-2222-3333-4444-555555555555", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", 1),
		strings.Replace(s, `"birthNanoseconds":"123"`, `"birthNanoseconds":"1000000000"`, 1),
		strings.Replace(s, `"birthSeconds":"1700000000"`, `"birthSeconds":"-1"`, 1),
		string([]byte{0xff, 0xfe}),
	}
	for i, v := range bad {
		if _, err := ParseEvidence([]byte(v)); err == nil {
			t.Errorf("accepted case %d: %s", i, v)
		}
	}
	base.VolumeUUID = ""
	if b, err := EncodeEvidence(base); err == nil || b != nil {
		t.Fatal("invalid encoding succeeded")
	}
}
func FuzzEvidenceCodec(f *testing.F) {
	b, _ := EncodeEvidence(validObservation().Evidence)
	f.Add(b)
	f.Add([]byte(`null`))
	f.Add([]byte(`{"schema":"x"}`))
	f.Fuzz(func(t *testing.T, b []byte) {
		e, err := ParseEvidence(b)
		if err != nil {
			return
		}
		if !e.Valid() {
			t.Fatal("accepted invalid evidence")
		}
		encoded, err := EncodeEvidence(e)
		if err != nil {
			t.Fatal(err)
		}
		again, err := ParseEvidence(encoded)
		if err != nil || again != e {
			t.Fatal("unstable codec")
		}
	})
}
