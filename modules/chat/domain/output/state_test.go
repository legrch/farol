package output

import (
	"strings"
	"testing"
)

func TestStableLogicalIdentityAndBoundedPrivateCandidate(t *testing.T) {
	original := New(8, "old-user", "old-reply")
	if _, _, err := original.Accept("old-user"); err != Correlation {
		t.Fatal("old user accepted")
	}
	accepted, _, err := original.Accept("user")
	if err != nil {
		t.Fatal(err)
	}
	one, duplicate, err := accepted.Block("user", "reply", "segment", "same")
	if err != nil || duplicate {
		t.Fatal(err)
	}
	if original.Accepted || accepted.Text() != "" {
		t.Fatal("candidate changed earlier state")
	}
	redraw, duplicate, err := one.Block("user", "reply", "segment", "same")
	if err != nil || !duplicate || redraw.Text() != "same" {
		t.Fatal("redraw duplicated")
	}
	two, _, err := one.Block("user", "reply", "segment-2", "same")
	if err != nil || two.Text() != "samesame" {
		t.Fatal("equal paragraph lost")
	}
	if _, _, err := two.Block("user", "reply", "segment-3", "x"); err != Capacity {
		t.Fatal("byte bound absent")
	}
	if _, _, err := one.Block("user", "reply", "segment", "changed"); err != Changed {
		t.Fatal("committed mutation accepted")
	}
	for _, value := range []string{"other", "old-reply", strings.Repeat("x", 121), string([]byte{255})} {
		if _, _, err := one.Block("user", value, "different", "x"); err != Correlation {
			t.Fatalf("reply %q accepted", value)
		}
	}
	complete, err := two.Finish("user", "reply")
	if err != nil || !complete.Complete {
		t.Fatal(err)
	}
	if _, dup, err := complete.Block("user", "reply", "segment-2", "same"); err != nil || !dup {
		t.Fatal("terminal redraw lost")
	}
	if _, _, err := complete.Block("user", "reply", "new", "x"); err != Correlation {
		t.Fatal("late block appended")
	}
}
