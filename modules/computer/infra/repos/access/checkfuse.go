package access

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	check "github.com/legrch/farol/modules/computer/domain/connector"
	"github.com/legrch/farol/pkg/limit"
	"golang.org/x/sys/unix"
)

// The original TS verifier and the Go explicit check share ONE exclusive name.
// Existing schema-1/2 (or unreadable/partial) files are immutable consumed fences.
// The Go Store's mutex and lifetime lock own this publication; this adapter owns
// no retry policy, independent index, grant, settings writer or runtime cache.
// Fixed installed layout: farol-state/{go-core/computer,secure-mcp-connector/
// computer-authority}. A caller cannot supply a different attempt directory.
type checkFuseDirectory struct {
	fd       int
	parent   int
	name     string
	identity unix.Stat_t
}

func (d *disk) publishConnectionCheckFuse(entry check.Entry) (err error) {
	if !entry.Valid() || entry.Phase != check.Prepared || entry.Scope == nil ||
		entry.Scope.Mode != check.Bootstrap || entry.Scope.DocumentDigest == "" {
		return check.ErrRefused
	}
	if err = d.check(); err != nil {
		return err
	}
	if filepath.Base(d.root) != "computer" || filepath.Base(filepath.Dir(d.root)) != "go-core" {
		return unavailable()
	}
	var held []checkFuseDirectory
	defer func() {
		for i := len(held) - 1; i >= 0; i-- {
			if closed := d.cleanup.fd(held[i].fd); closed != nil {
				// Do not retry a numeric descriptor or erase the original fuse.
				d.cleanupErr = errors.Join(d.cleanupErr, closed)
				err = &CommitFailure{Unknown: true, cause: errors.Join(err, closed)}
			}
		}
	}()
	open := func(parent int, name string) (int, error) {
		fd, e := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if e != nil {
			return -1, refuse(e)
		}
		held = append(held, checkFuseDirectory{fd: fd, parent: parent, name: name})
		info, e := fdstat(fd)
		if e != nil || !private(info, unix.S_IFDIR, 0700) || info.Dev != d.identity.Dev {
			return -1, refuse(e)
		}
		held[len(held)-1].identity = info
		return fd, nil
	}
	profile, e := open(d.dir, "..")
	if e != nil {
		return e
	}
	state, e := open(profile, "..")
	if e != nil {
		return e
	}
	connector, e := open(state, "secure-mcp-connector")
	if e != nil {
		return e
	}
	attempts, e := open(connector, "computer-authority")
	if e != nil {
		return e
	}
	qualify := func() error {
		if e := d.check(); e != nil {
			return e
		}
		for _, v := range held {
			opened, e := fdstat(v.fd)
			var named unix.Stat_t
			if e != nil || !same(opened, v.identity) || !private(opened, unix.S_IFDIR, 0700) {
				return refuse(e)
			}
			if e = unix.Fstatat(v.parent, v.name, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil || !same(named, opened) || !private(named, unix.S_IFDIR, 0700) {
				return refuse(e)
			}
		}
		// The two '..' descriptors must also own the expected forward names.
		for _, v := range []struct {
			parent   int
			name     string
			expected unix.Stat_t
		}{
			{profile, "computer", d.identity}, {state, "go-core", held[0].identity},
		} {
			var named unix.Stat_t
			if e := unix.Fstatat(v.parent, v.name, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil || !same(named, v.expected) || !private(named, unix.S_IFDIR, 0700) {
				return refuse(e)
			}
		}
		return nil
	}
	if e = qualify(); e != nil {
		return e
	}
	scope := entry.Scope
	name := "app-verification-" + scope.ChallengeDigest + ".json"
	raw, e := json.Marshal(struct {
		Schema          int           `json:"schema"`
		OperationID     string        `json:"operationId"`
		Request         check.Request `json:"request"`
		ChallengeSHA256 string        `json:"challengeSha256"`
		ScopeDigest     string        `json:"scopeDigest"`
		DocumentDigest  string        `json:"documentDigest"`
		PromptDigest    string        `json:"promptDigest"`
	}{3, entry.Request.OperationID, entry.Request, scope.ChallengeDigest, scope.ScopeDigest, scope.DocumentDigest, scope.PromptDigest})
	if e != nil {
		return refuse(e)
	}
	raw = append(raw, '\n')
	fd, e := unix.Openat(attempts, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		// Presence alone consumes old/partial/foreign claims. Never migrate,
		// truncate, renew, rename away or infer their historical Send result.
		return refuse(e)
	}
	file := os.NewFile(uintptr(fd), name)
	n, written := file.Write(raw)
	if written == nil && n != len(raw) {
		written = io.ErrShortWrite
	}
	if written == nil {
		written = file.Sync()
	}
	closed := d.closeFile(file)
	if written != nil || closed != nil {
		return &CommitFailure{Unknown: true, cause: errors.Join(written, closed)}
	}
	if e = d.syncDirectory(attempts); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = qualify(); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	fd, e = unix.Openat(attempts, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	file = os.NewFile(uintptr(fd), name)
	before, statErr := fdstat(fd)
	actual, readErr := limit.Read(file, int64(len(raw)))
	after, afterErr := fdstat(fd)
	var named unix.Stat_t
	namedErr := unix.Fstatat(attempts, name, &named, unix.AT_SYMLINK_NOFOLLOW)
	closed = d.closeFile(file)
	if statErr != nil || readErr != nil || afterErr != nil || namedErr != nil || closed != nil ||
		!private(before, unix.S_IFREG, 0600) || !stableState(before, after) || !stableState(after, named) || !bytes.Equal(actual, raw) {
		return &CommitFailure{Unknown: true, cause: errors.Join(statErr, readErr, afterErr, namedErr, closed)}
	}
	if e = qualify(); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}
