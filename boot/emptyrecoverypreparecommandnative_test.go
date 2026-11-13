//go:build darwin

package boot

import (
	"bufio"
	"bytes"
	"encoding/json"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
)

// Synchronous pipe-shaped host fixture: production command, actual native
// stores, separate ACK after publication. No real process/host qualification.
type emptyRecoveryCommandPeer struct {
	input        *bytes.Reader
	ack          *bytes.Reader
	out          bytes.Buffer
	wrong        bool
	publications int
}

func (p *emptyRecoveryCommandPeer) SetReadDeadline(time.Time) error  { return nil }
func (p *emptyRecoveryCommandPeer) SetWriteDeadline(time.Time) error { return nil }

func (p *emptyRecoveryCommandPeer) Read(b []byte) (int, error) {
	if p.input.Len() > 0 {
		return p.input.Read(b)
	}
	if p.ack == nil {
		return 0, io.EOF
	}
	return p.ack.Read(b)
}

func TestNativeEmptyRecoveryPreparationDeadlineUnwindsOwnedPipes(t *testing.T) {
	for _, blocked := range []string{"ack", "publication"} {
		t.Run(blocked, func(t *testing.T) {
			in := emptyRecoveryFixture(t)
			profile := in.Profile
			in.Profile = ProfileBinding{}
			raw, err := json.Marshal(in)
			if err != nil {
				t.Fatal(err)
			}
			input, hostInput, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			defer hostInput.Close()
			hostOutput, output, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer hostOutput.Close()
			defer output.Close()
			if blocked == "publication" {
				// File.Fd switches a pollable pipe to blocking mode. Control keeps
				// the SAME owned descriptor registered for real deadline cancellation.
				raw, err := output.SyscallConn()
				if err != nil {
					t.Fatal(err)
				}
				full := false
				var fillErr error
				if err := raw.Control(func(fd uintptr) {
					if fillErr = unix.SetNonblock(int(fd), true); fillErr != nil {
						return
					}
					for n := 0; n < 1024; n++ {
						_, fillErr = unix.Write(int(fd), bytes.Repeat([]byte("x"), 4096))
						if fillErr == unix.EAGAIN {
							full = true
							fillErr = nil
							return
						}
						if fillErr != nil {
							return
						}
					}
				}); err != nil {
					t.Fatal(err)
				}
				if fillErr != nil {
					t.Fatal(fillErr)
				}
				if !full {
					t.Fatal("output pipe did not reach backpressure")
				}
			}
			args := []string{"--profile", profile.ProfileID, "--profile-root", profile.Root, "--profile-device", strconv.FormatUint(profile.Device, 10), "--profile-inode", strconv.FormatUint(profile.Inode, 10), "--expected-build", BuildID}
			result := make(chan int, 1)
			started := time.Now()
			joined := false
			defer func() {
				input.Close()
				output.Close()
				if !joined {
					select {
					case <-result:
					case <-time.After(3 * time.Second):
						t.Error("original command lifetime unconfirmed")
					}
				}
			}()
			var diagnostics bytes.Buffer
			go func() {
				result <- runEmptyRecoveryPreparationDeadline(args, input, output, &diagnostics, time.Now().Add(500*time.Millisecond))
			}()
			if _, err := hostInput.Write(append(raw, '\n')); err != nil {
				t.Fatal(err)
			}
			if blocked == "ack" {
				if err := hostOutput.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
					t.Fatal(err)
				}
				if _, err := bufio.NewReader(hostOutput).ReadString('\n'); err != nil {
					t.Fatal("publication unavailable", err)
				}
				// Keep input OPEN and provide no complete ACK line.
				if _, err := hostInput.Write([]byte("{")); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case code := <-result:
				joined = true
				if time.Since(started) < 400*time.Millisecond {
					t.Fatal("blocked IO returned before actual deadline")
				}
				if code != 1 {
					t.Fatal("blocked pipe not refused", code, diagnostics.String())
				}
			case <-time.After(3 * time.Second):
				input.Close()
				output.Close()
				t.Fatal("command retained blocked IO")
			}
			if err := refusePendingEmptyRecovery(profile); err == nil {
				t.Fatal("deadline cleared pending")
			}
			archive := filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID)
			for _, name := range []string{"chat-handoff.claim", "chat-lifecycle.claim", "chat-results/chat-results.claim"} {
				fd, err := unix.Open(filepath.Join(archive, name), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
				if err != nil {
					t.Fatal(err)
				}
				lockErr := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
				closeErr := unix.Close(fd)
				if lockErr != nil || closeErr != nil {
					t.Fatal("original claim not released", name, lockErr, closeErr)
				}
			}
		})
	}
}
func (p *emptyRecoveryCommandPeer) Write(b []byte) (int, error) {
	var line struct {
		Publication chatport.HandoffPublication `json:"publication"`
	}
	if json.Unmarshal(b, &line) != nil {
		return 0, io.ErrUnexpectedEOF
	}
	if line.Publication.HandoffID != "" {
		p.publications++
		if p.wrong {
			line.Publication.ReceiptDigest[0]++
		}
		raw, _ := json.Marshal(struct{ Publication chatport.HandoffPublication }{line.Publication})
		p.ack = bytes.NewReader(append(raw, '\n'))
	}
	return p.out.Write(b)
}
func TestNativeEmptyRecoveryPreparationCommandRequiresSeparateExactACK(t *testing.T) {
	for _, wrong := range []bool{false, true} {
		name := "exact"
		if wrong {
			name = "crossed"
		}
		t.Run(name, func(t *testing.T) {
			in := emptyRecoveryFixture(t)
			profile := in.Profile
			in.Profile = ProfileBinding{}
			raw, err := json.Marshal(in)
			if err != nil {
				t.Fatal(err)
			}
			peer := &emptyRecoveryCommandPeer{input: bytes.NewReader(append(raw, '\n')), wrong: wrong}
			args := []string{"--profile", profile.ProfileID, "--profile-root", profile.Root, "--profile-device", strconv.FormatUint(profile.Device, 10), "--profile-inode", strconv.FormatUint(profile.Inode, 10), "--expected-build", BuildID}
			var diagnostics bytes.Buffer
			code := runEmptyRecoveryPreparation(args, peer, peer, &diagnostics)
			if peer.publications != 1 || (!wrong && code != 0) || (wrong && code != 1) {
				t.Fatal(code, peer.publications, diagnostics.String())
			}
			if err := refusePendingEmptyRecovery(profile); err == nil {
				t.Fatal("private child result settled host/process fence")
			}
		})
	}
}
