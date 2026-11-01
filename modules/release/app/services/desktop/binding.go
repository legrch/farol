// Package desktop defines the private launcher's lifetime binding.
// Acceptance grants observation custody only, never permission to apply an update.
package desktop

import (
	"regexp"

	"github.com/legrch/farol/modules/release/app/port"
)

var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var operation = regexp.MustCompile(`^[a-f0-9]{32}$`)
var version = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)

func validBuild(b port.DesktopLifetimeBuild) bool {
	return digest.MatchString(b.BuildID) && digest.MatchString(b.Digest) && len(b.Version) <= 128 && version.MatchString(b.Version)
}

// Valid uses values supplied by the native boundary, not an ambient clock.
// The desktop retains the original helper readiness deadline across this hop.
func Valid(b port.DesktopLifetimeBinding, desktop int, now int64) bool {
	return b.Schema == "farol.desktop-helper-lifetime/1" && operation.MatchString(b.OperationID) &&
		(b.Action == "apply" || b.Action == "recover" || b.Action == "rollback") &&
		(b.Location == "shared" || b.Location == "legacy") && validBuild(b.Source) && validBuild(b.Target) &&
		b.Source.Digest != b.Target.Digest && b.Predecessor.PID == desktop && desktop > 1 &&
		b.Helper.PID > 1 && b.Helper.PID != desktop &&
		len(b.Predecessor.Start) > 0 && len(b.Predecessor.Start) <= 128 &&
		len(b.Helper.Start) > 0 && len(b.Helper.Start) <= 128 && b.Deadline > now && b.Deadline-now <= 300_000
}
