//go:build !darwin

package installmove

// There is deliberately no production Linux renameat2 fallback.
func productionBackend() backend { return nil }
