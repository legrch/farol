//go:build !darwin

package processprobe

func supported() bool { return false }
