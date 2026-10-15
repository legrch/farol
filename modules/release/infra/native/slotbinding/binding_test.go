package slotbinding

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func fixture(version string) []byte {
	build := `{"buildId":"` + strings.Repeat("2", 64) + `","digest":"` + strings.Repeat("1", 64) + `","version":` + version + `}`
	return []byte(`{"installLocation":"shared","operationId":"` + strings.Repeat("a", 32) + `","schema":"farol.installed-operation-slot/1","source":` + build + `,"target":` + build + "}\n")
}
func TestCanonicalPythonStrings(t *testing.T) {
	// Frozen Python json.dumps(sort_keys=True,separators=(",",":"),ensure_ascii=True)
	// semantics; no Python process is invoked by these portable fixtures.
	for _, version := range []string{`"0.2.4"`, `"<>&/"`, `"\"\\\b\f\n\r\t\u0000\u001f\u007f"`, `"\u00e9\u2028\u2029"`, `"\ud83d\ude00"`, `"\ud800x\udfff"`, `"\ud800\ud800"`, `"` + strings.Repeat(`\ud83d\ude00`, 128) + `"`} {
		if !canonical(fixture(version)) {
			t.Errorf("valid version %s", version)
		}
	}
	golden, err := os.ReadFile("testdata/slot-binding.bytes")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(golden, fixture(`"0.2.4"`)) || !canonical(golden) {
		t.Fatal("golden mismatch")
	}
}
func TestCanonicalRejects(t *testing.T) {
	valid := fixture(`"0.2.4"`)
	cases := [][]byte{nil, []byte("{}"), append(append([]byte{}, valid...), ' '), bytes.TrimSpace(valid), bytes.Replace(valid, []byte(`"shared"`), []byte(`"shared", "extra":true`), 1), bytes.Replace(valid, []byte(`"shared"`), []byte(`"shared","installLocation":"shared"`), 1), bytes.Replace(valid, []byte(`"buildId":`), []byte(`"buildId":"`+strings.Repeat("2", 64)+`","buildId":`), 1), fixture(`""`), fixture(`"` + strings.Repeat("a", 129) + `"`), fixture(`"é"`), fixture(`"\u00E9"`), fixture(`"\u003c"`), fixture(`"\/"`), fixture(`"\u000a"`), fixture(`"\q"`), fixture(`"\ud800`), bytes.Repeat([]byte("x"), 8193), bytes.Replace(valid, []byte("shared"), []byte("other!"), 1), bytes.Replace(valid, []byte(strings.Repeat("a", 32)), []byte(strings.Repeat("A", 32)), 1)}
	for i, data := range cases {
		if canonical(data) {
			t.Errorf("accepted %d: %q", i, data)
		}
	}
}
