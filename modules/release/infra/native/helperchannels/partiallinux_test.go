//go:build linux

package helperchannels

import (
	"bytes"
	"context"
	"io"
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
