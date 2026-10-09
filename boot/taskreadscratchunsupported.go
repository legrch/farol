//go:build !darwin

package boot

// No lexical, HOME/cwd, or weaker-platform fallback.
func nativeTaskScratchOS() taskScratchOS { return nil }
