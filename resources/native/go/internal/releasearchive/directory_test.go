package releasearchive

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func positions(data []byte) (central, end, local int) {
	end = len(data) - 22
	central = int(u32(data[end:], 16))
	local = int(u32(data[central:], 42))
	return
}

func TestMaliciousHeadersBeforeExtraction(t *testing.T) {
	tests := []struct {
		name, code string
		mutate     func([]byte) []byte
	}{
		{"lying count", "ARCHIVE_ENTRY_COUNT_INVALID", func(b []byte) []byte { _, e, _ := positions(b); put16(b, e+8, 1); put16(b, e+10, 1); return b }},
		{"zero count", "ARCHIVE_ENTRY_COUNT_INVALID", func(b []byte) []byte { _, e, _ := positions(b); put16(b, e+8, 0); put16(b, e+10, 0); return b }},
		{"central byte budget", "ARCHIVE_CENTRAL_DIRECTORY_LIMIT", func(b []byte) []byte { _, e, _ := positions(b); put32(b, e+12, 32*1024*1024); return b }},
		{"zero central length", "ARCHIVE_CENTRAL_DIRECTORY_LIMIT", func(b []byte) []byte { _, e, _ := positions(b); put32(b, e+12, 0); return b }},
		{"end count sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { _, e, _ := positions(b); put16(b, e+8, 65535); put16(b, e+10, 65535); return b }},
		{"end length sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { _, e, _ := positions(b); put32(b, e+12, 0xffffffff); return b }},
		{"end offset sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { _, e, _ := positions(b); put32(b, e+16, 0xffffffff); return b }},
		{"multidisk", "ARCHIVE_MULTIDISK_UNSUPPORTED", func(b []byte) []byte { _, e, _ := positions(b); put16(b, e+4, 1); return b }},
		{"multidisk central", "ARCHIVE_MULTIDISK_UNSUPPORTED", func(b []byte) []byte { c, _, _ := positions(b); put16(b, c+34, 1); return b }},
		{"central compressed sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { c, _, _ := positions(b); put32(b, c+20, 0xffffffff); return b }},
		{"central expanded sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { c, _, _ := positions(b); put32(b, c+24, 0xffffffff); return b }},
		{"central offset sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { c, _, _ := positions(b); put32(b, c+42, 0xffffffff); return b }},
		{"local compressed sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { _, _, l := positions(b); put32(b, l+18, 0xffffffff); return b }},
		{"local expanded sentinel", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte { _, _, l := positions(b); put32(b, l+22, 0xffffffff); return b }},
		{"bad central signature", "ARCHIVE_DIRECTORY_INVALID", func(b []byte) []byte { c, _, _ := positions(b); b[c] = 0; return b }},
		{"bad local signature", "ARCHIVE_DIRECTORY_INVALID", func(b []byte) []byte { _, _, l := positions(b); b[l] = 0; return b }},
		{"local filename mismatch", "ARCHIVE_HEADER_INVALID", func(b []byte) []byte { _, _, l := positions(b); b[l+30] = 'x'; return b }},
		{"local compression mismatch", "ARCHIVE_HEADER_INVALID", func(b []byte) []byte { _, _, l := positions(b); put16(b, l+8, 8); return b }},
		{"local encryption", "ARCHIVE_ENCRYPTED", func(b []byte) []byte { _, _, l := positions(b); put16(b, l+6, 1); return b }},
		{"local CRC mismatch", "ARCHIVE_HEADER_INVALID", func(b []byte) []byte { _, _, l := positions(b); put32(b, l+14, 0); return b }},
		{"local size mismatch", "ARCHIVE_HEADER_INVALID", func(b []byte) []byte { _, _, l := positions(b); put32(b, l+22, 100); return b }},
		{"local pointer into central", "ARCHIVE_DIRECTORY_INVALID", func(b []byte) []byte { c, _, _ := positions(b); put32(b, c+42, uint32(c)); return b }},
		{"central variable field overflow", "ARCHIVE_DIRECTORY_INVALID", func(b []byte) []byte { c, _, _ := positions(b); put16(b, c+32, 65535); return b }},
		{"end comment mismatch", "ARCHIVE_DIRECTORY_INVALID", func(b []byte) []byte { _, e, _ := positions(b); put16(b, e+20, 1); return b }},
		{"trailing bytes", "ARCHIVE_DIRECTORY_INVALID", func(b []byte) []byte { return append(b, 0) }},
		{"expanded byte budget", "ARCHIVE_EXPANDED_LIMIT", func(b []byte) []byte {
			c, _, l := positions(b)
			put32(b, c+24, maxExpanded+1)
			put32(b, l+22, maxExpanded+1)
			return b
		}},
		{"hidden locator in central comment", "ARCHIVE_ZIP64_UNSUPPORTED", func(b []byte) []byte {
			c, e, _ := positions(b)
			last := bytes.LastIndex(b[:e], []byte{'P', 'K', 1, 2})
			records := make([]byte, 76)
			put32(records, 0, 0x06064b50)
			put32(records, 56, 0x07064b50)
			put16(b, last+32, uint16(len(records)))
			put32(b, e+12, uint32(e-c+len(records)))
			out := append([]byte(nil), b[:e]...)
			out = append(out, records...)
			return append(out, b[e:]...)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := tt.mutate(makeArchive(t, baseEntries()))
			// The admission API itself must refuse; no zip.Reader or extraction is involved.
			_, err := admitDirectory(bytes.NewReader(data), int64(len(data)))
			if tt.code != "ARCHIVE_EXPANDED_LIMIT" {
				requireRefusal(t, err, tt.code)
			}
			f := newFixture(t, data)
			_, err = Run(f.args)
			requireRefusal(t, err, tt.code)
			requireEmpty(t, f.stage)
		})
	}
}

func TestExtraFieldsCentralAndLocal(t *testing.T) {
	for _, where := range []string{"central", "local"} {
		for _, tt := range []struct {
			name string
			data []byte
			code string
		}{
			{"zip64", extra(1, make([]byte, 16)), "ARCHIVE_ZIP64_UNSUPPORTED"},
			{"PKWARE Unix", extra(0xd, make([]byte, 12)), "ARCHIVE_HARDLINK_INVALID"},
			{"ASi Unix", extra(0x756e, make([]byte, 14)), "ARCHIVE_HARDLINK_INVALID"},
			{"short header", []byte{2, 0, 1}, "ARCHIVE_EXTRA_INVALID"},
			{"short value", []byte{2, 0, 2, 0, 0}, "ARCHIVE_EXTRA_INVALID"},
		} {
			t.Run(where+"/"+tt.name, func(t *testing.T) {
				e := fixtureEntry{name: previewApp + "/extra"}
				if where == "central" {
					e.extra = tt.data
				} else {
					e.localExtra = tt.data
				}
				data := makeArchive(t, withEntry(e))
				_, err := admitDirectory(bytes.NewReader(data), int64(len(data)))
				requireRefusal(t, err, tt.code)
				f := newFixture(t, data)
				_, err = Run(f.args)
				requireRefusal(t, err, tt.code)
				requireEmpty(t, f.stage)
			})
		}
	}
}

func TestActualCentralAndTreeBudgets(t *testing.T) {
	t.Run("actual central count beyond advertised", func(t *testing.T) {
		entries := []fixtureEntry{}
		for i := 0; i < maxEntries+1; i++ {
			entries = append(entries, fixtureEntry{name: "x"})
		}
		data := makeArchive(t, entries)
		_, err := admitDirectory(bytes.NewReader(data), int64(len(data)))
		requireRefusal(t, err, "ARCHIVE_ENTRY_COUNT_INVALID")
		f := newFixture(t, data)
		_, err = Run(f.args)
		requireRefusal(t, err, "ARCHIVE_ENTRY_COUNT_INVALID")
		requireEmpty(t, f.stage)
	})
	t.Run("implicit tree paths", func(t *testing.T) {
		entries := baseEntries()
		for i := 0; i < 790; i++ {
			entries = append(entries, fixtureEntry{name: previewApp + "/tree" + strconv.Itoa(i) + strings.Repeat("/a", 126)})
		}
		f := newFixture(t, makeArchive(t, entries))
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_ENTRY_COUNT_INVALID")
		requireEmpty(t, f.stage)
	})
}

func TestCRCReadLimitsAndRollback(t *testing.T) {
	for _, tt := range []struct {
		name, code string
		mutate     func([]byte) []byte
	}{
		{"bad CRC", "ARCHIVE_CRC_INVALID", func(b []byte) []byte { _, _, l := positions(b); b[l+30+len("artifact.json")] = 'x'; return b }},
		{"zero expected CRC", "ARCHIVE_CRC_INVALID", func(b []byte) []byte { c, _, l := positions(b); put32(b, c+16, 0); put32(b, l+14, 0); return b }},
		{"read exceeds declared expanded size", "ARCHIVE_READ_INVALID", func(b []byte) []byte { c, _, l := positions(b); put32(b, c+24, 1); put32(b, l+22, 1); return b }},
		{"invalid deflate", "ARCHIVE_READ_INVALID", func(b []byte) []byte { c, _, l := positions(b); put16(b, c+10, 8); put16(b, l+8, 8); return b }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			data := tt.mutate(makeArchive(t, baseEntries()))
			f := newFixture(t, data)
			bootstrap := filepath.Join(f.stage, ".update_archive.py")
			if err := os.WriteFile(bootstrap, []byte("trusted executable"), 0700); err != nil {
				t.Fatal(err)
			}
			_, err := Run(f.args)
			requireRefusal(t, err, tt.code)
			items, err := os.ReadDir(f.stage)
			if err != nil || len(items) != 1 || items[0].Name() != ".update_archive.py" {
				t.Fatalf("rollback: %v %v", items, err)
			}
			got, err := os.ReadFile(bootstrap)
			if err != nil || string(got) != "trusted executable" {
				t.Fatalf("bootstrap: %q %v", got, err)
			}
		})
	}
	t.Run("failure after first successful file", func(t *testing.T) {
		data := makeArchive(t, baseEntries())
		c, _, _ := positions(data)
		second := c + 46 + len("artifact.json")
		local := int(u32(data[second:], 42))
		data[local+30+len(previewApp+"/Contents/Info.plist")] = 'x'
		f := newFixture(t, data)
		existing := filepath.Join(f.stage, previewApp)
		if err := os.Mkdir(existing, 0700); err != nil {
			t.Fatal(err)
		}
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_CRC_INVALID")
		requireEmpty(t, existing)
		info, err := os.Stat(existing)
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatalf("existing directory changed: %v %v", info, err)
		}
		items, err := os.ReadDir(f.stage)
		if err != nil || len(items) != 1 {
			t.Fatalf("partial tree: %v %v", items, err)
		}
	})
}

func TestArgumentsAndMeasuredDigest(t *testing.T) {
	f := newFixture(t, makeArchive(t, baseEntries()))
	for _, tt := range []struct {
		name, code string
		args       []string
	}{
		{"count", "ARCHIVE_ARGUMENTS_INVALID", nil},
		{"negative", "ARCHIVE_SIZE_INVALID", []string{f.archive, f.stage, "-1", f.args[3]}},
		{"nondecimal numeric", "ARCHIVE_SIZE_INVALID", []string{f.archive, f.stage, "²", f.args[3]}},
		{"overflow", "ARCHIVE_SIZE_INVALID", []string{f.archive, f.stage, "999999999999999999999999", f.args[3]}},
		{"zero", "ARCHIVE_SIZE_INVALID", []string{f.archive, f.stage, "0", f.args[3]}},
		{"archive budget", "ARCHIVE_SIZE_INVALID", []string{f.archive, f.stage, "2147483649", f.args[3]}},
		{"uppercase digest", "ARCHIVE_DIGEST_INVALID", []string{f.archive, f.stage, f.args[2], strings.ToUpper(f.args[3])}},
		{"wrong digest", "ARCHIVE_DIGEST_MISMATCH", []string{f.archive, f.stage, f.args[2], strings.Repeat("0", 64)}},
		{"size mismatch", "ARCHIVE_SIZE_MISMATCH", []string{f.archive, f.stage, "1", f.args[3]}},
	} {
		t.Run(tt.name, func(t *testing.T) { _, err := Run(tt.args); requireRefusal(t, err, tt.code); requireEmpty(t, f.stage) })
	}
	if Code(os.ErrNotExist) != "ARCHIVE_IO_FAILED" {
		t.Fatal("unclassified error leaks text")
	}
}
