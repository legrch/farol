//go:build !darwin

package boot

func readKernelBootUUID() (string, error) { return "", ErrUnavailable }
