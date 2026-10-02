package ipc

import (
	"encoding/binary"
	"errors"
	"io"
)

const MaxFrameBytes = 1 << 20

var ErrFrame = errors.New("invalid frame length")

// ReadFrame admits the length before allocating; EOF mid-header/body is a fault.
func ReadFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > MaxFrameBytes {
		return nil, ErrFrame
	}
	data := make([]byte, int(n))
	_, err := io.ReadFull(r, data)
	return data, err
}

func WriteFrame(w io.Writer, data []byte) error {
	if len(data) == 0 || len(data) > MaxFrameBytes {
		return ErrFrame
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	for _, part := range [][]byte{header[:], data} {
		for len(part) > 0 {
			n, err := w.Write(part)
			if err != nil {
				return err
			}
			if n <= 0 || n > len(part) {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}
