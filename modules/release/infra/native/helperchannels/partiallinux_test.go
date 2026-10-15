//go:build linux

package helperchannels

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestPartialBackpressuredSocketWriteIsUncertain(t *testing.T) {
	a, peer := socketPair(t, unix.SOCK_STREAM)
	raw, _ := a.SyscallConn()
	var nativeErr error
	if err := raw.Control(func(fd uintptr) {
		nativeErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_SNDBUF, 1024)
	}); err != nil || nativeErr != nil {
		t.Fatalf("send buffer %v %v", err, nativeErr)
	}
	// Occupy one Linux Unix-stream send-buffer allocation. The remaining space
	// admits part of the 4096-byte ACK, then backpressures until its deadline.
	if _, err := a.Write([]byte{'p'}); err != nil {
		t.Fatal(err)
	}
	c := take(t, a, nil)
	frame := bytes.Repeat([]byte{'a'}, maxFrame)
	outcome(t, c.Emit(context.Background(), time.Now().Add(30*time.Millisecond), frame), "deadline", true)
	got, err := io.ReadAll(peer)
	if err != nil || len(got) <= 1 || len(got) >= maxFrame+1 || !bytes.Equal(got[1:], frame[:len(got)-1]) {
		t.Fatalf("expected partial ACK, got len=%d %v", len(got), err)
	}
	outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), frame), "ack_used", true)
}

func TestEmitSnapshotsCallerBytesBeforePartialWrite(t *testing.T) {
	a, peer := socketPair(t, unix.SOCK_STREAM)
	raw, _ := a.SyscallConn()
	var nativeErr error
	if err := raw.Control(func(fd uintptr) { nativeErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_SNDBUF, 1024) }); err != nil || nativeErr != nil {
		t.Fatalf("send buffer %v %v", err, nativeErr)
	}
	if _, err := a.Write([]byte{'p'}); err != nil {
		t.Fatal(err)
	}
	c := take(t, a, nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	c.state.afterIO = func(point string) {
		if point == "write" {
			once.Do(func() { close(entered); <-release })
		}
	}
	frame := bytes.Repeat([]byte{'a'}, maxFrame)
	want := append([]byte{'p'}, frame...)
	emitResult := make(chan error, 1)
	go func() { emitResult <- c.Emit(context.Background(), time.Now().Add(time.Second), frame) }()
	select {
	case <-entered:
	case err := <-emitResult:
		t.Fatalf("no initial partial write: %v", err)
	case <-time.After(time.Second):
		close(release)
		t.Fatal("write did not start")
	}
	// Initial capture completed before the native write/hook. Reuse is now safe
	// and must not replace bytes in the later backpressured chunks.
	for i := range frame {
		frame[i] = 'b'
	}
	type readResult struct {
		data []byte
		err  error
	}
	readDone := make(chan readResult, 1)
	go func() { data, err := io.ReadAll(peer); readDone <- readResult{data, err} }()
	close(release)
	if err := <-emitResult; err != nil {
		t.Fatal(err)
	}
	r := <-readDone
	if r.err != nil || !bytes.Equal(r.data, want) {
		t.Fatalf("snapshot mismatch len=%d %v", len(r.data), r.err)
	}
}
