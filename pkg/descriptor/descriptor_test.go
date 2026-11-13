package descriptor

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestName(t *testing.T) {
	cases := []struct {
		prefix, suffix string
		size           int
	}{
		{".chat-lifecycle-", ".tmp", 16},
		{".journal-", "", 12},
		{".key.tmp-", "", 8},
		{"", "", 1},
	}
	for _, c := range cases {
		hexPart := regexp.MustCompile("^[0-9a-f]{" + strconv.Itoa(2*c.size) + "}$")
		seen := map[string]bool{}
		for range 64 {
			name, err := Name(c.prefix, c.size, c.suffix)
			if err != nil {
				t.Fatal(c, err)
			}
			if !strings.HasPrefix(name, c.prefix) || !strings.HasSuffix(name, c.suffix) {
				t.Fatalf("%q lost its prefix %q or suffix %q", name, c.prefix, c.suffix)
			}
			middle := name[len(c.prefix) : len(name)-len(c.suffix)]
			if !hexPart.MatchString(middle) {
				t.Fatalf("%q is not %d lowercase hex bytes", middle, c.size)
			}
			if c.size >= 8 && seen[name] {
				t.Fatalf("%q repeated", name)
			}
			seen[name] = true
		}
	}
}

func TestNameRefusesEmptySize(t *testing.T) {
	for _, size := range []int{0, -1} {
		if name, err := Name("a", size, "b"); err == nil || name != "" {
			t.Fatal(size, name, err)
		}
	}
}
