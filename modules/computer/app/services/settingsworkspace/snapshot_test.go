package settingsworkspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure fixtures only: no filesystem, journal, participant or native-host proof.
type snapshotNative struct {
	calls     int
	inCurrent *bool
	read      func(context.Context, port.ReadRequest) (*port.ReadResponse, error)
}

func (n *snapshotNative) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	if *n.inCurrent {
		panic("native IO inside current authority callback")
	}
	n.calls++
	return n.read(ctx, r)
}
func (*snapshotNative) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	panic("snapshot must only read")
}

type snapshotFixture struct {
	*fixture
	reader    *snapshotNative
	inCurrent bool
}

func newSnapshotFixture() *snapshotFixture {
	f := &snapshotFixture{fixture: newFixture()}
	f.approval.Capabilities = []authority.Capability{authority.Read}
	f.reader = &snapshotNative{inCurrent: &f.inCurrent, read: func(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
		return snapshotOutput("hello", false), nil
	}}
	f.service.native = f.reader
	current := f.service.current
	f.service.current = currentFunc(func(ctx context.Context, cb func(*authority.Approval) error) error {
		return current.WithCurrent(ctx, func(a *authority.Approval) error {
			f.inCurrent = true
			defer func() { f.inCurrent = false }()
			return cb(a)
		})
	})
	return f
}
func snapshotRequest() Request {
	return Request{WorkspaceID: "work", RelativePath: "selected/file.txt"}
}
func snapshotOutput(text string, bom bool) *port.ReadResponse {
	raw := text
	if bom {
		raw = "\ufeff" + raw
	}
	digest := sha256.Sum256([]byte(raw))
	return &port.ReadResponse{Text: text, Bytes: uint64(len(raw)), SHA256: hex.EncodeToString(digest[:])}
}
func snapshotFailure(t *testing.T, out *SnapshotResult, err error, code string) {
	t.Helper()
	var f *authority.Failure
	if out != nil || !errors.As(err, &f) || f == nil || f.Code != code || f.Retry != "never" {
		t.Fatalf("result=%+v error=%v, want %s", out, err, code)
	}
}
func TestSnapshotFullReadMetadata(t *testing.T) {
	for _, text := range []string{"", "é😀\n", "nested \ufeffBOM", strings.Repeat("a", 256*1024-3), strings.Repeat("a", 256*1024)} {
		for _, bom := range []bool{false, true} {
			if len(text) == 256*1024 && bom {
				continue
			}
			t.Run(fmt.Sprintf("%d/bom=%v", len(text), bom), func(t *testing.T) {
				f := newSnapshotFixture()
				f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/selected/secret"}}
				before := f.approval.Clone()
				nativeOut := snapshotOutput(text, bom)
				wantBytes, wantHash := nativeOut.Bytes, nativeOut.SHA256
				f.reader.read = func(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
					if ctx != context.Background() || r.Range != nil || r.RelativePath != snapshotRequest().RelativePath || r.Workspace.WorkspaceID != "work" || r.Workspace.Root != "/work" || r.Workspace.ApprovedRoot != (port.Root{Path: "/work", Device: "12", Inode: "34"}) || r.Workspace.ExactFilePaths != nil || !reflect.DeepEqual(r.Workspace.DeniedPaths, []string{"selected/secret"}) {
						t.Fatalf("wrong full read: %+v", r)
					}
					r.Workspace.DeniedPaths[0] = "native mutation"
					return nativeOut, nil
				}
				f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
					if call == 2 {
						nativeOut.Bytes = 123
						nativeOut.SHA256 = "mutated"
						nativeOut.Text = "private"
					}
					return err
				}
				out, err := f.service.Snapshot(context.Background(), snapshotRequest())
				if err != nil || out == nil || out.WorkspaceID != "work" || out.RelativePath != snapshotRequest().RelativePath || out.Root != (port.Root{Path: "/work", Device: "12", Inode: "34"}) || out.Bytes != wantBytes || out.SHA256 != wantHash {
					t.Fatalf("%+v %v", out, err)
				}
				if f.reader.calls != 1 || f.currentCalls != 2 || !reflect.DeepEqual(f.approval, before) {
					t.Fatal("unexpected calls or authority side effects")
				}
				if bom && text == "" && wantHash == snapshotOutput("", false).SHA256 {
					t.Fatal("BOM lost from raw-byte hash")
				}
			})
		}
	}
}

