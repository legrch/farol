package execution

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
)

var codesignHash = regexp.MustCompile(`(?m)^CDHash=([0-9a-f]{40})$`)

// codesignCDHash is the golden oracle: the independent code-signing tool's
// own report. Only this test runs it; production never shells out.
func codesignCDHash(t *testing.T, path string, arch string) [20]byte {
	t.Helper()
	args := []string{"-d", "-vvv"}
	if arch != "" {
		args = append(args, "--arch", arch)
	}
	out, err := exec.Command("/usr/bin/codesign", append(args, path)...).CombinedOutput()
	if err != nil {
		t.Fatalf("codesign -d failed: %v\n%s", err, out)
	}
	match := codesignHash.FindSubmatch(out)
	if match == nil {
		t.Fatalf("no CDHash in codesign output:\n%s", out)
	}
	var hash [20]byte
	decoded, err := hex.DecodeString(string(match[1]))
	must(t, err)
	copy(hash[:], decoded)
	return hash
}

func parsedCDHash(t *testing.T, path, arch string) ([20]byte, error) {
	t.Helper()
	file, err := os.Open(path)
	must(t, err)
	defer file.Close()
	st, err := file.Stat()
	must(t, err)
	return codeDirectoryHash(file, st.Size(), arch)
}

func TestCodeDirectoryHashMatchesCodesignGolden(t *testing.T) {
	arm := scratchExecutable(t, "golden", "arm64", "")
	// Linker-signed output, before codesign rewrites it.
	t.Run("thin arm64", func(t *testing.T) {
		got, err := parsedCDHash(t, arm, "arm64")
		must(t, err)
		if want := codesignCDHash(t, arm, ""); got != want {
			t.Fatalf("parser %x, codesign %x", got, want)
		}
	})
	t.Run("sha1 and sha256 prefer sha256", func(t *testing.T) {
		dual := filepath.Join(t.TempDir(), "dual")
		copyFile(t, arm, dual, 0700)
		signScratch(t, dual, "sha1,sha256")
		got, err := parsedCDHash(t, dual, "arm64")
		must(t, err)
		if want := codesignCDHash(t, dual, ""); got != want {
			t.Fatalf("parser %x, codesign %x", got, want)
		}
	})
	t.Run("universal selects the running slice", func(t *testing.T) {
		if _, err := os.Stat("/usr/bin/lipo"); err != nil {
			t.Skip("lipo unavailable")
		}
		intel := scratchExecutable(t, "golden", "amd64", "")
		fat := filepath.Join(t.TempDir(), "universal")
		if out, err := exec.Command("/usr/bin/lipo", "-create", arm, intel, "-output", fat).CombinedOutput(); err != nil {
			t.Fatalf("lipo failed: %v\n%s", err, out)
		}
		signScratch(t, fat, "")
		armHash, intelHash := codesignCDHash(t, fat, "arm64"), codesignCDHash(t, fat, "x86_64")
		if armHash == intelHash {
			t.Fatal("fixture slices are indistinguishable")
		}
		for arch, want := range map[string][20]byte{"arm64": armHash, "amd64": intelHash} {
			got, err := parsedCDHash(t, fat, arch)
			must(t, err)
			if got != want {
				t.Fatalf("%s slice: parser %x, codesign %x", arch, got, want)
			}
		}
		if _, err := parsedCDHash(t, fat, "riscv"); err == nil {
			t.Fatal("unknown architecture selected a slice")
		}
	})
	t.Run("unsigned and truncated refuse", func(t *testing.T) {
		bare := filepath.Join(t.TempDir(), "bare")
		copyFile(t, arm, bare, 0700)
		if out, err := exec.Command("/usr/bin/codesign", "--remove-signature", bare).CombinedOutput(); err != nil {
			t.Fatalf("remove-signature failed: %v\n%s", err, out)
		}
		if _, err := parsedCDHash(t, bare, "arm64"); err == nil {
			t.Fatal("unsigned executable produced a hash")
		}
		data, err := os.ReadFile(arm)
		must(t, err)
		cut := filepath.Join(t.TempDir(), "cut")
		must(t, os.WriteFile(cut, data[:len(data)-64], 0700))
		if _, err := parsedCDHash(t, cut, "arm64"); err == nil {
			t.Fatal("truncated signature produced a hash")
		}
		script := filepath.Join(t.TempDir(), "script")
		must(t, os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0700))
		if _, err := parsedCDHash(t, script, "arm64"); err == nil {
			t.Fatal("script produced a hash")
		}
	})
}

