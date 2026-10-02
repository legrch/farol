package releasearchive

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/hex"
	"hash/crc32"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// These fixtures exercise real native filesystem operations and ZIP bytes.
// They do not represent installed-app, provider, signing, or package acceptance.
type fixtureEntry struct {
	name               string
	data               []byte
	mode               uint32
	method             uint16
	flags              uint16
	extra, localExtra  []byte
	unsignedDescriptor bool
}

func baseEntries() []fixtureEntry {
	return []fixtureEntry{{name: "artifact.json", data: []byte("{}"), mode: 0100644}, {name: previewApp + "/Contents/Info.plist", data: []byte("plist"), mode: 0100644}}
}
func withEntry(e fixtureEntry) []fixtureEntry { return append(baseEntries(), e) }
func put16(b []byte, at int, n uint16)        { little.PutUint16(b[at:at+2], n) }
func put32(b []byte, at int, n uint32)        { little.PutUint32(b[at:at+4], n) }
func extra(tag uint16, data []byte) []byte {
	b := make([]byte, 4+len(data))
	put16(b, 0, tag)
	put16(b, 2, uint16(len(data)))
	copy(b[4:], data)
	return b
}

func makeArchive(t *testing.T, entries []fixtureEntry) []byte {
	t.Helper()
	var body, central bytes.Buffer
	for _, e := range entries {
		payload := e.data
		if e.method == 8 {
			var compressed bytes.Buffer
			writer, err := flate.NewWriter(&compressed, flate.DefaultCompression)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = writer.Write(payload); err != nil {
				t.Fatal(err)
			}
			if err = writer.Close(); err != nil {
				t.Fatal(err)
			}
			payload = compressed.Bytes()
		}
		crc := crc32.ChecksumIEEE(e.data)
		local := make([]byte, 30)
		put32(local, 0, 0x04034b50)
		put16(local, 4, 20)
		put16(local, 6, e.flags)
		put16(local, 8, e.method)
		if e.flags&8 == 0 {
			put32(local, 14, crc)
			put32(local, 18, uint32(len(payload)))
			put32(local, 22, uint32(len(e.data)))
		}
		put16(local, 26, uint16(len(e.name)))
		put16(local, 28, uint16(len(e.localExtra)))
		cd := make([]byte, 46)
		put32(cd, 0, 0x02014b50)
		put16(cd, 4, 3<<8|20)
		put16(cd, 6, 20)
		put16(cd, 8, e.flags)
		put16(cd, 10, e.method)
		put32(cd, 16, crc)
		put32(cd, 20, uint32(len(payload)))
		put32(cd, 24, uint32(len(e.data)))
		put16(cd, 28, uint16(len(e.name)))
		put16(cd, 30, uint16(len(e.extra)))
		put32(cd, 38, e.mode<<16)
		put32(cd, 42, uint32(body.Len()))
		body.Write(local)
		body.WriteString(e.name)
		body.Write(e.localExtra)
		body.Write(payload)
		if e.flags&8 != 0 {
			descriptor := make([]byte, 16)
			put32(descriptor, 0, 0x08074b50)
			put32(descriptor, 4, crc)
			put32(descriptor, 8, uint32(len(payload)))
			put32(descriptor, 12, uint32(len(e.data)))
			if e.unsignedDescriptor {
				body.Write(descriptor[4:])
			} else {
				body.Write(descriptor)
			}
		}
		central.Write(cd)
		central.WriteString(e.name)
		central.Write(e.extra)
	}
	end := make([]byte, 22)
	put32(end, 0, 0x06054b50)
	put16(end, 8, uint16(len(entries)))
	put16(end, 10, uint16(len(entries)))
	put32(end, 12, uint32(central.Len()))
	put32(end, 16, uint32(body.Len()))
	body.Write(central.Bytes())
	body.Write(end)
	return body.Bytes()
}

type fixture struct {
	archive, stage string
	args           []string
}

