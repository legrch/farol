package boot

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Real Release service/native publisher and disposable descriptors. This does
// not launch an app/helper, transfer native admission or prove macOS semantics.
func TestInheritedInstalledSlotBinding(t *testing.T) {
	fixture, err := os.ReadFile("../modules/release/infra/native/slotbinding/testdata/slot-binding.bytes")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"confirmed", "existing", "mismatch", "invalid", "oversized", "deadline", "wrong-directory", "lost-ack"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			data := append([]byte(nil), fixture...)
			filename := filepath.Join(root, "slot-binding.json")
			if mode == "existing" || mode == "mismatch" {
				if err := os.WriteFile(filename, fixture, 0600); err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "mismatch":
				data = bytes.Replace(data, []byte(`"shared"`), []byte(`"legacy"`), 1)
			case "invalid":
				data = []byte("{}\n")
			case "oversized":
				data = bytes.Repeat([]byte("x"), 8193)
			}
			directory, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer directory.Close()
			if mode == "wrong-directory" {
				if err := os.WriteFile(filepath.Join(root, "not-directory"), []byte("file"), 0600); err != nil {
					t.Fatal(err)
				}
				directory.Close()
				directory, err = os.Open(filepath.Join(root, "not-directory"))
				if err != nil {
					t.Fatal(err)
				}
				defer directory.Close()
			}
			read, write, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer read.Close()
			defer write.Close()
			inputFD, err := unix.Dup(int(read.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			directoryFD, err := unix.Dup(int(directory.Fd()))
			if err != nil {
				unix.Close(inputFD)
				t.Fatal(err)
			}
			deadline := time.Now().Add(2 * time.Second)
			var written chan struct{}
			if mode == "deadline" {
				deadline = time.Now().Add(10 * time.Millisecond)
			} else {
				written = make(chan struct{})
				go func() {
					defer close(written)
					_, _ = write.Write(data)
					_ = write.Close()
				}()
			}
			var output, diagnostics bytes.Buffer
			var out io.Writer = &output
			if mode == "lost-ack" {
				out = slotBindingFailedWriter{}
			}
			code := publishInheritedSlotBinding([]string{"--build-id", strings.Repeat("a", 64)}, strings.Repeat("a", 64), inputFD, directoryFD, deadline, out, &diagnostics)
			if written != nil {
				<-written
			}
			wanted := 70
			if mode == "confirmed" || mode == "existing" {
				wanted = 0
			} else if mode == "lost-ack" {
				wanted = 75
			}
			if code != wanted || (wanted == 0 && (output.String() != "SLOT_BINDING_OK\n" || diagnostics.Len() != 0)) || (wanted != 0 && output.Len() != 0) {
				t.Fatalf("code=%d output=%q diagnostic=%q", code, output.String(), diagnostics.String())
			}
			var stat unix.Stat_t
			if unix.Fstat(inputFD, &stat) != unix.EBADF || unix.Fstat(directoryFD, &stat) != unix.EBADF {
				t.Fatal("child-owned descriptor leaked")
			}
			if _, err := directory.Stat(); err != nil {
				t.Fatal("parent's borrowed descriptor was closed", err)
			}
			actual, err := os.ReadFile(filename)
			if wanted == 0 || mode == "lost-ack" || mode == "mismatch" {
				if err != nil || !bytes.Equal(actual, fixture) {
					t.Fatal("committed or immutable bytes changed", err)
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				t.Fatal("refused input published bytes", err)
			}
		})
	}
}

type slotBindingFailedWriter struct{}

func (slotBindingFailedWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestInstalledSlotBindingRejectsCrossedBuildBeforeFDUse(t *testing.T) {
	for _, args := range [][]string{nil, {"--build-id", "other"}, {"--build-id", strings.Repeat("a", 64), "extra"}} {
		if code := publishInheritedSlotBinding(args, strings.Repeat("a", 64), -1, -1, time.Now(), io.Discard, io.Discard); code != 2 {
			t.Fatal("invalid build selection accepted", args, code)
		}
	}
}

func TestInstalledSlotBindingChildProcess(t *testing.T) {
	const childFlag = "FAROL_TEST_SLOT_BINDING_CHILD"
	const build = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if os.Getenv(childFlag) == "1" {
		BuildID = build
		os.Exit(Run([]string{"publish-installed-slot-binding", "--build-id", build}, os.Stdin, os.Stdout, os.Stderr))
	}
	// Execute this built Go test process with the actual inherited fd3/fd4 CLI
	// protocol and no usable PATH. This is not a packaged application process.
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	directory, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	data, err := os.ReadFile("../modules/release/infra/native/slotbinding/testdata/slot-binding.bytes")
	if err != nil {
		write.Close()
		t.Fatal(err)
	}
	if _, err := write.Write(data); err != nil {
		write.Close()
		t.Fatal(err)
	}
	if err := write.Close(); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^TestInstalledSlotBindingChildProcess$")
	child.Env = []string{childFlag + "=1", "PATH=/farol-no-external-toolchain", "LANG=C.UTF-8"}
	child.ExtraFiles = []*os.File{read, directory}
	child.WaitDelay = time.Second
	var out, diagnostics bytes.Buffer
	child.Stdout, child.Stderr = &out, &diagnostics
	if err := child.Run(); err != nil || out.String() != "SLOT_BINDING_OK\n" || diagnostics.Len() != 0 {
		t.Fatalf("child=%v output=%q diagnostics=%q", err, out.String(), diagnostics.String())
	}
	actual, err := os.ReadFile(filepath.Join(root, "slot-binding.json"))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("child did not publish canonical bytes", err)
	}
	if _, err := directory.Stat(); err != nil {
		t.Fatal("child closed original parent descriptor", err)
	}
}
