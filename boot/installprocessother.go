//go:build !darwin

package boot

import (
	"context"
	"errors"
)

func resolveInstallExecutable(context.Context, int) (string, error) {
	return "", errors.New("INSTALL_PLATFORM_UNSUPPORTED")
}
