// Package fake holds test doubles for kernel and kit types. Only test files
// import it.
package fake

import "time"

// Clock is a fixed wall clock: Now always returns At.
type Clock struct{ At time.Time }

// Now returns the fixed time.
func (c Clock) Now() time.Time { return c.At }