func newFixture(t *testing.T, data []byte) fixture {
	t.Helper()
	parent := t.TempDir()
	f := fixture{archive: filepath.Join(parent, "archive.zip"), stage: filepath.Join(parent, "stage")}
	if err := os.Mkdir(f.stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.archive, data, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	f.args = []string{f.archive, f.stage, strconv.Itoa(len(data)), hex.EncodeToString(sum[:])}
	return f
}
func requireRefusal(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || Code(err) != code {
		t.Fatalf("want %s, got %v (%s)", code, err, Code(err))
	}
}
func requireEmpty(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("stage contains extraction output: %v %v", entries, err)
	}
}

func TestExtractModesBootstrapAndVendorSymlinks(t *testing.T) {
	for _, app := range []string{previewApp, brandedApp} {
		t.Run(app, func(t *testing.T) {
			entries := baseEntries()
			entries = append(entries,
				fixtureEntry{name: previewApp + "/", mode: 0040755},
				fixtureEntry{name: previewApp + "/Contents/Frameworks/", mode: 0040701},
				fixtureEntry{name: previewApp + "/Contents/Frameworks/Versions/A/Electron", data: []byte("binary"), mode: 0100751, method: 8, flags: 8},
				fixtureEntry{name: previewApp + "/Contents/Frameworks/Electron", data: []byte("Versions/A/Electron"), mode: 0120777},
				fixtureEntry{name: previewApp + "/Contents/Frameworks/Current", data: []byte("Versions/A"), mode: 0120777},
				fixtureEntry{name: previewApp + "/Contents/Frameworks/Alias", data: []byte("Current/Electron"), mode: 0120777},
			)
			for i := range entries {
				entries[i].name = strings.ReplaceAll(entries[i].name, previewApp, app)
			}
			f := newFixture(t, makeArchive(t, entries))
			bootstrap := filepath.Join(f.stage, ".update_archive.py")
			if err := os.WriteFile(bootstrap, []byte("trusted bootstrap"), 0700); err != nil {
				t.Fatal(err)
			}
			result, err := Run(f.args)
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := filepath.EvalSymlinks(f.stage)
			if err != nil {
				t.Fatal(err)
			}
			if result.AppPath != filepath.Join(canonical, app) || result.ArtifactPath != filepath.Join(canonical, "artifact.json") {
				t.Fatal(result)
			}
			got, err := os.ReadFile(filepath.Join(result.AppPath, "Contents/Frameworks/Alias"))
			if err != nil || string(got) != "binary" {
				t.Fatalf("resolved link: %q %v", got, err)
			}
			for path, mode := range map[string]os.FileMode{"": 0755, "Contents/Frameworks": 0701, "Contents/Frameworks/Versions/A/Electron": 0751} {
				info, err := os.Stat(filepath.Join(result.AppPath, path))
				if err != nil || info.Mode().Perm() != mode {
					t.Fatalf("mode %s: %v %v", path, info, err)
				}
			}
			got, err = os.ReadFile(bootstrap)
			if err != nil || string(got) != "trusted bootstrap" {
				t.Fatalf("bootstrap changed: %q %v", got, err)
			}
		})
	}
}