// A synthetic signature exercises the kernel's CodeDirectory choice without
// any tool: the highest-priority hash type wins whatever its slot order.
func TestBestCDHashPrefersHighestPriorityDirectory(t *testing.T) {
	directory := func(kind byte, marker byte) []byte {
		d := make([]byte, 64)
		binary.BigEndian.PutUint32(d[0:], codeDirectoryMagic)
		binary.BigEndian.PutUint32(d[4:], uint32(len(d)))
		d[37] = kind
		d[63] = marker
		return d
	}
	superBlob := func(slots []uint32, directories ...[]byte) []byte {
		header := 12 + 8*len(directories)
		out := make([]byte, header)
		binary.BigEndian.PutUint32(out[0:], superBlobMagic)
		binary.BigEndian.PutUint32(out[8:], uint32(len(directories)))
		offset := header
		for i, d := range directories {
			binary.BigEndian.PutUint32(out[12+8*i:], slots[i])
			binary.BigEndian.PutUint32(out[16+8*i:], uint32(offset))
			out = append(out, d...)
			offset += len(d)
		}
		binary.BigEndian.PutUint32(out[4:], uint32(len(out)))
		return out
	}
	sha1Directory, sha256Directory := directory(hashTypeSHA1, 1), directory(hashTypeSHA256, 2)
	want256 := sha256.Sum256(sha256Directory)
	want1 := sha1.Sum(sha1Directory)
	for name, tc := range map[string]struct {
		blob []byte
		want []byte
	}{
		"sha256 alternate beats primary sha1": {superBlob([]uint32{slotCodeDirectory, slotAlternateFirst}, sha1Directory, sha256Directory), want256[:20]},
		"sha256 primary beats alternate sha1": {superBlob([]uint32{slotCodeDirectory, slotAlternateFirst}, sha256Directory, sha1Directory), want256[:20]},
		"sha1 alone":                          {superBlob([]uint32{slotCodeDirectory}, sha1Directory), want1[:]},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := bestCDHash(tc.blob)
			must(t, err)
			if !bytes.Equal(got[:], tc.want) {
				t.Fatalf("got %x, want %x", got, tc.want)
			}
		})
	}
	if _, err := bestCDHash(superBlob([]uint32{0x2}, directory(hashTypeSHA256, 3))); err == nil {
		t.Fatal("a signature without a code directory slot produced a hash")
	}
}

func TestArgvHoldsRequiresAnExactArgument(t *testing.T) {
	buffer := func(argc uint32, execPath string, strings ...string) []byte {
		raw := binary.LittleEndian.AppendUint32(nil, argc)
		raw = append(raw, execPath...)
		raw = append(raw, 0, 0, 0)
		for _, s := range strings {
			raw = append(raw, s...)
			raw = append(raw, 0)
		}
		return append(raw, "ENV=1\x00"...)
	}
	hint := `--farol-installed-update-relaunch={"operationId":"x"}`
	for name, tc := range map[string]struct {
		raw  []byte
		want bool
	}{
		"exact":                   {buffer(3, "/p/app", "/p/app", "arg", hint), true},
		"prefix only":             {buffer(2, "/p/app", "/p/app", hint+"x"), false},
		"substring of another":    {buffer(2, "/p/app", "/p/app", "x"+hint), false},
		"environment is not argv": {buffer(1, "/p/app", "/p/app"), false},
		"truncated":               {binary.LittleEndian.AppendUint32(nil, 3), false},
		"empty":                   {nil, false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := argvHolds(tc.raw, hint); got != tc.want {
				t.Fatalf("argvHolds = %v, want %v", got, tc.want)
			}
		})
	}
	// The environment block follows argv; a hint placed there is not an argument.
	raw := buffer(1, "/p/app", "/p/app")
	raw = append(raw, hint+"\x00"...)
	if argvHolds(raw, hint) {
		t.Fatal("an environment entry matched as argv")
	}
}
