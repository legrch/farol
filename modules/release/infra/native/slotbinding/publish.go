package slotbinding

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"sync"

	"github.com/legrch/farol/modules/release/app/port"
	"golang.org/x/sys/unix"
)

type fingerprint struct {
	device, inode                                  uint64
	mode, uid, gid                                 uint32
	links                                          uint64
	size, mtimeSec, mtimeNano, ctimeSec, ctimeNano int64
}

func (f fingerprint) identity() fingerprint {
	f.links = 0
	f.size = 0
	f.mtimeSec = 0
	f.mtimeNano = 0
	f.ctimeSec = 0
	f.ctimeNano = 0
	return f
}
func (f fingerprint) privateDirectory() bool {
	return f.mode&unix.S_IFMT == unix.S_IFDIR && f.uid == uint32(os.Geteuid()) && f.mode&0o077 == 0
}
func (f fingerprint) privateFile() bool {
	return f.mode&unix.S_IFMT == unix.S_IFREG && f.uid == uint32(os.Geteuid()) && f.mode&0o077 == 0 && f.links == 1 && f.size >= 1 && f.size <= maxRecord
}
func statFD(fd int) (fingerprint, error) {
	var st unix.Stat_t
	err := unix.Fstat(fd, &st)
	return metadata(st), err
}
func statAt(fd int, name string) (fingerprint, error) {
	var st unix.Stat_t
	err := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	return metadata(st), err
}
func directoryFlags() int {
	return unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
}
func fileFlags() int { return unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK }

type code string

func (c code) Error() string { return string(c) }

// Publisher borrows directory for its entire lifetime. The caller must keep the
// descriptor open and must serialize external writers through its admission.
// New and Publish never close, seek or transfer the borrowed descriptor.
type Publisher struct {
	directory *os.File
	identity  fingerprint
	mu        sync.Mutex
	// Retain a lost publication result for this exact publisher lifetime.
	// Reopening or observing bytes is not permission to replay an unknown call.
	uncertain bool
	// Deterministic tests only. Production leaves these nil.
	step      func(string) error
	create    func(int, string, int, uint32) (int, error)
	syncFile  func(int) error
	link      func(int, string, int, string, int) error
	unlink    func(int, string, int) error
	write     func(int, []byte) (int, error)
	closeFile func(int) error
}

var _ port.SlotBindingPublisher = (*Publisher)(nil)

func New(directory *os.File) (*Publisher, error) {
	if directory == nil {
		return nil, code("slot_binding_directory")
	}
	before, err := statFD(int(directory.Fd()))
	if err != nil || !before.privateDirectory() {
		return nil, code("slot_binding_directory")
	}
	return &Publisher{directory: directory, identity: before.identity()}, nil
}
func (p *Publisher) checkpoint(point string) error {
	if p.step != nil {
		return p.step(point)
	}
	return nil
}
func (p *Publisher) verify() error {
	st, err := statFD(int(p.directory.Fd()))
	if err != nil || !st.privateDirectory() || st.identity() != p.identity {
		return code("slot_binding_directory")
	}
	return nil
}
func (p *Publisher) names() ([]string, error) {
	fd, err := unix.Openat(int(p.directory.Fd()), ".", directoryFlags(), 0)
	if err != nil {
		return nil, err
	}
	view := os.NewFile(uintptr(fd), "slot-binding-directory-view")
	names, readErr := view.Readdirnames(2)
	closeErr := view.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return names, nil
}
func (p *Publisher) read() ([]byte, error) {
	if p.verify() != nil {
		return nil, code("slot_binding_directory")
	}
	parent := int(p.directory.Fd())
	before, err := statAt(parent, filename)
	if errors.Is(err, unix.ENOENT) {
		return nil, code("slot_binding_missing")
	}
	if err != nil || !before.privateFile() {
		return nil, code("slot_binding_type")
	}
	if p.checkpoint("read-open") != nil {
		return nil, code("slot_binding_changed")
	}
	fd, err := unix.Openat(parent, filename, fileFlags(), 0)
	if err != nil {
		return nil, code("slot_binding_changed")
	}
	// This is an owned file descriptor, never the borrowed operation directory.
	file := os.NewFile(uintptr(fd), filename)
	closed := false
	defer func() {
		if !closed {
			file.Close()
		}
	}()
	held, err := statFD(fd)
	if err != nil || held != before {
		return nil, code("slot_binding_changed")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxRecord+1))
	if err != nil || int64(len(data)) != before.size || len(data) > maxRecord {
		return nil, code("slot_binding_changed")
	}
	if p.checkpoint("read-bytes") != nil {
		return nil, code("slot_binding_changed")
	}
	held, err = statFD(fd)
	if err != nil || held != before {
		return nil, code("slot_binding_changed")
	}
	named, err := statAt(parent, filename)
	if err != nil || named != before || p.verify() != nil {
		return nil, code("slot_binding_changed")
	}
	err = file.Close()
	closed = true
	if err != nil {
		return nil, code("slot_binding_changed")
	}
	return data, nil
}
func result(decision port.SlotBindingDecision, c string) (port.SlotBindingResult, error) {
	return port.SlotBindingResult{Decision: decision, Code: c}, nil
}