func TestPolicyRefusalsBeforeExtraction(t *testing.T) {
	tests := []struct {
		name string
		e    fixtureEntry
		code string
	}{
		{"traversal", fixtureEntry{name: previewApp + "/../escape"}, "ARCHIVE_PATH_INVALID"},
		{"absolute", fixtureEntry{name: "/tmp/escape"}, "ARCHIVE_PATH_INVALID"},
		{"backslash", fixtureEntry{name: previewApp + "/Contents/a\\b"}, "ARCHIVE_PATH_INVALID"},
		{"nul", fixtureEntry{name: previewApp + "/Contents/a\x00b"}, "ARCHIVE_PATH_INVALID"},
		{"empty component", fixtureEntry{name: previewApp + "//file"}, "ARCHIVE_PATH_INVALID"},
		{"foreign root", fixtureEntry{name: "Other.app/file"}, "ARCHIVE_LAYOUT_INVALID"},
		{"artifact child", fixtureEntry{name: "artifact.json/file"}, "ARCHIVE_LAYOUT_INVALID"},
		{"duplicate", fixtureEntry{name: "artifact.json"}, "ARCHIVE_DUPLICATE_ENTRY"},
		{"casefold", fixtureEntry{name: previewApp + "/Contents/info.PLIST"}, "ARCHIVE_DUPLICATE_ENTRY"},
		{"device", fixtureEntry{name: previewApp + "/device", mode: 0020600}, "ARCHIVE_ENTRY_TYPE_INVALID"},
		{"fifo", fixtureEntry{name: previewApp + "/fifo", mode: 0010600}, "ARCHIVE_ENTRY_TYPE_INVALID"},
		{"directory type", fixtureEntry{name: previewApp + "/dir/", mode: 0100700}, "ARCHIVE_ENTRY_TYPE_INVALID"},
		{"directory data", fixtureEntry{name: previewApp + "/dir/", mode: 0040700, data: []byte("x")}, "ARCHIVE_DIRECTORY_DATA"},
		{"directory mode", fixtureEntry{name: previewApp + "/dir/", mode: 0040500}, "ARCHIVE_DIRECTORY_MODE"},
		{"mixed apps", fixtureEntry{name: brandedApp + "/file"}, "ARCHIVE_APP_SET_INVALID"},
		{"encrypted", fixtureEntry{name: previewApp + "/file", flags: 1}, "ARCHIVE_ENCRYPTED"},
		{"strong encryption", fixtureEntry{name: previewApp + "/file", flags: 0x40}, "ARCHIVE_ENCRYPTED"},
		{"unsupported compression", fixtureEntry{name: previewApp + "/file", method: 12}, "ARCHIVE_COMPRESSION_INVALID"},
		{"depth", fixtureEntry{name: previewApp + strings.Repeat("/a", 128)}, "ARCHIVE_PATH_DEPTH_LIMIT"},
		{"ratio", fixtureEntry{name: previewApp + "/bomb", data: bytes.Repeat([]byte("x"), 2_000_000), method: 8}, "ARCHIVE_RATIO_LIMIT"},
		{"invalid utf8", fixtureEntry{name: previewApp + "/\xff", flags: 0x800}, "ARCHIVE_PATH_INVALID"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t, makeArchive(t, withEntry(tt.e)))
			_, err := Run(f.args)
			requireRefusal(t, err, tt.code)
			requireEmpty(t, f.stage)
		})
	}
}

func TestUnicodeNamesAndCollisions(t *testing.T) {
	for _, names := range [][]string{{"caf\u00e9", "cafe\u0301"}, {"Straße", "STRASSE"}, {"\u03c2", "\u03c3"}, {"\ufb03", "ffi"}, {"\u1f88", "\u1f00\u03b9"}} {
		t.Run(names[0], func(t *testing.T) {
			entries := baseEntries()
			for _, name := range names {
				entries = append(entries, fixtureEntry{name: previewApp + "/Contents/" + name, flags: 0x800})
			}
			f := newFixture(t, makeArchive(t, entries))
			_, err := Run(f.args)
			requireRefusal(t, err, "ARCHIVE_DUPLICATE_ENTRY")
			requireEmpty(t, f.stage)
		})
	}
	t.Run("CP437 decoded even when bytes look like valid UTF8", func(t *testing.T) {
		raw := "\xc3\xa9"
		f := newFixture(t, makeArchive(t, withEntry(fixtureEntry{name: previewApp + "/Contents/" + raw, data: []byte("cp437")})))
		result, err := Run(f.args)
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(result.AppPath, "Contents/├⌐"))
		if err != nil || string(data) != "cp437" {
			t.Fatalf("CP437: %q %v", data, err)
		}
	})
	t.Run("CP437 and UTF8 alias", func(t *testing.T) {
		entries := append(baseEntries(), fixtureEntry{name: previewApp + "/Contents/caf\x82"}, fixtureEntry{name: previewApp + "/Contents/café", flags: 0x800})
		f := newFixture(t, makeArchive(t, entries))
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_DUPLICATE_ENTRY")
		requireEmpty(t, f.stage)
	})
}

