// Package root holds the numeric physical identity of a trusted storage root.
package root

// Identity names one directory by device, inode and owning user. It carries no
// path. String wire forms of the same facts stay in their contracts.
type Identity struct {
	Device, Inode uint64
	OwnerUID      uint32
}

// Valid reports whether the identity names an object: device and inode are
// both nonzero. The owner is not part of validity because a root owned by uid 0
// is a real object.
func (i Identity) Valid() bool { return i.Device != 0 && i.Inode != 0 }

// Same reports whether a and b name the same filesystem object: equal device
// and inode. The owner is deliberately ignored; compare structs with == for
// full equality.
func Same(a, b Identity) bool { return a.Device == b.Device && a.Inode == b.Inode }