func (p *Publisher) Publish(ctx context.Context, data []byte) (port.SlotBindingResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	refuse := func(c string) (port.SlotBindingResult, error) { return result(port.SlotBindingRefused, c) }
	unknown := func() (port.SlotBindingResult, error) {
		p.uncertain = true
		return result(port.SlotBindingUnknown, "slot_binding_publication_unconfirmed")
	}
	if p.uncertain {
		return unknown()
	}
	if ctx.Err() != nil {
		return refuse("slot_binding_cancelled")
	}
	if len(data) < 1 || len(data) > maxRecord {
		return refuse("slot_binding_invalid")
	}
	data = append([]byte(nil), data...)
	if !canonical(data) {
		return refuse("slot_binding_invalid")
	}
	if p.verify() != nil {
		return refuse("slot_binding_directory")
	}
	parent := int(p.directory.Fd())
	if _, err := statAt(parent, filename); err == nil {
		existing, err := p.read()
		if err != nil {
			return refuse(err.Error())
		}
		if !bytes.Equal(existing, data) {
			return refuse("slot_binding_mismatch")
		}
		if ctx.Err() != nil {
			return refuse("slot_binding_cancelled")
		}
		return result(port.SlotBindingConfirmed, "SLOT_BINDING_OK")
	} else if !errors.Is(err, unix.ENOENT) {
		return refuse("slot_binding_type")
	}
	names, err := p.names()
	if err != nil || len(names) != 0 {
		return refuse("slot_binding_publication_unconfirmed")
	}
	var nonce [12]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return refuse("slot_binding_publication_unconfirmed")
	}
	temp := ".slot-binding-" + hex.EncodeToString(nonce[:])
	if p.checkpoint("create-before") != nil || p.verify() != nil {
		return refuse("slot_binding_publication_unconfirmed")
	}
	if ctx.Err() != nil {
		return refuse("slot_binding_cancelled")
	}
	// From this invocation onward any failure or caller cancellation is unknown.
	create := p.create
	if create == nil {
		create = unix.Openat
	}
	syncFile := p.syncFile
	if syncFile == nil {
		syncFile = unix.Fsync
	}
	link := p.link
	if link == nil {
		link = unix.Linkat
	}
	unlink := p.unlink
	if unlink == nil {
		unlink = unix.Unlinkat
	}
	fd, err := create(parent, temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return unknown()
	}
	closed := false
	defer func() {
		if !closed {
			unix.Close(fd)
		}
	}()
	if p.checkpoint("create-after") != nil {
		return unknown()
	}
	created, err := statFD(fd)
	if err != nil || created.mode&unix.S_IFMT != unix.S_IFREG || created.uid != uint32(os.Geteuid()) || created.mode&0o077 != 0 || created.links != 1 || created.size != 0 {
		return unknown()
	}
	write := p.write
	if write == nil {
		write = unix.Write
	}
	for offset := 0; offset < len(data); {
		if p.checkpoint("write-before") != nil {
			return unknown()
		}
		n, err := write(fd, data[offset:])
		if err != nil || n <= 0 || n > len(data)-offset {
			return unknown()
		}
		offset += n
	}
	if p.checkpoint("file-sync-before") != nil || syncFile(fd) != nil || p.checkpoint("file-sync-after") != nil {
		return unknown()
	}
	complete, err := statFD(fd)
	if err != nil || !complete.privateFile() || complete.identity() != created.identity() || complete.size != int64(len(data)) {
		return unknown()
	}
	closeFile := p.closeFile
	if closeFile == nil {
		closeFile = unix.Close
	}
	err = closeFile(fd)
	closed = true
	if err != nil || p.checkpoint("file-close-after") != nil {
		return unknown()
	}
	if p.verify() != nil {
		return unknown()
	}
	names, err = p.names()
	if err != nil || len(names) != 1 || names[0] != temp {
		return unknown()
	}
	held, err := statAt(parent, temp)
	if err != nil || held != complete {
		return unknown()
	}
	if p.checkpoint("link-before") != nil {
		return unknown()
	}
	err = link(parent, temp, parent, filename, 0)
	if err != nil && !errors.Is(err, unix.EEXIST) {
		return unknown()
	}
	if p.checkpoint("link-after") != nil {
		return unknown()
	}
	// Remove only the exact temporary we created. No other cleanup is authorized.
	held, err = statAt(parent, temp)
	if err != nil || (held.links != 1 && held.links != 2) || held.identity() != complete.identity() || held.size != complete.size || held.mtimeSec != complete.mtimeSec || held.mtimeNano != complete.mtimeNano {
		return unknown()
	}
	if p.verify() != nil || p.checkpoint("unlink-before") != nil {
		return unknown()
	}
	if unlink(parent, temp, 0) != nil || p.checkpoint("unlink-after") != nil {
		return unknown()
	}
	if p.checkpoint("directory-sync-before") != nil || syncFile(parent) != nil || p.checkpoint("directory-sync-after") != nil {
		return unknown()
	}
	if p.checkpoint("readback-before") != nil {
		return unknown()
	}
	final, err := p.read()
	if err != nil || !bytes.Equal(final, data) {
		return unknown()
	}
	if p.checkpoint("ack-before") != nil || ctx.Err() != nil {
		return unknown()
	}
	return result(port.SlotBindingConfirmed, "SLOT_BINDING_OK")
}
