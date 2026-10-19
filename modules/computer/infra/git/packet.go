// Package git implements an unselected, credential-free receive-pack protocol
// gate. Standard Git and hooks remain in the developer sandbox; a separately
// admitted owner supplies the exact authenticated remote stream. This package
// does not dial, spawn, grant permissions, modify Git config or expose MCP tools.
package git

import (
	"errors"
	"fmt"
	"io"
	"strconv"
)

var (
	ErrProtocol = errors.New("GIT_TRANSPORT_PROTOCOL")
	ErrLimit    = errors.New("GIT_TRANSPORT_LIMIT")
	ErrSource   = errors.New("GIT_TRANSPORT_SOURCE_MISMATCH")
	ErrRemote   = errors.New("GIT_TRANSPORT_REMOTE_CHANGED")
	ErrScope    = errors.New("GIT_TRANSPORT_SCOPE_REFUSED")
	ErrReplay   = errors.New("GIT_TRANSPORT_ALREADY_CONSUMED")
)

const maxPacket = 65520

func readPacket(r io.Reader) ([]byte, bool, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, false, truncated(err) // a partial length header
		}
		return nil, false, err // the stream closed between packets: a stream event
	}
	for _, c := range header {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return nil, false, ErrProtocol
		}
	}
	n, err := strconv.ParseUint(string(header[:]), 16, 16)
	if err != nil {
		return nil, false, ErrProtocol
	}
	if n == 0 {
		return nil, true, nil
	}
	// v0 push has no v2 delimiters/response-end control packets.
	if n < 4 || n > maxPacket {
		return nil, false, ErrProtocol
	}
	b := make([]byte, int(n)-4)
	if _, err = io.ReadFull(r, b); err != nil {
		return nil, false, truncated(err)
	}
	return b, false, nil
}

// truncated attributes a peer stream that ends inside a pkt-line to the
// peer's encoding (ErrProtocol), keeping the EOF cause; other stream errors
// keep their own class. A close exactly between packets stays a stream event.
func truncated(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return errors.Join(ErrProtocol, err)
	}
	return err
}
func packet(b []byte) ([]byte, error) {
	if len(b) > maxPacket-4 {
		return nil, ErrLimit
	}
	return append([]byte(fmt.Sprintf("%04x", len(b)+4)), b...), nil
}
func writeAll(w io.Writer, b []byte) (int64, error) {
	var total int64
	for len(b) > 0 {
		n, err := w.Write(b)
		if n < 0 || n > len(b) {
			return total, io.ErrShortWrite
		}
		total += int64(n)
		b = b[n:]
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}
