//go:build farol_git_transport

package git

// These explicitly gated fixtures execute REAL Git against disposable local bare
// repositories over pipes. They never use SSH, credentials, network, real user
// repositories or a production Farol profile. They establish protocol/CLI/hook
// interoperability, NOT native sandbox or GitHub acceptance.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

type fixtureObject struct {
	Kind string
	Data []byte
}
type fixtureConfig struct {
	Intent                                             egress.Intent
	Source, Remote, Git, Home, Receipt, Fence, HookLog string
	Objects                                            map[string]fixtureObject
	DropStatus                                         bool
}

type fixtureSource map[string]fixtureObject

func (s fixtureSource) ReadObject(ctx context.Context, id string) (string, []byte, error) {
	if err := ctx.Err(); err != nil {
		return "", nil, err
	}
	v, ok := s[id]
	if !ok {
		return "", nil, ErrSource
	}
	return v.Kind, bytes.Clone(v.Data), nil
}
func fixtureEnv(home string) []string {
	return []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "LC_ALL=C", "GIT_TERMINAL_PROMPT=0"}
}
func fixtureCommand(ctx context.Context, c fixtureConfig, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, c.Git, args...)
	cmd.Dir = c.Source
	cmd.Env = fixtureEnv(c.Home)
	return cmd
}

type fixtureCustody struct {
	c      fixtureConfig
	digest string
}

func (f *fixtureCustody) Check(ctx context.Context, d string) error {
	if d != f.digest {
		return ErrScope
	}
	cmd := fixtureCommand(ctx, f.c, "rev-parse", "HEAD")
	head, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(head)) != f.c.Intent.Head {
		return ErrSource
	}
	status, err := fixtureCommand(ctx, f.c, "status", "--porcelain=v1", "--untracked-files=all").Output()
	if err != nil || len(status) != 0 {
		return ErrScope
	}
	return ctx.Err()
}
func (f *fixtureCustody) BeforeRelease(ctx context.Context, d string) error {
	if err := f.Check(ctx, d); err != nil {
		return err
	}
	// Test-only stand-in for the existing durable owner, NOT production storage.
	file, err := os.OpenFile(f.c.Fence, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.WriteString(d + "\n")
	syncErr := file.Sync()
	closeErr := file.Close()
	return errors.Join(writeErr, syncErr, closeErr)
}

type fixtureClient struct{ once sync.Once }

func (c *fixtureClient) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (c *fixtureClient) Write(p []byte) (int, error) { return os.Stdout.Write(p) }
func (c *fixtureClient) Close() (err error) {
	c.once.Do(func() { err = errors.Join(os.Stdin.Close(), os.Stdout.Close()) })
	return err
}

type fixturePeer struct {
	reader              io.ReadCloser
	writer              io.WriteCloser
	target              egress.Target
	once                sync.Once
	drop, sent, dropped bool
	ref                 string
}

func (p *fixturePeer) Binding() egress.Target { return p.target }
func (p *fixturePeer) Read(b []byte) (int, error) {
	if p.drop && p.sent && !p.dropped {
		p.dropped = true
		_, _, err := readStatus(p.reader, p.ref)
		if err != nil {
			return 0, err
		}
		return 0, io.EOF
	}
	return p.reader.Read(b)
}
func (p *fixturePeer) Write(b []byte) (int, error) { p.sent = true; return p.writer.Write(b) }
func (p *fixturePeer) Close() (err error) {
	p.once.Do(func() { err = errors.Join(p.writer.Close(), p.reader.Close()) })
	return err
}

func TestMain(m *testing.M) {
	if path := os.Getenv("FAROL_TEST_GIT_GATE"); path != "" {
		os.Exit(runFixtureGate(path))
	}
	os.Exit(m.Run())
}
func runFixtureGate(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fixture config unavailable")
		return 65
	}
	var c fixtureConfig
	if err = json.Unmarshal(data, &c); err != nil {
		return 65
	}
	// Git's explicit fixture transport selection must name exactly one service.
	if len(os.Args) != 3 || os.Args[1] != c.Intent.Target.User+"@"+c.Intent.Target.Host || os.Args[2] != "git-receive-pack '"+c.Intent.Target.Repository+"'" {
		fmt.Fprintln(os.Stderr, "fixture SSH request refused")
		return 65
	}
	plan, err := egress.NewPlan(c.Intent)
	if err != nil {
		return 65
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	owner := &fixtureCustody{c: c, digest: IntentDigest(plan)}
	// The receiver is a real local Git child with a separate fixture environment.
	cmd := exec.CommandContext(ctx, c.Git, "receive-pack", c.Remote)
	cmd.Env = fixtureEnv(c.Home)
	cmd.Dir = c.Home
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 65
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 65
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		return 65
	}
	peer := &fixturePeer{reader: stdout, writer: stdin, target: c.Intent.Target, drop: c.DropStatus, ref: c.Intent.Ref}
	gate, err := NewGate(plan, owner, fixtureSource(c.Objects))
	if err != nil {
		return 65
	}
	client := &fixtureClient{}
	result, runErr := gate.Run(ctx, client, peer)
	waitErr := cmd.Wait()
	out := struct {
		Result           *Result
		Error, WaitError string
	}{Result: result}
	if runErr != nil {
		out.Error = runErr.Error()
	}
	if waitErr != nil {
		out.WaitError = waitErr.Error()
	}
	encoded, _ := json.MarshalIndent(out, "", "  ")
	if err = os.WriteFile(c.Receipt, encoded, 0600); err != nil {
		return 65
	}
	if runErr != nil || result == nil || (result.RefOutcome != Accepted && result.RefOutcome != NoUpdate) {
		fmt.Fprintln(os.Stderr, "fixture gate refused or uncertain")
		return 67
	}
	return 0
}

