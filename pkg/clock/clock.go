// Package clock holds the production wall clock. Consumers declare their own
// Clock port; tests use pkg/fake instead of this package.
package clock

import "time"

// System reads the operating system's wall clock.
type System struct{}

// Now returns the current local time.
func (System) Now() time.Time { return time.Now() }
