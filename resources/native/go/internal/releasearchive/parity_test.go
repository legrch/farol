package releasearchive

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestPythonDifferentialOracle(t *testing.T) {
	// The existing Python source is an optional temporary development oracle,
	// never a runtime dependency or input to the Go executable's build.
	python := "/usr/bin/python3"
	if _, err := os.Stat(python); err != nil {
		t.Skip("Python differential oracle unavailable")
	}
	helper, err := filepath.Abs("../../../update_archive.py")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(helper); err != nil {
		t.Skip("temporary Python oracle absent")
	}
	tests := []struct {
		name    string
		entries []fixtureEntry
		code    string
	}{
		{"preview", baseEntries(), ""},
		{"branded", []fixtureEntry{{name: "artifact.json", data: []byte("{}")}, {name: brandedApp + "/Contents/file", data: []byte("data"), mode: 0100755}}, ""},
		{"deflate descriptor", withEntry(fixtureEntry{name: previewApp + "/compressed", data: bytes.Repeat([]byte("hello"), 200), method: 8, flags: 8}), ""},
		{"CP437", withEntry(fixtureEntry{name: previewApp + "/caf\x82", data: []byte("data")}), ""},
		{"file special mode", withEntry(fixtureEntry{name: previewApp + "/executable", data: []byte("data"), mode: 0104751}), ""},
		{"vendor link", append(baseEntries(), fixtureEntry{name: previewApp + "/Contents/Versions/A/Electron", data: []byte("binary"), mode: 0100755}, fixtureEntry{name: previewApp + "/Contents/Electron", data: []byte("Versions/A/Electron"), mode: 0120777}), ""},
		{"full NFD preserves original CGJ", append(baseEntries(), fixtureEntry{name: previewApp + "/a" + strings.Repeat("\u0301", 31), flags: 0x800}, fixtureEntry{name: previewApp + "/a" + strings.Repeat("\u0301", 30) + "\u034f\u0301", flags: 0x800}), ""},
		{"casefold", append(baseEntries(), fixtureEntry{name: previewApp + "/Straße", flags: 0x800}, fixtureEntry{name: previewApp + "/STRASSE", flags: 0x800}), "ARCHIVE_DUPLICATE_ENTRY"},
		{"NFD", append(baseEntries(), fixtureEntry{name: previewApp + "/café", flags: 0x800}, fixtureEntry{name: previewApp + "/cafe\u0301", flags: 0x800}), "ARCHIVE_DUPLICATE_ENTRY"},
		{"parent file", append(baseEntries(), fixtureEntry{name: previewApp + "/file"}, fixtureEntry{name: previewApp + "/file/child"}), "ARCHIVE_PARENT_TYPE_INVALID"},
		{"mixed apps", withEntry(fixtureEntry{name: brandedApp + "/file"}), "ARCHIVE_APP_SET_INVALID"},
		{"missing artifact", []fixtureEntry{{name: previewApp + "/file"}}, "ARCHIVE_ARTIFACT_MISSING"},
		{"artifact symlink", []fixtureEntry{{name: "artifact.json", data: []byte(previewApp + "/file"), mode: 0120777}, {name: previewApp + "/file"}}, "ARCHIVE_ARTIFACT_MISSING"},
		{"directory data", withEntry(fixtureEntry{name: previewApp + "/dir/", data: []byte("data"), mode: 0040700}), "ARCHIVE_DIRECTORY_DATA"},
		{"hardlink extra", withEntry(fixtureEntry{name: previewApp + "/extra", extra: extra(0xd, nil)}), "ARCHIVE_HARDLINK_INVALID"},
		{"zip64 local extra", withEntry(fixtureEntry{name: previewApp + "/extra", localExtra: extra(1, make([]byte, 16))}), "ARCHIVE_ZIP64_UNSUPPORTED"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := makeArchive(t, tt.entries)
			f := newFixture(t, data)
			pythonStage := filepath.Join(filepath.Dir(f.stage), "python-stage")
			if err := os.Mkdir(pythonStage, 0700); err != nil {
				t.Fatal(err)
			}
			for _, stage := range []string{f.stage, pythonStage} {
				if err := os.WriteFile(filepath.Join(stage, ".update_archive.py"), []byte("bootstrap"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			sum := sha256.Sum256(data)
			command := exec.Command(python, "-I", "-S", "-B", helper, f.archive, pythonStage, strconv.Itoa(len(data)), hex.EncodeToString(sum[:]))
			command.Env = []string{"PATH=/usr/bin:/bin"}
			var stdout, stderr bytes.Buffer
			command.Stdout = &stdout
			command.Stderr = &stderr
			pythonErr := command.Run()
			_, goErr := Run(f.args)
			if tt.code != "" {
				requireRefusal(t, goErr, tt.code)
				if pythonErr == nil || !strings.Contains(stderr.String(), "ARCHIVE_REFUSED:"+tt.code) {
					t.Fatalf("oracle disagreement: %v %q", pythonErr, stderr.String())
				}
				for _, stage := range []string{f.stage, pythonStage} {
					entries, err := os.ReadDir(stage)
					if err != nil || len(entries) != 1 || entries[0].Name() != ".update_archive.py" {
						t.Fatalf("preflight wrote files: %v %v", entries, err)
					}
				}
				return
			}
			if pythonErr != nil || goErr != nil {
				t.Fatalf("Go=%v Python=%v %q", goErr, pythonErr, stderr.String())
			}
			result := Result{}
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			actual, oracle := snapshot(t, f.stage), snapshot(t, pythonStage)
			if len(actual) != len(oracle) {
				t.Fatalf("tree sizes differ: Go=%v Python=%v", actual, oracle)
			}
			for path, value := range actual {
				if oracle[path] != value {
					t.Fatalf("tree differs for %s: %q != %q", path, value, oracle[path])
				}
			}
		})
	}
}

func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		value := info.Mode().String()
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += " " + target
		} else if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += " " + string(data)
		}
		out[relative] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFullNFDCanonicalOrderWithoutInsertedCGJ(t *testing.T) {
	original := "a" + strings.Repeat("\u0301", 31) + "\u0323"
	want := "a\u0323" + strings.Repeat("\u0301", 31)
	if got := fullNFD(original); got != want {
		t.Fatalf("unrestricted NFD: %q", got)
	}
	explicit := "a" + strings.Repeat("\u0301", 30) + "\u034f\u0301"
	if fullNFD(explicit) != explicit {
		t.Fatal("original CGJ lost")
	}
	if fullNFD("각") != "각" {
		t.Fatal("Hangul decomposition lost")
	}
}

func TestUnicodeDecimalSizeParity(t *testing.T) {
	f := newFixture(t, makeArchive(t, baseEntries()))
	var unicodeDigits strings.Builder
	for _, r := range f.args[2] {
		unicodeDigits.WriteRune('٠' + r - '0')
	}
	f.args[2] = unicodeDigits.String()
	if _, err := Run(f.args); err != nil {
		t.Fatal(err)
	}
}
