package boot

import (
	"io"
	"os"

	desktopapp "github.com/legrch/farol/modules/release/app/services/desktop"
	desktoplauncher "github.com/legrch/farol/modules/release/infra/native/desktop"
)

const desktopLauncherCommand = "run-desktop-launcher"

func runDesktopLauncher(args []string, in io.ReadCloser, out io.WriteCloser, diagnostics io.Writer) int {
	executable, err := os.Executable()
	input, inputOK := in.(*os.File)
	output, outputOK := out.(*os.File)
	if err != nil || !inputOK || !outputOK {
		return 78
	}
	return desktoplauncher.Run(executable, args, input, output, diagnostics, desktopapp.Valid)
}
