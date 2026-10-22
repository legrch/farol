//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// This bounded native witness inspects only this test process. No Dev lookup,
// profile, GUI, signal or provider call is involved.
func TestNativeExecutableCurrentProcess(t *testing.T) {
	want, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	want, err = filepath.EvalSymlinks(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := nativeExecutable(os.Getpid())
	if err != nil || got != want {
		t.Fatalf("proc_pidpath = %q, %v; want %q", got, err, want)
	}
}
