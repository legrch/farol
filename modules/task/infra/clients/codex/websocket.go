package codex

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode/utf8"
)

// This is the existing RFC 6455 transport over proxy stdin/stdout, with the
// vendor /rpc endpoint. It opens no listener/dial path and negotiates no compression.
type websocket struct {
	stream io.ReadWriteCloser
	reader *bufio.Reader
	writes sync.Mutex
}

func protocolError() error { return errors.New("CODEX_PROXY_PROTOCOL_INVALID") }
func newWebsocket(stream io.ReadWriteCloser) *websocket {
	return &websocket{stream: stream, reader: bufio.NewReaderSize(stream, 4096)}
}
func (w *websocket) handshake() error {
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		return protocolError()
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	request := "GET /rpc HTTP/1.1\r\nHost: codex-app-server\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if err := writeAll(w.stream, []byte(request)); err != nil {
		return err
	}
	// Bound both individual lines and total headers; preserve buffered frame bytes.
	headers := map[string]string{}
	total := 0
	line, err := w.line(&total)
	if err != nil || line != "HTTP/1.1 101 Switching Protocols" {
		return protocolError()
	}
	for {
		line, err = w.line(&total)
		if err != nil {
			return err
		}
		if line == "" {
			break
		}
		name, val, ok := strings.Cut(line, ":")
		name = strings.ToLower(name)
		if !ok || name == "" || strings.ContainsAny(name, " \t") {
			return protocolError()
		}
		if _, duplicate := headers[name]; duplicate {
			return protocolError()
		}
		headers[name] = strings.TrimSpace(val)
	}
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if !strings.EqualFold(headers["upgrade"], "websocket") || !headerToken(headers["connection"], "upgrade") || headers["sec-websocket-accept"] != base64.StdEncoding.EncodeToString(h[:]) || headers["sec-websocket-extensions"] != "" || headers["sec-websocket-protocol"] != "" {
		return protocolError()
	}
	return nil
}
func (w *websocket) line(total *int) (string, error) {
	b, err := w.reader.ReadSlice('\n')
	*total += len(b)
	if err != nil || *total > 16*1024 || len(b) < 2 || b[len(b)-2] != '\r' {
		return "", protocolError()
	}
	return string(b[:len(b)-2]), nil
}
func headerToken(s, token string) bool {
	for _, part := range strings.Split(s, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}
func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if n < 0 || n > len(data) {
			return protocolError()
		}
		data = data[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
func (w *websocket) send(op byte, data []byte) error {
	if len(data) > maxMessageBytes || op >= 8 && len(data) > 125 {
		return protocolError()
	}
	w.writes.Lock()
	defer w.writes.Unlock()
	head := []byte{0x80 | op, 0x80}
	if len(data) < 126 {
		head[1] |= byte(len(data))
	} else if len(data) <= 65535 {
		head[1] |= 126
		head = binary.BigEndian.AppendUint16(head, uint16(len(data)))
	} else {
		head[1] |= 127
		head = binary.BigEndian.AppendUint64(head, uint64(len(data)))
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return protocolError()
	}
	head = append(head, mask...)
	frame := make([]byte, len(head)+len(data))
	copy(frame, head)
	for i, b := range data {
		frame[len(head)+i] = b ^ mask[i%4]
	}
	return writeAll(w.stream, frame)
}
func (w *websocket) receive() ([]byte, error) {
	var message bytes.Buffer
	fragmented := false
	for {
		var head [2]byte
		if _, err := io.ReadFull(w.reader, head[:]); err != nil {
			return nil, err
		}
		fin := head[0]&0x80 != 0
		op := head[0] & 15
		if head[0]&0x70 != 0 || head[1]&0x80 != 0 {
			return nil, protocolError()
		}
		size := uint64(head[1] & 127)
		if size == 126 {
			var n [2]byte
			if _, err := io.ReadFull(w.reader, n[:]); err != nil {
				return nil, err
			}
			size = uint64(binary.BigEndian.Uint16(n[:]))
			if size < 126 {
				return nil, protocolError()
			}
		}
		if size == 127 {
			var n [8]byte
			if _, err := io.ReadFull(w.reader, n[:]); err != nil {
				return nil, err
			}
			size = binary.BigEndian.Uint64(n[:])
			if size <= 65535 {
				return nil, protocolError()
			}
		}
		if size > maxMessageBytes || op < 8 && size+uint64(message.Len()) > maxMessageBytes || op >= 8 && (!fin || size > 125) {
			return nil, protocolError()
		}
		data := make([]byte, int(size))
		if _, err := io.ReadFull(w.reader, data); err != nil {
			return nil, err
		}
		switch op {
		case 1:
			if fragmented {
				return nil, protocolError()
			}
			fragmented = !fin
			message.Write(data)
		case 0:
			if !fragmented {
				return nil, protocolError()
			}
			message.Write(data)
			fragmented = !fin
		case 8:
			return nil, fmt.Errorf("CODEX_PROXY_CLOSED")
		case 9:
			if err := w.send(10, data); err != nil {
				return nil, err
			}
			continue
		case 10:
			continue
		default:
			return nil, protocolError()
		}
		if message.Len() > maxMessageBytes {
			return nil, protocolError()
		}
		if fin {
			raw := message.Bytes()
			if !utf8.Valid(raw) {
				return nil, protocolError()
			}
			return raw, nil
		}
	}
}
