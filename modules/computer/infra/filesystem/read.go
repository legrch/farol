package filesystem

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

func (w *Workspace) Read(ctx context.Context, request port.ReadRequest) (*port.ReadResponse, error) {
	return w.read(ctx, request, nil)
}

// ReadScratch verifies the actual opened descriptors against the original
// diagnostic custody. The ordinary read policy and disclosure checks still apply.
func (w *Workspace) ReadScratch(ctx context.Context, request port.ReadRequest, binding port.ScratchReadBinding) (*port.ReadResponse, error) {
	if !validScratchReadBinding(binding) || request.RelativePath != mutation.ScratchPath(binding.RunID)+"/check.txt" || request.Range != nil {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	return w.read(ctx, request, &binding)
}

func (w *Workspace) read(ctx context.Context, request port.ReadRequest, binding *port.ScratchReadBinding) (*port.ReadResponse, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	parts, err := components(request.RelativePath, false, false)
	if err != nil {
		return nil, err
	}
	p, err := w.parsePolicy(request.Workspace)
	if err != nil {
		return nil, err
	}
	if p.denies(parts) || !p.permitsFile(request.RelativePath) {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if request.Range != nil && (request.Range.Length < 4 || request.Range.Length > maxReadBytes || request.Range.Offset > 9007199254740991) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	root, err := openRoot(request.Workspace)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	rootInfo, err := stat(root)
	if err != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	parent, err := walk(root, parts[:len(parts)-1])
	if err != nil {
		return nil, err
	}
	defer unix.Close(parent)
	fd, before, err := regular(parent, parts[len(parts)-1])
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	checkScratch := func() bool { return binding == nil || scratchOpenedMatches(root, parent, fd, *binding) }
	if !checkScratch() {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	if before.Size < 0 {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	var offset uint64
	length := uint64(before.Size)
	if request.Range == nil {
		if length > maxReadBytes {
			return nil, refusal("WORKSPACE_FILE_TOO_LARGE")
		}
	} else {
		offset = request.Range.Offset
		length = uint64(request.Range.Length)
		if offset >= uint64(before.Size) {
			length = 0
		} else if length > uint64(before.Size)-offset {
			length = uint64(before.Size) - offset
		}
	}
	if offset > math.MaxInt64 {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	raw := make([]byte, int(length))
	for read := 0; read < len(raw); {
		if err := cancelled(ctx); err != nil {
			return nil, err
		}
		n, err := unix.Pread(fd, raw[read:], int64(offset)+int64(read))
		if err == unix.EINTR {
			continue
		}
		if err != nil || n == 0 {
			return nil, refusal("WORKSPACE_RACE_DETECTED")
		}
		read += n
	}
	if w.afterRead != nil {
		w.afterRead()
	}
	after, err := stat(fd)
	if err != nil {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	if !stable(before, after) || after.Nlink != 1 || !checkScratch() {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	if err := recheckRoot(request.Workspace, rootInfo); err != nil {
		return nil, err
	}
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		return nil, refusal("WORKSPACE_NOT_TEXT")
	}
	start, end := 0, len(raw)
	if request.Range != nil {
		for offset > 0 && start < 3 && start < len(raw) && raw[start]&0xc0 == 0x80 {
			start++
		}
		if offset+uint64(len(raw)) < uint64(before.Size) {
			for i := len(raw) - 1; i >= start && i >= len(raw)-4; i-- {
				lead := raw[i]
				if lead&0xc0 == 0x80 {
					continue
				}
				width := 1
				if lead >= 0xf0 {
					width = 4
				} else if lead >= 0xe0 {
					width = 3
				} else if lead >= 0xc0 {
					width = 2
				}
				if i+width > len(raw) {
					end = i
				}
				break
			}
		}
	}
	payload := raw[start:end]
	if !utf8.Valid(payload) {
		return nil, refusal("WORKSPACE_NOT_TEXT")
	}
	text := payload
	if offset+uint64(start) == 0 {
		text = bytes.TrimPrefix(text, []byte{0xef, 0xbb, 0xbf})
	}
	response := &port.ReadResponse{Text: string(text), Bytes: uint64(len(payload))}
	if request.Range == nil {
		digest := sha256.Sum256(raw)
		response.SHA256 = hex.EncodeToString(digest[:])
	} else {
		var next *uint64
		boundary := offset + uint64(end)
		if boundary < uint64(before.Size) {
			next = &boundary
		}
		response.Page = &port.Page{Offset: offset + uint64(start), Size: uint64(before.Size), NextOffset: next}
	}
	return response, nil
}
