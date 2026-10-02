package ipc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"time"
)

func TestFrameAdmission(t *testing.T) {
	for _, n := range []uint32{0, MaxFrameBytes + 1, 0xffffffff} {
		header := make([]byte, 4)
		binary.BigEndian.PutUint32(header, n)
		if _, err := ReadFrame(bytes.NewReader(header)); !errors.Is(err, ErrFrame) {
			t.Fatalf("length %d: %v", n, err)
		}
	}
	for _, data := range [][]byte{{0}, {0, 0, 0, 3, 'x'}} {
		if _, err := ReadFrame(bytes.NewReader(data)); err != io.ErrUnexpectedEOF {
			t.Fatalf("truncated: %v", err)
		}
	}
}
func TestFramesAndBackpressure(t *testing.T) {
	in, out := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- WriteFrame(out, []byte("hello")) }()
	select {
	case <-done:
		t.Fatal("write bypassed backpressure")
	case <-time.After(10 * time.Millisecond):
	}
	data, err := ReadFrame(in)
	if err != nil || string(data) != "hello" {
		t.Fatalf("%s %v", data, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	in.Close()
	out.Close()
	var b bytes.Buffer
	for _, data := range []string{"one", "two"} {
		if err := WriteFrame(&b, []byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	for _, expected := range []string{"one", "two"} {
		data, err := ReadFrame(&b)
		if err != nil || string(data) != expected {
			t.Fatalf("%s %v", data, err)
		}
	}
}
func TestStrictJSON(t *testing.T) {
	for _, data := range [][]byte{[]byte(`{"id":"a","id":"b"}`), []byte(`{"a":{"x":1,"x":2}}`), []byte(`{} {}`), []byte(`{"text":"` + string([]byte{0xff}) + `"}`), []byte(`[` + string(bytes.Repeat([]byte("["), 33)) + `]`)} {
		if ValidateJSON(data) == nil {
			t.Fatalf("accepted %q", data)
		}
	}
	if err := ValidateJSON([]byte(`{"text":"Лампа 🪔","bytes":"18446744073709551615"}`)); err != nil {
		t.Fatal(err)
	}
}
