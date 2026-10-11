//go:build darwin

package desktop

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"golang.org/x/sys/unix"
)

// ConnectorListener is one backend-owned endpoint for one selected connector lifetime.
// It never reopens a retained root or accepts a caller-selected endpoint path.
type ConnectorListener struct {
	endpoint             wire.ComputerConnectorEndpoint
	config               ConnectorConfig
	root                 string
	rootInfo, socketInfo os.FileInfo
	listener             *net.UnixListener
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	connections          map[*net.UnixConn]bool
	closing              bool
	launchAttempted      bool
	beforeLaunchOpen     func() // Test-only substitution seam, before descriptor-relative create.
	beforeLaunchReadback func() // Test-only mutation seam, after the complete write and sync.
	acceptDone           chan struct{}
	workers              sync.WaitGroup
	closeOnce            sync.Once
	closeDone            chan struct{}
	closeErr             error
}

// PublishLaunch writes once relative to the captured private root descriptor.
// Pathname substitution can refuse publication but cannot redirect secret bytes.
// The file and any partial attempt remain evidence; this method never retries,
// chmods, renames or unlinks. Close waits for this original publisher as a worker.
func (s *ConnectorListener) PublishLaunch(ctx context.Context, data []byte) (publishedPath string, publishedDigest string, result error) {
	if ctx == nil || ctx.Err() != nil || len(data) == 0 || len(data) > 16384 {
		return "", "", ErrConnectorUnavailable
	}
	s.mu.Lock()
	if s.closing || s.launchAttempted {
		s.mu.Unlock()
		return "", "", ErrConnectorUnavailable
	}
	s.launchAttempted = true
	s.workers.Add(1)
	s.mu.Unlock()
	defer s.workers.Done()
	current := func() bool { return ctx.Err() == nil && s.ctx.Err() == nil && s.pathsCurrent() }
	if !current() {
		return "", "", ErrConnectorUnavailable
	}
	rootFD, err := unix.Open(s.root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", "", ErrConnectorUnavailable
	}
	defer func() {
		if unix.Close(rootFD) != nil {
			result = ErrConnectorUnavailable
		}
	}()
	var rootStat unix.Stat_t
	expected := s.rootInfo.Sys().(*syscall.Stat_t)
	if unix.Fstat(rootFD, &rootStat) != nil || uint64(rootStat.Dev) != uint64(expected.Dev) || rootStat.Ino != expected.Ino || rootStat.Mode&07777 != 0700 || rootStat.Uid != uint32(os.Getuid()) {
		return "", "", ErrConnectorUnavailable
	}
	if s.beforeLaunchOpen != nil {
		s.beforeLaunchOpen()
	}
	const name = "computer-go-launch.json"
	fd, err := unix.Openat(rootFD, name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	if err != nil {
		return "", "", ErrConnectorUnavailable
	}
	file := os.NewFile(uintptr(fd), name)
	defer func() {
		if file.Close() != nil {
			result = ErrConnectorUnavailable
		}
	}()
	check := func(size int64) bool {
		var held, entry unix.Stat_t
		return unix.Fstat(fd, &held) == nil && unix.Fstatat(rootFD, name, &entry, unix.AT_SYMLINK_NOFOLLOW) == nil &&
			held.Dev == entry.Dev && held.Ino == entry.Ino && held.Mode&unix.S_IFMT == unix.S_IFREG && held.Mode&07777 == 0600 &&
			held.Uid == uint32(os.Getuid()) && held.Nlink == 1 && held.Size == size && entry.Size == size && current()
	}
	// Qualify the created descriptor AND its anchored entry before writing secrets.
	if !check(0) {
		return "", "", ErrConnectorUnavailable
	}
	if n, err := file.Write(data); err != nil || n != len(data) {
		return "", "", ErrConnectorUnavailable
	}
	if file.Sync() != nil || !check(int64(len(data))) {
		return "", "", ErrConnectorUnavailable
	}
	if s.beforeLaunchReadback != nil {
		s.beforeLaunchReadback()
	}
	// Read one extra byte: an equal prefix is not an exact publication.
	readback := make([]byte, len(data)+1)
	if n, err := file.ReadAt(readback, 0); err != io.EOF || n != len(data) || !bytes.Equal(readback[:n], data) || !check(int64(len(data))) {
		return "", "", ErrConnectorUnavailable
	}
	if unix.Fsync(rootFD) != nil || !check(int64(len(data))) {
		return "", "", ErrConnectorUnavailable
	}
	digest := sha256.Sum256(data)
	return filepath.Join(s.root, name), hex.EncodeToString(digest[:]), nil
}

// StartConnector creates a fresh private socket for the exact existing backend and owner.
// A startup failure preserves any partially created path, with no replacement
// listener, stale-path unlink, fallback port or retry.
func StartConnector(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]Method) (*ConnectorListener, error) {
	listener, _, err := startConnector(ctx, binding, methods)
	return listener, err
}

