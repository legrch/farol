package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

func TestInvalidAndCancelledWritesHaveNoMetadataEffect(t *testing.T) {
	for _, kind := range []string{"binding", "phase", "token", "oversized", "cancelled", "guard-cancelled", "guard-refused", "before-create"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			before := mustRead(t, r)
			next := f.value("prepared")
			token := before.Revision
			ctx := context.Background()
			switch kind {
			case "binding":
				next.Operation.Target.Version = "crossed"
			case "phase":
				next.Phase = "invented"
			case "token":
				token = "invalid"
			case "oversized":
				next.Phase = strings.Repeat("a", records.MaxHelperRecordBytes)
			case "cancelled":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
			case "guard-cancelled":
				c, cancel := context.WithCancel(ctx)
				ctx = c
				f.admission.verify = func(context.Context) error { cancel(); return nil }
			case "guard-refused":
				f.admission.verify = func(context.Context) error { return errors.New("private authority failure") }
			case "before-create":
				r.step = func(at string) error {
					if at == "create-before" {
						return errors.New("pre-effect fixture")
					}
					return nil
				}
			}
			value, err := r.CompareAndSwap(ctx, token, next)
			if value != nil || err == nil {
				t.Fatalf("invalid %s admitted", kind)
			}
			if strings.Contains(err.Error(), "private") {
				t.Fatal("guard detail exposed")
			}
			if mustRead(t, r).Value != nil {
				t.Fatal("pre-effect refusal persisted journal")
			}
			noTemporary(t, f)
			if f.admission.unknown != (kind == "guard-refused") {
				t.Fatal("pre-effect certainty wrong")
			}
			if kind == "guard-refused" {
				calls := f.admission.verified
				_, err := r.CompareAndSwap(context.Background(), token, f.value("prepared"))
				requireError(t, err, port.JournalUnknown)
				if f.admission.verified != calls {
					t.Fatal("refused guard repeated")
				}
			}
		})
	}
}
func TestPersistenceCrashWindowsRetainUnknown(t *testing.T) {
	for _, point := range []string{"create-after", "write-after", "file-sync-before", "file-sync-after", "file-close-after", "publish-before", "rename-after", "parent-sync-before", "parent-sync-after", "ack-before"} {
		t.Run(point, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			before := mustRead(t, r)
			r.step = func(at string) error {
				if at == point {
					return errors.New("boundary uncertainty")
				}
				return nil
			}
			value, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("launch_requested"))
			if value != nil {
				t.Fatal("crash returned success")
			}
			requireError(t, err, port.JournalUnknown)
			r.step = nil
			after := mustRead(t, r)
			published := point == "rename-after" || point == "parent-sync-before" || point == "parent-sync-after" || point == "ack-before"
			if (after.Value != nil) != published {
				t.Fatalf("publication differs at %s", point)
			}
			calls := f.admission.verified
			_, err = r.CompareAndSwap(context.Background(), after.Revision, f.value("prepared"))
			requireError(t, err, port.JournalUnknown)
			if f.admission.verified != calls || !f.admission.unknown {
				t.Fatal("unknown replayed guard or publication")
			}
		})
	}
}
func TestPartialWriteAndNativeDescriptorSyncFailure(t *testing.T) {
	for _, kind := range []string{"partial-enospc", "closed-before-sync", "short-writes"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			before := mustRead(t, r)
			r.writeChunk = func(fd *os.File, data []byte) (int, error) {
				if kind == "partial-enospc" {
					n, err := fd.Write(data[:7])
					if err != nil {
						return n, err
					}
					return n, syscall.ENOSPC
				}
				if kind == "closed-before-sync" {
					n, err := fd.Write(data)
					fd.Close()
					return n, err
				}
				if len(data) > 11 {
					data = data[:11]
				}
				return fd.Write(data)
			}
			value, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("prepared"))
			if kind == "short-writes" {
				if err != nil || value == nil {
					t.Fatal(err)
				}
				noTemporary(t, f)
				return
			}
			if value != nil {
				t.Fatal("partial persistence accepted")
			}
			requireError(t, err, port.JournalUnknown)
			if mustRead(t, r).Value != nil || !f.admission.unknown {
				t.Fatal("temporary became accepted journal")
			}
			entries, err := os.ReadDir(f.path)
			if err != nil || len(entries) != 1 {
				t.Fatal("temporary evidence not retained")
			}
			if kind == "partial-enospc" {
				data, err := os.ReadFile(filepath.Join(f.path, entries[0].Name()))
				if err != nil || len(data) != 7 {
					t.Fatal("partial native bytes missing")
				}
			}
			// ENOSPC is injected; the partial bytes/descriptor sync failure are native.
		})
	}
}
func TestCASRacesAndPublicationIdentity(t *testing.T) {
	for _, kind := range []string{"before-create", "after-create", "same-bytes-new-inode", "in-place-same-bytes", "temporary-replaced", "temporary-hardlink", "post-rename-replaced", "no-replace-collision", "second-guard-refused"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			if kind != "after-create" && kind != "no-replace-collision" {
				f.put(t, "prepared")
			}
			before := mustRead(t, r)
			name := filepath.Join(f.path, filename)
			switch kind {
			case "before-create":
				f.put(t, "verified")
			case "same-bytes-new-inode":
				if err := os.Rename(name, name+".old"); err != nil {
					t.Fatal(err)
				}
				f.put(t, "prepared")
			case "in-place-same-bytes":
				info, err := os.Stat(name)
				if err != nil {
					t.Fatal(err)
				}
				f.put(t, "prepared")
				if err := os.Chtimes(name, info.ModTime(), info.ModTime()); err != nil {
					t.Fatal(err)
				}
			case "after-create":
				r.step = func(at string) error {
					if at == "publish-before" {
						f.put(t, "verified")
					}
					return nil
				}
			case "temporary-replaced", "temporary-hardlink":
				r.step = func(at string) error {
					if at != "file-close-after" {
						return nil
					}
					entries, err := os.ReadDir(f.path)
					if err != nil {
						t.Fatal(err)
					}
					for _, entry := range entries {
						if strings.HasPrefix(entry.Name(), ".journal-") {
							path := filepath.Join(f.path, entry.Name())
							if kind == "temporary-replaced" {
								if err := os.Rename(path, path+"-old"); err != nil {
									t.Fatal(err)
								}
								if err := os.WriteFile(path, f.encoded(t, "verified"), 0o600); err != nil {
									t.Fatal(err)
								}
							} else if err := os.Link(path, path+"-alias"); err != nil {
								t.Fatal(err)
							}
						}
					}
					return nil
				}
			case "post-rename-replaced":
				r.step = func(at string) error {
					if at == "rename-after" {
						if err := os.Rename(name, name+".old"); err != nil {
							t.Fatal(err)
						}
						f.put(t, "verified")
					}
					return nil
				}
			case "no-replace-collision":
				r.publish = func(parent *os.File, temp string, absent bool) error {
					if !absent {
						t.Fatal("no-replace not selected")
					}
					f.put(t, "verified")
					return rename(parent, temp, true)
				}
			case "second-guard-refused":
				f.admission.verify = func(context.Context) error {
					if f.admission.verified >= 3 {
						return errors.New("guard lost")
					}
					return nil
				}
			}
			value, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("launch_requested"))
			if value != nil {
				t.Fatal("changed CAS acknowledged")
			}
			pre := kind == "before-create" || kind == "same-bytes-new-inode" || kind == "in-place-same-bytes"
			if pre {
				requireError(t, err, port.JournalConflict)
				noTemporary(t, f)
			} else {
				requireError(t, err, port.JournalUnknown)
			}
			r.step = nil
			after := mustRead(t, r)
			if kind == "no-replace-collision" || kind == "after-create" || kind == "post-rename-replaced" {
				if after.Value == nil || after.Value.Phase != "verified" {
					t.Fatal("foreign record overwritten")
				}
			} else if after.Value != nil && after.Value.Phase == "launch_requested" {
				t.Fatal("unverified temporary promoted")
			}
			if f.admission.unknown == pre {
				t.Fatal("CAS certainty wrong")
			}
		})
	}
}
func TestCancellationAfterCreateDrainsButLosesACK(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	before := mustRead(t, r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.step = func(at string) error {
		if at == "create-after" {
			cancel()
		}
		return nil
	}
	view, err := r.CompareAndSwap(ctx, before.Revision, f.value("launch_requested"))
	if view != nil {
		t.Fatal("cancelled ACK accepted")
	}
	requireError(t, err, port.JournalUnknown)
	after := mustRead(t, r)
	if after.Value == nil || after.Value.Phase != "launch_requested" || !f.admission.unknown {
		t.Fatal("native drain or retention lost")
	}
	noTemporary(t, f)
}
func TestDirectorySwapBeforeAndAfterPossibleCreation(t *testing.T) {
	for _, point := range []string{"create-before", "create-after"} {
		t.Run(point, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			before := mustRead(t, r)
			moved := f.path + "-old"
			r.step = func(at string) error {
				if at == point {
					if err := os.Rename(f.path, moved); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(f.path, 0o700); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			}
			view, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("prepared"))
			if view != nil {
				t.Fatal("replaced root acknowledged")
			}
			if point == "create-before" {
				requireError(t, err, port.JournalChanged)
			} else {
				requireError(t, err, port.JournalUnknown)
			}
			entries, err := os.ReadDir(f.path)
			if err != nil || len(entries) != 0 {
				t.Fatal("replacement root mutated")
			}
			if _, err := os.Lstat(filepath.Join(moved, filename)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("detached directory got published record")
			}
		})
	}
}
func TestNativePermissionFailureCannotRearm(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission refusal")
	}
	f := newFixture(t)
	if err := os.Chmod(f.path, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(f.path, 0o700) })
	r := f.open(t)
	before := mustRead(t, r)
	view, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("prepared"))
	if view != nil {
		t.Fatal("permission failure accepted")
	}
	requireError(t, err, port.JournalUnknown)
	if mustRead(t, r).Value != nil || !f.admission.unknown {
		t.Fatal("permission failure invented replay grant")
	}
}
func TestAbsenceRevisionBindsFullOperation(t *testing.T) {
	f := newFixture(t)
	first := f.open(t)
	before := mustRead(t, first)
	changed := f.operation
	changed.Target.Version = "other fixture"
	// Independent symbolic binding only, not a real grant to change a retained ID.
	other := &admissionFixture{gate: f.gate, operation: changed, directory: f.admission.directory}
	second, err := New(context.Background(), f.path, changed, other)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	current := mustRead(t, second)
	if before.Revision == current.Revision {
		t.Fatal("absence lost full operation binding")
	}
	value, err := second.CompareAndSwap(context.Background(), before.Revision, release.Journal{Operation: changed, Phase: "prepared"})
	if value != nil {
		t.Fatal("crossed witness accepted")
	}
	requireError(t, err, port.JournalConflict)
}
