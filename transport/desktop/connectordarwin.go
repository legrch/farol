//go:build darwin

package desktop

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	acceptDone           chan struct{}
	workers              sync.WaitGroup
	closeOnce            sync.Once
	closeDone            chan struct{}
	closeErr             error
}

// StartConnector creates a fresh private socket for the exact existing backend and owner.
// A startup failure preserves any partially created path, with no replacement
// listener, stale-path unlink, fallback port or retry.
func StartConnector(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]Method) (*ConnectorListener, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, ErrConnectorUnavailable
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, ErrConnectorUnavailable
	}
	endpoint := wire.ComputerConnectorEndpoint{Binding: binding, SocketPath: "/private/tmp/pending.sock", Token: hex.EncodeToString(secret[:])}
	selected := make(map[string]Method, len(methods))
	for name, method := range methods {
		selected[name] = method
	}
	config := ConnectorConfig{Endpoint: endpoint, Methods: selected}
	if validateConnectorConfig(config) != nil {
		return nil, ErrConnectorUnavailable
	}
	root, err := os.MkdirTemp("/private/tmp", "farol-mcp-")
	if err != nil {
		return nil, ErrConnectorUnavailable
	}
	info, err := os.Lstat(root)
	if err != nil || !safeConnectorRoot(root, info) {
		return nil, ErrConnectorUnavailable
	}
	endpoint.SocketPath = filepath.Join(root, "computer.sock")
	config.Endpoint = endpoint
	if validateConnectorConfig(config) != nil {
		return nil, ErrConnectorUnavailable
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint.SocketPath, Net: "unix"})
	if err != nil {
		return nil, ErrConnectorUnavailable
	}
	listener.SetUnlinkOnClose(false)
	// The private 0700 directory controls endpoint access. Preserve the socket's
	// creation mode instead of chmod by pathname (which could follow a replacement).
	socketInfo, err := os.Lstat(endpoint.SocketPath)
	if err != nil || !safeConnectorSocket(socketInfo) {
		_ = listener.Close()
		return nil, ErrConnectorUnavailable
	}
	selectedCtx, cancel := context.WithCancel(ctx)
	owned := &ConnectorListener{endpoint: endpoint, config: config, root: root, rootInfo: info, socketInfo: socketInfo, listener: listener, ctx: selectedCtx, cancel: cancel, connections: make(map[*net.UnixConn]bool), acceptDone: make(chan struct{}), closeDone: make(chan struct{})}
	go owned.accept()
	go func() { <-selectedCtx.Done(); owned.beginClose() }()
	return owned, nil
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
