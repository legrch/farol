//go:build darwin

package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"syscall"
)

type systemProbe struct{}

func (systemProbe) CurrentProcess() int { return os.Getpid() } // self only; never a lookup/probe of another process
func (systemProbe) Allowed(ctx context.Context, path, expected string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return errors.New("qualification baseline unavailable")
	}
	data := make([]byte, info.Size())
	if _, err := file.ReadAt(data, 0); err != nil && len(data) != 0 {
		return err
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != expected {
		return errors.New("qualification baseline mismatch")
	}
	return nil
}
func permissionDenied(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES)
}
func (systemProbe) DeniedRead(ctx context.Context, path string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if file != nil {
		file.Close()
	}
	if !permissionDenied(err) {
		return errors.New("native read confinement unqualified")
	}
	return nil
}
func (systemProbe) DeniedWrite(ctx context.Context, path string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Existing synthetic file only; no create, truncate or actual data write.
	file, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if file != nil {
		file.Close()
	}
	if !permissionDenied(err) {
		return errors.New("native write confinement unqualified")
	}
	return nil
}
func (systemProbe) DeniedConnect(ctx context.Context, address string) error {
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if connection != nil {
		connection.Close()
	} // No bytes, credentials or payload sent.
	if !permissionDenied(err) {
		return errors.New("native egress confinement unqualified")
	}
	return nil
}