func TestSnapshotPreservesNativeDigest(t *testing.T) {
	f := newSnapshotFixture()
	output := snapshotOutput("decoded text", false)
	// An opaque digest fixture proves delegation, not physical hash validity.
	output.SHA256 = strings.Repeat("ab", 32)
	f.reader.read = func(context.Context, port.ReadRequest) (*port.ReadResponse, error) { return output, nil }
	out, err := f.service.Snapshot(context.Background(), snapshotRequest())
	if err != nil || out == nil || out.SHA256 != output.SHA256 {
		t.Fatalf("native digest replaced: %+v %v", out, err)
	}
}

func TestSnapshotAdmissionRefusals(t *testing.T) {
	cases := []struct {
		name, code string
		change     func(*snapshotFixture)
		req        Request
	}{
		{"list only", "AUTHORITY_CAPABILITY_DENIED", func(f *snapshotFixture) { f.approval.Capabilities = []authority.Capability{authority.List} }, snapshotRequest()},
		{"no caps", "AUTHORITY_CAPABILITY_DENIED", func(f *snapshotFixture) { f.approval.Capabilities = nil }, snapshotRequest()},
		{"expired", "AUTHORITY_EXPIRED", func(f *snapshotFixture) { f.approval.ExpiresAt = f.clock.now }, snapshotRequest()},
		{"invalid owner", "COMPUTER_APPROVAL_INVALID", func(f *snapshotFixture) { f.approval.OwnerID = "" }, snapshotRequest()},
		{"invalid root binding", "COMPUTER_APPROVAL_INVALID", func(f *snapshotFixture) { f.approval.Workspaces[0].RootIdentity.Inode = "" }, snapshotRequest()},
		{"excluded alias", "AUTHORITY_PATH_DENIED", func(f *snapshotFixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/Selected"}}
		}, snapshotRequest()},
		{"root excluded", "AUTHORITY_PATH_DENIED", func(f *snapshotFixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work"}}
		}, snapshotRequest()},
		{"unknown workspace", "AUTHORITY_PATH_DENIED", nil, Request{WorkspaceID: "other", RelativePath: "file.txt"}},
		{"directory root", "COMPUTER_INVALID_REQUEST", nil, request()},
		{"empty", "COMPUTER_INVALID_REQUEST", nil, Request{WorkspaceID: "work"}},
		{"absolute", "COMPUTER_INVALID_REQUEST", nil, Request{WorkspaceID: "work", RelativePath: "/work/file"}},
		{"traversal", "COMPUTER_INVALID_REQUEST", nil, Request{WorkspaceID: "work", RelativePath: "../secret"}},
		{"invalid utf8", "COMPUTER_INVALID_REQUEST", nil, Request{WorkspaceID: "work", RelativePath: "\xff"}},
		{"long component", "COMPUTER_INVALID_REQUEST", nil, Request{WorkspaceID: "work", RelativePath: strings.Repeat("x", 256)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSnapshotFixture()
			if tc.change != nil {
				tc.change(f)
			}
			out, err := f.service.Snapshot(context.Background(), tc.req)
			snapshotFailure(t, out, err, tc.code)
			if f.reader.calls != 0 {
				t.Fatal("read after refusal")
			}
		})
	}
}
func TestSnapshotFinalPolicyChanges(t *testing.T) {
	changes := []struct {
		name   string
		change func(*snapshotFixture)
	}{
		{"owner", func(f *snapshotFixture) { f.approval.OwnerID = "other" }},
		{"computer", func(f *snapshotFixture) { f.approval.ComputerID = "other" }},
		{"generation", func(f *snapshotFixture) { f.approval.Generation++ }},
		{"root", func(f *snapshotFixture) { f.approval.Workspaces[0].Root = "/other" }},
		{"device", func(f *snapshotFixture) { f.approval.Workspaces[0].RootIdentity.Device = "13" }},
		{"inode", func(f *snapshotFixture) { f.approval.Workspaces[0].RootIdentity.Inode = "35" }},
		{"access", func(f *snapshotFixture) { f.approval.Workspaces[0].Access = authority.WriteAccess }},
		{"read withdrawn", func(f *snapshotFixture) { f.approval.Capabilities = []authority.Capability{authority.List} }},
		{"exclusions", func(f *snapshotFixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/selected"}}
		}},
		{"git metadata", func(f *snapshotFixture) { f.approval.Workspaces[0].GitMetadata.CommonDirectory = "/other" }},
		{"network", func(f *snapshotFixture) { f.approval.Network = authority.ApprovedNetwork }},
		{"commands", func(f *snapshotFixture) { f.approval.Commands = authority.WorkspaceCommands }},
	}
	for _, tc := range changes {
		t.Run(tc.name, func(t *testing.T) {
			f := newSnapshotFixture()
			read := f.reader.read
			f.reader.read = func(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
				out, err := read(ctx, r)
				tc.change(f)
				return out, err
			}
			out, err := f.service.Snapshot(context.Background(), snapshotRequest())
			snapshotFailure(t, out, err, "AUTHORITY_COMPUTER_MISMATCH")
			if f.reader.calls != 1 || f.currentCalls != 2 {
				t.Fatal("wrong calls")
			}
		})
	}
	for _, phase := range []int{1, 2} {
		t.Run(fmt.Sprintf("withdrawal/%d", phase), func(t *testing.T) {
			f := newSnapshotFixture()
			calls := 0
			f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
				calls++
				if calls == phase {
					return cb(nil)
				}
				a := f.approval.Clone()
				return cb(&a)
			})
			out, err := f.service.Snapshot(context.Background(), snapshotRequest())
			snapshotFailure(t, out, err, "COMPUTER_APPROVAL_NOT_FOUND")
			if f.reader.calls != phase-1 {
				t.Fatal("unexpected reads")
			}
		})
	}
}
func TestSnapshotFixedLease(t *testing.T) {
	for _, phase := range []string{"before read", "during read", "after callback", "approval expires", "renewal cannot extend", "renewal cannot extend initial expiry", "current expiry shortened", "caller deadline", "invalid clock"} {
		t.Run(phase, func(t *testing.T) {
			f := newSnapshotFixture()
			ctx := context.Context(context.Background())
			start := f.clock.now
			switch phase {
			case "before read":
				f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
					if call == 1 {
						f.clock.now = start.Add(15 * time.Second)
					}
					return err
				}
			case "after callback":
				f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
					if call == 2 {
						f.clock.now = start.Add(15 * time.Second)
					}
					return err
				}
			default:
				delay := 15 * time.Second
				if phase == "approval expires" || phase == "renewal cannot extend initial expiry" {
					delay = 2 * time.Second
					f.approval.ExpiresAt = start.Add(delay)
				}
				if phase == "caller deadline" {
					delay = 3 * time.Second
					ctx = deadlineContext{context.Background(), start.Add(delay)}
				}
				read := f.reader.read
				f.reader.read = func(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
					out, err := read(ctx, r)
					f.clock.now = start.Add(delay)
					if phase == "renewal cannot extend" || phase == "renewal cannot extend initial expiry" {
						f.approval.ExpiresAt = start.Add(2 * time.Hour)
					}
					if phase == "current expiry shortened" {
						f.clock.now = start.Add(time.Second)
						f.approval.ExpiresAt = f.clock.now
					}
					if phase == "invalid clock" {
						f.clock.now = time.Time{}
					}
					return out, err
				}
			}
			out, err := f.service.Snapshot(ctx, snapshotRequest())
			snapshotFailure(t, out, err, "AUTHORITY_EXPIRED")
			want := 1
			if phase == "before read" {
				want = 0
			}
			if f.reader.calls != want {
				t.Fatal("wrong read count")
			}
		})
	}
	t.Run("renewal within fixed lease", func(t *testing.T) {
		f := newSnapshotFixture()
		read := f.reader.read
		f.reader.read = func(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
			out, err := read(ctx, r)
			f.clock.now = f.clock.now.Add(time.Second)
			f.approval.ExpiresAt = f.approval.ExpiresAt.Add(time.Hour)
			return out, err
		}
		out, err := f.service.Snapshot(context.Background(), snapshotRequest())
		if err != nil || out == nil {
			t.Fatalf("%+v %v", out, err)
		}
	})
}
func TestSnapshotMalformedOutput(t *testing.T) {
	cases := []struct {
		name   string
		change func(*port.ReadResponse)
	}{
		{"page", func(r *port.ReadResponse) { r.Page = &port.Page{Size: r.Bytes} }},
		{"missing hash", func(r *port.ReadResponse) { r.SHA256 = "" }},
		{"short hash", func(r *port.ReadResponse) { r.SHA256 = strings.Repeat("a", 63) }},
		{"nonhex hash", func(r *port.ReadResponse) { r.SHA256 = strings.Repeat("z", 64) }},
		{"oversize", func(r *port.ReadResponse) { r.Bytes = 256*1024 + 1 }},
		{"oversize text", func(r *port.ReadResponse) { r.Text = strings.Repeat("a", 256*1024+1); r.Bytes = 0 }},
		{"less than text", func(r *port.ReadResponse) { r.Bytes = 4 }},
		{"character count", func(r *port.ReadResponse) { r.Text = "é😀"; r.Bytes = 2 }},
		{"extra byte", func(r *port.ReadResponse) { r.Bytes++ }},
		{"extra two bytes", func(r *port.ReadResponse) { r.Bytes += 2 }},
		{"extra four bytes", func(r *port.ReadResponse) { r.Bytes += 4 }},
		{"invalid utf8", func(r *port.ReadResponse) { r.Text = "\xff"; r.Bytes = 1 }},
		{"untrimmed initial BOM", func(r *port.ReadResponse) { r.Text = "\ufeffhello"; r.Bytes = uint64(len(r.Text)) }},
		{"NUL", func(r *port.ReadResponse) { r.Text = "a\x00b"; r.Bytes = 3 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSnapshotFixture()
			r := snapshotOutput("hello", false)
			tc.change(r)
			f.reader.read = func(context.Context, port.ReadRequest) (*port.ReadResponse, error) { return r, nil }
			out, err := f.service.Snapshot(context.Background(), snapshotRequest())
			snapshotFailure(t, out, err, "WORKSPACE_HELPER_FAILED")
			if f.reader.calls != 1 || f.currentCalls != 1 {
				t.Fatal("retry or disclosure of malformed read")
			}
		})
	}
	t.Run("nil", func(t *testing.T) {
		f := newSnapshotFixture()
		f.reader.read = func(context.Context, port.ReadRequest) (*port.ReadResponse, error) { return nil, nil }
		out, err := f.service.Snapshot(context.Background(), snapshotRequest())
		snapshotFailure(t, out, err, "WORKSPACE_HELPER_FAILED")
	})
}
func TestSnapshotCallbackProtocol(t *testing.T) {
	for _, phase := range []int{1, 2} {
		for _, kind := range []string{"skipped", "future", "repeated", "mutated", "mutated expiry", "error after success", "swallowed error", "classified refusal"} {
			t.Run(fmt.Sprintf("%s/%d", kind, phase), func(t *testing.T) {
				f := newSnapshotFixture()
				calls := 0
				var late func(*authority.Approval) error
				f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
					calls++
					a := f.approval.Clone()
					if calls != phase {
						return cb(&a)
					}
					switch kind {
					case "skipped":
						return nil
					case "future":
						late = cb
						return nil
					case "repeated":
						_ = cb(&a)
						_ = cb(&a)
						return nil
					case "mutated":
						err := cb(&a)
						a.Workspaces[0].RootIdentity.Inode = "100"
						return err
					case "mutated expiry":
						err := cb(&a)
						a.ExpiresAt = a.ExpiresAt.Add(time.Hour)
						return err
					case "error after success":
						_ = cb(&a)
						return errors.New("private diagnostics")
					case "classified refusal":
						return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
					default:
						_ = cb(nil)
						return nil
					}
				})
				out, err := f.service.Snapshot(context.Background(), snapshotRequest())
				code := "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
				if kind == "swallowed error" {
					code = "COMPUTER_APPROVAL_NOT_FOUND"
				}
				if kind == "classified refusal" {
					code = "AUTHORITY_COMPUTER_MISMATCH"
				}
				snapshotFailure(t, out, err, code)
				if late != nil {
					if err := late(&f.approval); err == nil {
						t.Fatal("future callback admitted")
					}
				}
				if f.reader.calls != phase-1 {
					t.Fatal("wrong reads")
				}
			})
		}
	}
	t.Run("swallowed admission refusal", func(t *testing.T) {
		f := newSnapshotFixture()
		f.approval.Capabilities = nil
		f.afterCurrent = func(int, *authority.Approval, error) error { return nil }
		out, err := f.service.Snapshot(context.Background(), snapshotRequest())
		snapshotFailure(t, out, err, "AUTHORITY_CAPABILITY_DENIED")
		if f.reader.calls != 0 {
			t.Fatal("refusal read")
		}
	})
}
func TestSnapshotNativeErrorsSanitized(t *testing.T) {
	var typedNil *authority.Failure
	cases := []struct {
		err          error
		code, source string
	}{
		{authority.Fail("WORKSPACE_FILE_TOO_LARGE", "native-workspace"), "WORKSPACE_FILE_TOO_LARGE", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_TEXT", "native-workspace"), "WORKSPACE_NOT_TEXT", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_A_FILE", "native-workspace"), "WORKSPACE_NOT_A_FILE", "native-workspace"},
		{authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace"), "WORKSPACE_ROOT_CHANGED", "native-workspace"},
		{fmt.Errorf("private wrapper: %w", authority.Fail("WORKSPACE_PATH_REFUSED", "native-workspace")), "WORKSPACE_PATH_REFUSED", "native-workspace"},
		{errors.New("private raw diagnostic"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("private code", "native-workspace"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_TEXT", "private source"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{typedNil, "WORKSPACE_HELPER_FAILED", "native-workspace"},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			f := newSnapshotFixture()
			f.reader.read = func(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
				return snapshotOutput("private", false), tc.err
			}
			out, err := f.service.Snapshot(context.Background(), snapshotRequest())
			snapshotFailure(t, out, err, tc.code)
			var classified *authority.Failure
			_ = errors.As(err, &classified)
			if classified.Source != tc.source || strings.Contains(err.Error(), "private") || f.reader.calls != 1 || f.currentCalls != 1 {
				t.Fatal("diagnostics, retry or disclosure")
			}
		})
	}
}
func TestSnapshotCancellationAndDependencies(t *testing.T) {
	for _, phase := range []string{"before", "during", "after"} {
		t.Run(phase, func(t *testing.T) {
			f := newSnapshotFixture()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if phase == "before" {
				cancel()
			} else if phase == "during" {
				read := f.reader.read
				f.reader.read = func(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
					out, err := read(ctx, r)
					cancel()
					return out, err
				}
			} else {
				f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
					if call == 2 {
						cancel()
					}
					return err
				}
			}
			out, err := f.service.Snapshot(ctx, snapshotRequest())
			snapshotFailure(t, out, err, "WORKSPACE_REQUEST_CANCELLED")
			want := 1
			if phase == "before" {
				want = 0
			}
			if f.reader.calls != want {
				t.Fatal("wrong reads")
			}
		})
	}
	f := newSnapshotFixture()
	out, err := f.service.Snapshot(nil, snapshotRequest())
	snapshotFailure(t, out, err, "WORKSPACE_REQUEST_CANCELLED")
	if f.reader.calls != 0 {
		t.Fatal("nil context dispatch")
	}
	for _, drop := range []string{"service", "current", "native", "clock"} {
		t.Run(drop, func(t *testing.T) {
			f := newSnapshotFixture()
			switch drop {
			case "service":
				f.service = nil
			case "current":
				f.service.current = nil
			case "native":
				f.service.native = nil
			case "clock":
				f.service.clock = nil
			}
			out, err := f.service.Snapshot(context.Background(), snapshotRequest())
			snapshotFailure(t, out, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
			if f.reader.calls != 0 {
				t.Fatal("missing dependency dispatch")
			}
		})
	}
}