func runGit(t *testing.T, c fixtureConfig, args ...string) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := fixtureCommand(ctx, c, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return out
}
func setupInterop(t *testing.T, format string) fixtureConfig {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal("explicit Git fixture requires git:", err)
	}
	git, err = filepath.Abs(git)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	c := fixtureConfig{Source: filepath.Join(root, "source"), Remote: filepath.Join(root, "remote.git"), Home: filepath.Join(root, "home"), Git: git, Receipt: filepath.Join(root, "receipt.json"), Fence: filepath.Join(root, "fence"), HookLog: filepath.Join(root, "hook.log")}
	for _, dir := range []string{c.Source, c.Home} {
		if err = os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, c, "init", "--object-format="+format, "-b", "main")
	runGit(t, c, "config", "user.name", "Fixture")
	runGit(t, c, "config", "user.email", "fixture@example.invalid")
	// Similar sizable blobs exercise native pack delta choices rather than only
	// hand-authored encoding fixtures.
	baseData := strings.Repeat("source line with common reusable content 0123456789\n", 400)
	if err = os.WriteFile(filepath.Join(c.Source, "file.txt"), []byte(baseData), 0600); err != nil {
		t.Fatal(err)
	}
	runGit(t, c, "add", "--", "file.txt")
	runGit(t, c, "commit", "-m", "fixture base")
	base := strings.TrimSpace(string(runGit(t, c, "rev-parse", "HEAD")))
	runGit(t, c, "init", "--bare", "--object-format="+format, c.Remote)
	runGit(t, c, "push", c.Remote, "HEAD:refs/heads/main") // disposable LOCAL receiver setup
	if err = os.WriteFile(filepath.Join(c.Source, "file.txt"), []byte(baseData+"new tail\n"), 0600); err != nil {
		t.Fatal(err)
	}
	runGit(t, c, "add", "--", "file.txt")
	runGit(t, c, "commit", "-m", "fixture change")
	head := strings.TrimSpace(string(runGit(t, c, "rev-parse", "HEAD")))
	in, _, _ := packFixture(t, format)
	in.Objects = nil
	in.Known = nil
	in.Base = base
	in.Head = head
	in.Old = strings.Repeat("0", len(head))
	c.Objects = map[string]fixtureObject{}
	known := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(runGit(t, c, "rev-list", "--objects", base))), "\n") {
		if fields := strings.Fields(line); len(fields) > 0 {
			known[fields[0]] = true
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(string(runGit(t, c, "rev-list", "--objects", head))), "\n") {
		id := strings.Fields(line)[0]
		kind := strings.TrimSpace(string(runGit(t, c, "cat-file", "-t", id)))
		content := runGit(t, c, "cat-file", kind, id)
		v := &object{kind: kind, data: content}
		entry := meta(format, v)
		if entry.OID != id {
			t.Fatal("native Git digest mismatch")
		}
		if known[id] {
			in.Known = append(in.Known, entry)
			c.Objects[id] = fixtureObject{Kind: kind, Data: content}
		} else {
			in.Objects = append(in.Objects, entry)
		}
	}
	c.Intent = in
	runGit(t, c, "remote", "add", "origin", "git@fixture.invalid:owner/repo.git")
	// The hook's real file and standard path remain unchanged through the push.
	script := "#!/bin/sh\nif [ -n \"${SSH_AUTH_SOCK:-}\" ]; then exit 33; fi\nprintf 'hook\\n' >> '" + c.HookLog + "'\ncat >> '" + c.HookLog + "'\nexit 0\n"
	if err = os.WriteFile(filepath.Join(c.Source, ".git/hooks/pre-push"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return c
}
func pushFixture(t *testing.T, c fixtureConfig, refspecs ...string) ([]byte, error) {
	t.Helper()
	config := filepath.Join(c.Home, "gate.json")
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(config, data, 0600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	args := []string{"push", "--porcelain", "origin"}
	args = append(args, refspecs...)
	cmd := fixtureCommand(ctx, c, args...)
	cmd.Env = append(cmd.Env, "GIT_SSH_COMMAND='"+strings.ReplaceAll(exe, "'", "'\\''")+"'", "GIT_SSH_VARIANT=simple", "FAROL_TEST_GIT_GATE="+config)
	return cmd.CombinedOutput()
}
func remoteOID(t *testing.T, c fixtureConfig, ref string) string {
	t.Helper()
	out := runGit(t, c, "ls-remote", c.Remote, ref)
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
func readInteropReceipt(t *testing.T, c fixtureConfig) *Result {
	t.Helper()
	b, err := os.ReadFile(c.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Result *Result
		Error  string
	}
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if v.Result == nil {
		t.Fatal("no result", v.Error)
	}
	return v.Result
}
func TestGitInteropPublishesExactCommitWithOriginalHook(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			c := setupInterop(t, format)
			hookPath := filepath.Join(c.Source, ".git/hooks/pre-push")
			before, _ := os.ReadFile(hookPath)
			config := runGit(t, c, "remote", "-v")
			out, err := pushFixture(t, c, "HEAD:"+c.Intent.Ref)
			if err != nil {
				b, _ := os.ReadFile(c.Receipt)
				t.Fatalf("%v\n%s\n%s", err, out, b)
			}
			if got := remoteOID(t, c, c.Intent.Ref); got != c.Intent.Head {
				t.Fatal(got, c.Intent.Head)
			}
			r := readInteropReceipt(t, c)
			if r.RefOutcome != Accepted || !r.ReleaseFenced || !r.ClientNotified {
				t.Fatalf("%+v", r)
			}
			after, _ := os.ReadFile(hookPath)
			if !bytes.Equal(before, after) || !bytes.Equal(config, runGit(t, c, "remote", "-v")) {
				t.Fatal("hook/config changed")
			}
			hookLog, err := os.ReadFile(c.HookLog)
			if err != nil || strings.Count(string(hookLog), "hook\n") != 1 || !bytes.Contains(hookLog, []byte(c.Intent.Head)) {
				t.Fatal(string(hookLog), err)
			}
			if len(runGit(t, c, "status", "--porcelain")) != 0 {
				t.Fatal("source changed")
			}
			runGit(t, c, "--git-dir="+c.Remote, "fsck", "--strict")
			t.Logf("Git %s exact head %s, pack %d bytes, objects %d, original pre-push once", format, c.Intent.Head, r.PackBytes, r.ObjectCount)
		})
	}
}
func TestGitInteropRefusalCases(t *testing.T) {
	for _, name := range []string{"hook rejects", "dirty source", "changed remote", "multiple refs", "force cannot bypass ancestry"} {
		t.Run(name, func(t *testing.T) {
			c := setupInterop(t, "sha1")
			specs := []string{"HEAD:" + c.Intent.Ref}
			expected := ""
			switch name {
			case "hook rejects":
				if err := os.WriteFile(filepath.Join(c.Source, ".git/hooks/pre-push"), []byte("#!/bin/sh\nexit 23\n"), 0700); err != nil {
					t.Fatal(err)
				}
			case "dirty source":
				if err := os.WriteFile(filepath.Join(c.Source, "untracked"), []byte("retain"), 0600); err != nil {
					t.Fatal(err)
				}
			case "changed remote":
				runGit(t, c, "--git-dir="+c.Remote, "update-ref", c.Intent.Ref, c.Intent.Base)
				expected = c.Intent.Base
			case "multiple refs":
				specs = append(specs, "HEAD:refs/heads/feature/other")
			case "force cannot bypass ancestry":
				// Construct a real unrelated commit in the disposable receiver only.
				tr := strings.TrimSpace(string(runGit(t, c, "rev-parse", c.Intent.Base+"^{tree}")))
				other := strings.TrimSpace(string(runGit(t, c, "commit-tree", tr, "-m", "unrelated fixture")))
				runGit(t, c, "push", c.Remote, other+":"+c.Intent.Ref)
				raw := runGit(t, c, "cat-file", "commit", other)
				c.Intent.Old = other
				c.Intent.Known = append(c.Intent.Known, meta("sha1", &object{kind: "commit", data: raw}))
				c.Objects[other] = fixtureObject{Kind: "commit", Data: raw}
				expected = other
				specs = []string{"+HEAD:" + c.Intent.Ref}
			}
			if out, err := pushFixture(t, c, specs...); err == nil {
				t.Fatalf("accepted %s", out)
			}
			if got := remoteOID(t, c, c.Intent.Ref); got != expected {
				t.Fatalf("changed ref: %s != %s", got, expected)
			}
			if _, err := os.Stat(c.Fence); !os.IsNotExist(err) {
				t.Fatal("release barrier reached", err)
			}
			if got := remoteOID(t, c, "refs/heads/feature/other"); got != "" {
				t.Fatal("other ref changed")
			}
		})
	}
}
func TestGitInteropRemoteCASRejectsConcurrentWriter(t *testing.T) {
	c := setupInterop(t, "sha1")
	runGit(t, c, "--git-dir="+c.Remote, "update-ref", c.Intent.Ref, c.Intent.Base)
	c.Intent.Old = c.Intent.Base
	// The receiver already has this source object from its base branch. Change
	// the target during its pre-receive phase, after advertisement and gate.
	// Heads must point to commits; use a different existing commit instead.
	other := strings.TrimSpace(string(runGit(t, c, "commit-tree", strings.TrimSpace(string(runGit(t, c, "rev-parse", c.Intent.Base+"^{tree}"))), "-m", "CAS competitor")))
	runGit(t, c, "push", c.Remote, other+":refs/heads/competitor")
	script := "#!/bin/sh\n" +
		"unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\n" +
		"'" + c.Git + "' --git-dir='" + c.Remote + "' update-ref '" + c.Intent.Ref + "' '" + other + "' || exit 91\n" +
		"printf changed > '" + c.Home + "/competitor-witness'\nexit 0\n"
	if err := os.WriteFile(filepath.Join(c.Remote, "hooks/pre-receive"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if out, err := pushFixture(t, c, "HEAD:"+c.Intent.Ref); err == nil {
		t.Fatalf("concurrent ref accepted: %s", out)
	}
	if _, e := os.Stat(filepath.Join(c.Home, "competitor-witness")); e != nil {
		t.Fatal("competitor did not run", e)
	}
	if got := remoteOID(t, c, c.Intent.Ref); got != other {
		t.Fatal(got, other)
	}
	r := readInteropReceipt(t, c)
	if r.RefOutcome != Rejected || !r.RemoteMayHaveEffects {
		t.Fatalf("%+v", r)
	}
}
func TestGitInteropLostReplyRetainsUnknownAfterReadback(t *testing.T) {
	c := setupInterop(t, "sha1")
	c.DropStatus = true
	if _, err := pushFixture(t, c, "HEAD:"+c.Intent.Ref); err == nil {
		t.Fatal("lost reply reported successful")
	}
	got := remoteOID(t, c, c.Intent.Ref)
	if got != c.Intent.Head {
		t.Fatal("fixture did not complete actual remote update", got)
	}
	r := readInteropReceipt(t, c)
	if r.RefOutcome != Unknown || !r.RemoteMayHaveEffects {
		t.Fatalf("%+v", r)
	}
	p, _ := egress.NewPlan(c.Intent)
	obs, err := Reconcile(p, *r, got)
	if err != nil || obs.State != TargetObserved || obs.Original != Unknown {
		t.Fatal(obs, err)
	}
}

func TestGitInteropExistingFeatureFastForward(t *testing.T) {
	c := setupInterop(t, "sha1")
	runGit(t, c, "--git-dir="+c.Remote, "update-ref", c.Intent.Ref, c.Intent.Base)
	c.Intent.Old = c.Intent.Base
	if out, err := pushFixture(t, c, "HEAD:"+c.Intent.Ref); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if remoteOID(t, c, c.Intent.Ref) != c.Intent.Head {
		t.Fatal("wrong head")
	}
	runGit(t, c, "--git-dir="+c.Remote, "fsck", "--strict")
}

func TestGitInteropKnownHeadAndNoop(t *testing.T) {
	for _, noop := range []bool{false, true} {
		t.Run(fmt.Sprint(noop), func(t *testing.T) {
			c := setupInterop(t, "sha1")
			runGit(t, c, "checkout", "--detach", c.Intent.Base)
			c.Intent.Head = c.Intent.Base
			c.Intent.Objects = nil
			if noop {
				runGit(t, c, "--git-dir="+c.Remote, "update-ref", c.Intent.Ref, c.Intent.Base)
				c.Intent.Old = c.Intent.Base
			}
			if out, err := pushFixture(t, c, "HEAD:"+c.Intent.Ref); err != nil {
				b, _ := os.ReadFile(c.Receipt)
				t.Fatalf("%v %s %s", err, out, b)
			}
			if remoteOID(t, c, c.Intent.Ref) != c.Intent.Head {
				t.Fatal("wrong head")
			}
			r := readInteropReceipt(t, c)
			if noop {
				if r.RefOutcome != NoUpdate || r.RemoteMayHaveEffects {
					t.Fatal(r)
				}
			} else if r.RefOutcome != Accepted || r.ObjectCount != 0 {
				t.Fatal(r)
			}
		})
	}
}