type connectorStartStage uint8

const (
	connectorStartReady connectorStartStage = iota
	connectorStartContext
	connectorStartEntropy
	connectorStartConfigPreflight
	connectorStartRootCreate
	connectorStartRootQualify
	connectorStartEndpointConfig
	connectorStartSocketListen
	connectorStartSocketQualify
)

// String exposes only fixed diagnostic labels, never startup inputs or OS errors.
func (stage connectorStartStage) String() string {
	switch stage {
	case connectorStartReady:
		return "ready"
	case connectorStartContext:
		return "context"
	case connectorStartEntropy:
		return "entropy"
	case connectorStartConfigPreflight:
		return "config-preflight"
	case connectorStartRootCreate:
		return "root-create"
	case connectorStartRootQualify:
		return "root-qualify"
	case connectorStartEndpointConfig:
		return "endpoint-config"
	case connectorStartSocketListen:
		return "socket-listen"
	case connectorStartSocketQualify:
		return "socket-qualify"
	default:
		return "unknown"
	}
}

// startConnector preserves the public error while identifying the failing stage
// for package-local diagnostics. A stage never proves endpoint creation or cleanup.
func startConnector(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]Method) (*ConnectorListener, connectorStartStage, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, connectorStartContext, ErrConnectorUnavailable
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, connectorStartEntropy, ErrConnectorUnavailable
	}
	endpoint := wire.ComputerConnectorEndpoint{Binding: binding, SocketPath: "/private/tmp/pending.sock", Token: hex.EncodeToString(secret[:])}
	selected := make(map[string]Method, len(methods))
	for name, method := range methods {
		selected[name] = method
	}
	config := ConnectorConfig{Endpoint: endpoint, Methods: selected}
	if validateConnectorConfig(config) != nil {
		return nil, connectorStartConfigPreflight, ErrConnectorUnavailable
	}
	root, err := os.MkdirTemp("/private/tmp", "farol-mcp-")
	if err != nil {
		return nil, connectorStartRootCreate, ErrConnectorUnavailable
	}
	info, err := os.Lstat(root)
	if err != nil || !safeConnectorRoot(root, info) {
		return nil, connectorStartRootQualify, ErrConnectorUnavailable
	}
	endpoint.SocketPath = filepath.Join(root, "computer.sock")
	config.Endpoint = endpoint
	if validateConnectorConfig(config) != nil {
		return nil, connectorStartEndpointConfig, ErrConnectorUnavailable
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint.SocketPath, Net: "unix"})
	if err != nil {
		return nil, connectorStartSocketListen, ErrConnectorUnavailable
	}
	listener.SetUnlinkOnClose(false)
	// The private 0700 directory controls endpoint access. Preserve the socket's
	// creation mode instead of chmod by pathname (which could follow a replacement).
	socketInfo, err := os.Lstat(endpoint.SocketPath)
	if err != nil || !safeConnectorSocket(socketInfo) {
		_ = listener.Close()
		return nil, connectorStartSocketQualify, ErrConnectorUnavailable
	}
	selectedCtx, cancel := context.WithCancel(ctx)
	owned := &ConnectorListener{endpoint: endpoint, config: config, root: root, rootInfo: info, socketInfo: socketInfo, listener: listener, ctx: selectedCtx, cancel: cancel, connections: make(map[*net.UnixConn]bool), acceptDone: make(chan struct{}), closeDone: make(chan struct{})}
	go owned.accept()
	go func() { <-selectedCtx.Done(); owned.beginClose() }()
	return owned, connectorStartReady, nil
}
func (s *ConnectorListener) Endpoint() wire.ComputerConnectorEndpoint { return s.endpoint }
func safeConnectorRoot(path string, info os.FileInfo) bool {
	if info == nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return false
	}
	real, err := filepath.EvalSymlinks(path)
	return err == nil && real == path
}
func safeConnectorSocket(info os.FileInfo) bool {
	if info == nil || info.Mode()&os.ModeSocket == 0 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && stat.Nlink == 1
}
func (s *ConnectorListener) pathsCurrent() bool {
	root, err := os.Lstat(s.root)
	if err != nil || !safeConnectorRoot(s.root, root) || !os.SameFile(s.rootInfo, root) {
		return false
	}
	socket, err := os.Lstat(s.endpoint.SocketPath)
	return err == nil && safeConnectorSocket(socket) && os.SameFile(s.socketInfo, socket)
}
func sameConnectorUser(connection *net.UnixConn) bool {
	raw, err := connection.SyscallConn()
	if err != nil {
		return false
	}
	accepted := false
	err = raw.Control(func(fd uintptr) {
		credential, e := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		accepted = e == nil && credential != nil && credential.Version == 0 && credential.Uid == uint32(os.Getuid())
	})
	return err == nil && accepted
}
func (s *ConnectorListener) accept() {
	defer close(s.acceptDone)
	for {
		connection, err := s.listener.AcceptUnix()
		if err != nil {
			s.beginClose()
			return
		}
		s.mu.Lock()
		if s.closing || len(s.connections) >= 32 {
			s.mu.Unlock()
			_ = connection.Close()
			continue
		}
		s.connections[connection] = true
		s.workers.Add(1)
		s.mu.Unlock()
		go func() {
			defer s.workers.Done()
			defer func() { _ = connection.Close(); s.mu.Lock(); delete(s.connections, connection); s.mu.Unlock() }()
			if !s.pathsCurrent() || !sameConnectorUser(connection) {
				return
			}
			_ = serveConnectorConnection(s.ctx, connection, s.config)
		}()
	}
}
func (s *ConnectorListener) beginClose() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closing = true
		s.cancel()
		_ = s.listener.Close()
		for connection := range s.connections {
			_ = connection.Close()
		}
		s.mu.Unlock()
		go func() {
			defer close(s.closeDone)
			<-s.acceptDone
			s.workers.Wait()
			// Closing exact handles settles this listener, not filesystem retirement.
			// macOS has no inode-conditional unlink. A pathname check followed by
			// Remove could delete a replacement installed after that check. Preserve
			// this small private endpoint as evidence; never reopen or reclaim it here.
		}()
	})
}

// Close's deadline is an observation bound, never proof that handlers settled.
// A repeated Close only observes the original close attempt; it retries no IO.
// The private endpoint path is retained; success does not claim path removal.
func (s *ConnectorListener) Close(ctx context.Context) error {
	if s == nil || ctx == nil {
		return ErrConnectorUnavailable
	}
	s.beginClose()
	select {
	case <-s.closeDone:
		return s.closeErr
	case <-ctx.Done():
		return errors.Join(ErrConnectorUnavailable, ctx.Err())
	}
}
