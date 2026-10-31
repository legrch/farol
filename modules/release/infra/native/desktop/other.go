//go:build !darwin

package desktop

import (
	"github.com/legrch/farol/modules/release/app/port"
	"io"
	"os"
)

func Run(_ string, _ []string, _ *os.File, _ *os.File, diagnostics io.Writer, _ func(port.DesktopLifetimeBinding, int, int64) bool) int {
	_, _ = io.WriteString(diagnostics, "desktop_launcher_unsupported\n")
	return 78
}
