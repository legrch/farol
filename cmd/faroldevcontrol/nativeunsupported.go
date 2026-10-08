//go:build !darwin

package main

// There is no portable fallback, process discovery or numeric-PID signal path.
func nativePorts() ports { return ports{} }