func TestSymlinkPreflight(t *testing.T) {
	for _, tt := range []struct{ name, link, code string }{
		{"escape", "../../outside", "ARCHIVE_LINK_ESCAPE"},
		{"absolute", "/outside", "ARCHIVE_LINK_INVALID"},
		{"backslash", "..\\outside", "ARCHIVE_LINK_INVALID"},
		{"nul", "a\x00b", "ARCHIVE_LINK_INVALID"},
		{"utf8", "\xff", "ARCHIVE_LINK_INVALID"},
		{"empty", "", "ARCHIVE_LINK_INVALID"},
		{"long", strings.Repeat("a", maxLink+1), "ARCHIVE_LINK_INVALID"},
		{"dangling", "missing", "ARCHIVE_LINK_INVALID"},
		{"cycle", "link", "ARCHIVE_LINK_INVALID"},
		{"regular parent", "Contents/Info.plist/..", "ARCHIVE_LINK_INVALID"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t, makeArchive(t, withEntry(fixtureEntry{name: previewApp + "/link", data: []byte(tt.link), mode: 0120777})))
			_, err := Run(f.args)
			requireRefusal(t, err, tt.code)
			requireEmpty(t, f.stage)
		})
	}
	t.Run("containment follows links before dotdot", func(t *testing.T) {
		entries := append(baseEntries(), fixtureEntry{name: previewApp + "/up", data: []byte(".."), mode: 0120777}, fixtureEntry{name: previewApp + "/escape", data: []byte("up/../outside"), mode: 0120777})
		f := newFixture(t, makeArchive(t, entries))
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_LINK_ESCAPE")
		requireEmpty(t, f.stage)
	})
	t.Run("parent symlink", func(t *testing.T) {
		entries := append(baseEntries(), fixtureEntry{name: previewApp + "/alias", data: []byte("Contents"), mode: 0120777}, fixtureEntry{name: previewApp + "/alias/child"})
		f := newFixture(t, makeArchive(t, entries))
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_PARENT_TYPE_INVALID")
		requireEmpty(t, f.stage)
	})
	t.Run("contained root artifact", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, withEntry(fixtureEntry{name: previewApp + "/artifact", data: []byte("../artifact.json"), mode: 0120777})))
		result, err := Run(f.args)
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(result.AppPath, "artifact"))
		if err != nil || string(data) != "{}" {
			t.Fatalf("%q %v", data, err)
		}
	})
}

