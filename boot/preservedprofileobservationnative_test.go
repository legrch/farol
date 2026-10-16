//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// Actual canonical native repositories and immutable physical/byte observations.
// Command streams here are controlled deadline doubles; no child, host lease,
// attestation, terminal recorder or writable Electron recovery is qualified.
type preservedObservationTree struct {
	versions map[string]unix.Stat_t
	bytes    map[string]string
}

func snapshotPreservedObservationTree(t *testing.T, root string) preservedObservationTree {
	t.Helper()
	v := preservedObservationTree{versions: map[string]unix.Stat_t{}, bytes: map[string]string{}}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		var st unix.Stat_t
		if err := unix.Lstat(path, &st); err != nil {
			return err
		}
		v.versions[path] = st
		if entry.Type().IsRegular() {
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(raw)
			v.bytes[path] = hex.EncodeToString(digest[:])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func unchangedPreservedObservationTree(t *testing.T, root string, before preservedObservationTree) {
	t.Helper()
	after := snapshotPreservedObservationTree(t, root)
	if !reflect.DeepEqual(before.bytes, after.bytes) || len(before.versions) != len(after.versions) {
		t.Fatal("observation changed profile bytes or namespace")
	}
	for path, version := range before.versions {
		if !sameEmptyRecoveryStat(version, after.versions[path]) {
			t.Fatal("observation changed physical custody", filepath.Base(path))
		}
	}
}

func TestPreservedProfileObservationNativeCanonicalMetadataWithoutAuthority(t *testing.T) {
	for _, withFile := range []bool{false, true} {
		in, workspace := preservedProfileFixture(t, true, withFile)
		before := snapshotPreservedObservationTree(t, in.Profile.Root)
		workBefore := snapshotPreservedObservationTree(t, workspace)
		request := in
		request.Selection.HandoffDigest, request.Selection.LifecycleDigest, request.Selection.ResultsDigest = [32]byte{}, [32]byte{}, [32]byte{}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		calls := 0
		if err := observePreservedProfile(ctx, request, func(v preservedProfileInspection) error {
			calls++
			if v.Plan.Selection != in.Selection || !v.Plan.RetainsUnresolvedResults {
				t.Fatal("canonical observation changed selection or lost UNKNOWN")
			}
			return nil
		}); err != nil || calls != 1 {
			t.Fatal("canonical observation unavailable", err, calls)
		}
		// Discovery is not a preparation flag: zero digests cannot be admitted by
		// the original preparation path even after discovery has succeeded.
		ackCalled := false
		if _, err := preparePreservedProfileRecovery(ctx, request, func(chatport.HandoffPublication) error { ackCalled = true; return nil }); err == nil || ackCalled {
			t.Fatal("zero-digest preparation admitted")
		}
		unchangedPreservedObservationTree(t, in.Profile.Root, before)
		unchangedPreservedObservationTree(t, workspace, workBefore)
	}
}

func TestPreservedProfileObservationNativeCommandPublishesOnlyCompletedMetadata(t *testing.T) {
	for _, fault := range []string{"exact", "selected-digest", "changed-access", "changed-record", "short-output", "late-output"} {
		t.Run(fault, func(t *testing.T) {
			in, _ := preservedProfileFixture(t, true)
			before := snapshotPreservedObservationTree(t, in.Profile.Root)
			selected := in
			selected.Profile = ProfileBinding{}
			selected.Selection.HandoffDigest, selected.Selection.LifecycleDigest, selected.Selection.ResultsDigest = [32]byte{}, [32]byte{}, [32]byte{}
			switch fault {
			case "selected-digest":
				selected.Selection.ResultsDigest = in.Selection.ResultsDigest
			case "changed-access":
				selected.AccessDigest[0] ^= 1
			case "changed-record":
				selected.Mutations = append(selected.Mutations[:0:0], in.Mutations...)
				selected.Mutations[0].SHA256 = strings.Repeat("0", 64)
			}
			raw, err := json.Marshal(selected)
			if err != nil {
				t.Fatal(err)
			}
			r := &preservedCommandInput{Reader: bytes.NewReader(append(raw, '\n'))}
			var w preservedCommandOutput
			var diagnostic bytes.Buffer
			until := time.Now().Add(3 * time.Second)
			var out interface {
				Write([]byte) (int, error)
				SetWriteDeadline(time.Time) error
			} = &w
			if fault == "short-output" || fault == "late-output" {
				out = &preservedObservationOutput{short: fault == "short-output", late: fault == "late-output"}
			}
			code := runPreservedProfileObservationDeadline(preservedCommandNativeArgs(in.Profile), r, out, &diagnostic, until)
			if fault == "exact" {
				var reply preservedProfileObservationReply
				if code != 0 || json.Unmarshal(w.Bytes(), &reply) != nil || reply.Schema != "farol-preserved-profile-inspection/1" || reply.BuildID != BuildID || reply.RecoveryAuthorized || reply.Selection != in.Selection || diagnostic.Len() != 0 {
					t.Fatal("invalid canonical reply", code)
				}
			} else if code != 1 || w.Len() != 0 || diagnostic.String() != "PRESERVED_PROFILE_OBSERVATION_UNCONFIRMED\n" {
				t.Fatal("failed observation became confirmed", code)
			}
			unchangedPreservedObservationTree(t, in.Profile.Root, before)
		})
	}
}

type preservedObservationOutput struct {
	until       time.Time
	short, late bool
}

func (w *preservedObservationOutput) SetWriteDeadline(until time.Time) error {
	w.until = until
	return nil
}
func (w *preservedObservationOutput) Write(raw []byte) (int, error) {
	if w.late {
		time.Sleep(time.Until(w.until) + time.Millisecond)
	}
	if w.short {
		return len(raw) - 1, nil
	}
	return len(raw), nil
}

func TestPreservedProfileObservationNativeRejectsVisitorChangeAndCancellation(t *testing.T) {
	for _, fault := range []string{"namespace", "cancel", "selected"} {
		in, _ := preservedProfileFixture(t, true)
		in.Selection.HandoffDigest, in.Selection.LifecycleDigest, in.Selection.ResultsDigest = [32]byte{}, [32]byte{}, [32]byte{}
		if fault == "selected" {
			in.Selection.LifecycleDigest[0] = 1
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		calls := 0
		err := observePreservedProfile(ctx, in, func(v preservedProfileInspection) error {
			calls++
			if fault == "cancel" {
				cancel()
				return nil
			}
			return os.WriteFile(filepath.Join(v.Chat.Path, "unclassified-observation"), []byte("fixture intrusion"), 0600)
		})
		if err == nil || fault == "selected" && calls != 0 {
			t.Fatal("observation accepted changed/expired or preselected metadata", fault, err)
		}
	}
}

func TestPreservedProfileObservationNativeOriginalPipeDeadlines(t *testing.T) {
	for _, fault := range []string{"exact", "blocked-input", "blocked-output"} {
		t.Run(fault, func(t *testing.T) {
			in, _ := preservedProfileFixture(t, true)
			before := snapshotPreservedObservationTree(t, in.Profile.Root)
			request := in
			request.Profile = ProfileBinding{}
			request.Selection.HandoffDigest, request.Selection.LifecycleDigest, request.Selection.ResultsDigest = [32]byte{}, [32]byte{}, [32]byte{}
			raw, err := json.Marshal(request)
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
			if fault == "blocked-output" {
				conn, err := output.SyscallConn()
				if err != nil {
					t.Fatal(err)
				}
				full := false
				var fillErr error
				err = conn.Control(func(fd uintptr) {
					if fillErr = unix.SetNonblock(int(fd), true); fillErr != nil {
						return
					}
					for n := 0; n < 1024; n++ {
						_, fillErr = unix.Write(int(fd), bytes.Repeat([]byte("x"), 4096))
						if fillErr == unix.EAGAIN {
							full, fillErr = true, nil
							return
						}
						if fillErr != nil {
							return
						}
					}
				})
				if err != nil || fillErr != nil || !full {
					t.Fatal("pipe backpressure unavailable", err, fillErr)
				}
			}
			if err := hostInput.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			if fault != "blocked-input" {
				if n, err := hostInput.Write(append(raw, '\n')); err != nil || n != len(raw)+1 {
					t.Fatal("original input write", err)
				}
			}
			var diagnostic bytes.Buffer
			started := time.Now()
			code := runPreservedProfileObservationDeadline(preservedCommandNativeArgs(in.Profile), input, output, &diagnostic, started.Add(700*time.Millisecond))
			if fault == "exact" {
				if code != 0 || output.Close() != nil {
					t.Fatal("actual pipe observation unavailable", code)
				}
				raw, err := io.ReadAll(hostOutput)
				var reply preservedProfileObservationReply
				if err != nil || json.Unmarshal(raw, &reply) != nil || reply.Selection != in.Selection || reply.RecoveryAuthorized {
					t.Fatal("crossed actual pipe metadata", err)
				}
			} else if code != 1 || time.Since(started) < 650*time.Millisecond || time.Since(started) > 3*time.Second || diagnostic.String() != "PRESERVED_PROFILE_OBSERVATION_UNCONFIRMED\n" {
				t.Fatal("original pipe deadline lost", fault, code)
			}
			unchangedPreservedObservationTree(t, in.Profile.Root, before)
			t.Logf("original command returned code=%d; actual %s pipes; profile bytes/physical metadata unchanged", code, fault)
		})
	}
}
