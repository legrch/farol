package root

import "testing"

func TestValid(t *testing.T) {
	cases := []struct {
		name string
		in   Identity
		want bool
	}{
		{"all set", Identity{Device: 1, Inode: 2, OwnerUID: 501}, true},
		{"owner zero", Identity{Device: 1, Inode: 2}, true},
		{"zero value", Identity{}, false},
		{"device zero", Identity{Inode: 2, OwnerUID: 501}, false},
		{"inode zero", Identity{Device: 1, OwnerUID: 501}, false},
		{"owner only", Identity{OwnerUID: 501}, false},
		{"maximum", Identity{Device: ^uint64(0), Inode: ^uint64(0), OwnerUID: ^uint32(0)}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.in.Valid(); got != c.want {
				t.Fatalf("Valid(%+v) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestSame(t *testing.T) {
	base := Identity{Device: 1, Inode: 2, OwnerUID: 501}
	cases := []struct {
		name string
		a, b Identity
		want bool
	}{
		{"equal", base, base, true},
		{"owner differs", base, Identity{Device: 1, Inode: 2, OwnerUID: 0}, true},
		{"device differs", base, Identity{Device: 9, Inode: 2, OwnerUID: 501}, false},
		{"inode differs", base, Identity{Device: 1, Inode: 9, OwnerUID: 501}, false},
		{"zero values", Identity{}, Identity{}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Same(c.a, c.b); got != c.want {
				t.Fatalf("Same(%+v, %+v) = %v, want %v", c.a, c.b, got, c.want)
			}
			if got := Same(c.b, c.a); got != c.want {
				t.Fatalf("Same is not symmetric for %+v, %+v", c.a, c.b)
			}
		})
	}
}

// TestMatchesRetiredCopies pins the predicates that four chat packages carried
// as private copies: Device and Inode nonzero, and the Device plus Inode
// comparison that ignored the owner.
func TestMatchesRetiredCopies(t *testing.T) {
	values := []uint64{0, 1, 7, ^uint64(0)}
	owners := []uint32{0, 501}
	for _, d := range values {
		for _, i := range values {
			for _, o := range owners {
				a := Identity{Device: d, Inode: i, OwnerUID: o}
				if got, want := a.Valid(), a.Device != 0 && a.Inode != 0; got != want {
					t.Fatalf("Valid(%+v) = %v, retired = %v", a, got, want)
				}
				for _, d2 := range values {
					for _, i2 := range values {
						b := Identity{Device: d2, Inode: i2, OwnerUID: 9}
						if got, want := Same(a, b), a.Device == b.Device && a.Inode == b.Inode; got != want {
							t.Fatalf("Same(%+v, %+v) = %v, retired = %v", a, b, got, want)
						}
					}
				}
			}
		}
	}
}