func TestFilesystemAdmissionAndIdentity(t *testing.T) {
	t.Run("archive symlink", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		link := f.archive + ".link"
		if err := os.Symlink(f.archive, link); err != nil {
			t.Fatal(err)
		}
		f.args[0] = link
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_TYPE_INVALID")
		requireEmpty(t, f.stage)
	})
	t.Run("archive hardlink", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		if err := os.Link(f.archive, f.archive+".hardlink"); err != nil {
			t.Fatal(err)
		}
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_SIZE_MISMATCH")
		requireEmpty(t, f.stage)
	})
	t.Run("archive fifo without blocking", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		fifo := f.archive + ".fifo"
		if err := syscall.Mkfifo(fifo, 0600); err != nil {
			t.Fatal(err)
		}
		f.args[0] = fifo
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_TYPE_INVALID")
		requireEmpty(t, f.stage)
	})
	t.Run("nonprivate stage", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		if err := os.Chmod(f.stage, 0755); err != nil {
			t.Fatal(err)
		}
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_STAGE_INVALID")
		requireEmpty(t, f.stage)
	})
	t.Run("stage symlink with trailing slash", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		link := f.stage + ".link"
		if err := os.Symlink(f.stage, link); err != nil {
			t.Fatal(err)
		}
		f.args[1] = link + "/"
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_STAGE_INVALID")
		requireEmpty(t, f.stage)
	})
	t.Run("existing symlink parent", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(f.stage, previewApp)); err != nil {
			t.Fatal(err)
		}
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_PARENT_TYPE_INVALID")
		requireEmpty(t, outside)
		if _, err := os.Lstat(filepath.Join(f.stage, "artifact.json")); !os.IsNotExist(err) {
			t.Fatal("wrote before preflight", err)
		}
	})
	t.Run("archive identity replacement", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		handle, err := os.Open(f.archive)
		if err != nil {
			t.Fatal(err)
		}
		defer handle.Close()
		info, err := handle.Stat()
		if err != nil {
			t.Fatal(err)
		}
		before := identify(info)
		if err := os.Rename(f.archive, f.archive+".old"); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(f.archive + ".old")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.archive, data, 0600); err != nil {
			t.Fatal(err)
		}
		requireRefusal(t, unchangedArchive(f.archive, handle, before), "ARCHIVE_CHANGED")
	})
	t.Run("archive ctime detects restored size and mtime", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		handle, err := os.Open(f.archive)
		if err != nil {
			t.Fatal(err)
		}
		defer handle.Close()
		info, err := handle.Stat()
		if err != nil {
			t.Fatal(err)
		}
		before := identify(info)
		if err := os.Chmod(f.archive, 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(f.archive, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(f.archive, info.ModTime(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		requireRefusal(t, unchangedArchive(f.archive, handle, before), "ARCHIVE_CHANGED")
	})
	t.Run("root replacement cannot redirect descriptor operations", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		s, err := openStage(f.stage)
		if err != nil {
			t.Fatal(err)
		}
		defer s.close()
		if err := os.Rename(f.stage, f.stage+".old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(f.stage, 0700); err != nil {
			t.Fatal(err)
		}
		requireRefusal(t, s.unchanged(), "ARCHIVE_STAGE_CHANGED")
		file, err := s.root.OpenFile("owned", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
		requireEmpty(t, f.stage)
		if _, err := os.Stat(filepath.Join(f.stage+".old", "owned")); err != nil {
			t.Fatal(err)
		}
	})
}

func TestLongSymlinkGraphAndModeDefaults(t *testing.T) {
	entries := baseEntries()
	entries = append(entries, fixtureEntry{name: previewApp + "/dir/"}, fixtureEntry{name: previewApp + "/dir/executable", data: []byte("data"), mode: 0104751})
	for i := 0; i < 1000; i++ {
		target := "link" + strconv.Itoa(i+1)
		if i == 999 {
			target = "../Contents/Info.plist"
		}
		entries = append(entries, fixtureEntry{name: previewApp + "/dir/link" + strconv.Itoa(i), data: []byte(target), mode: 0120777})
	}
	f := newFixture(t, makeArchive(t, entries))
	result, err := Run(f.args)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(result.AppPath, "dir"))
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("zero directory mode: %v %v", info, err)
	}
	info, err = os.Stat(filepath.Join(result.AppPath, "dir/executable"))
	if err != nil || info.Mode().Perm() != 0751 {
		t.Fatalf("special mode: %v %v", info, err)
	}
	// Kernel traversal has a lower link limit; the extractor's validation resolves
	// the bounded graph itself. Verify emitted first/last links without traversing.
	first, err := os.Readlink(filepath.Join(result.AppPath, "dir/link0"))
	if err != nil || first != "link1" {
		t.Fatalf("first link: %q %v", first, err)
	}
	last, err := os.Readlink(filepath.Join(result.AppPath, "dir/link999"))
	if err != nil || last != "../Contents/Info.plist" {
		t.Fatalf("last link: %q %v", last, err)
	}
}

func TestImplicitPrefixCollisionAndExistingDestination(t *testing.T) {
	t.Run("implicit casefold parents", func(t *testing.T) {
		entries := append(baseEntries(), fixtureEntry{name: previewApp + "/Contents/a"}, fixtureEntry{name: previewApp + "/CONTENTS/b"})
		f := newFixture(t, makeArchive(t, entries))
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_DUPLICATE_ENTRY")
		requireEmpty(t, f.stage)
	})
	t.Run("existing artifact preserved", func(t *testing.T) {
		f := newFixture(t, makeArchive(t, baseEntries()))
		artifact := filepath.Join(f.stage, "artifact.json")
		if err := os.WriteFile(artifact, []byte("existing"), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := Run(f.args)
		requireRefusal(t, err, "ARCHIVE_ENTRY_EXISTS")
		data, err := os.ReadFile(artifact)
		if err != nil || string(data) != "existing" {
			t.Fatalf("existing file: %q %v", data, err)
		}
	})
}
