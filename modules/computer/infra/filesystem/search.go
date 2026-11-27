package filesystem

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
	"golang.org/x/text/cases"
)

var _ port.Search = (*Workspace)(nil)

// Search is descriptor-bound, with the active helper's file/scan/result bounds.
// It searches LF-delimited UTF-8 lines and returns workspace-relative paths.
// Result flags are independent: neither an empty nor a partial result proves
// absence. Like List/Read, this is not an atomic snapshot of the whole tree.
func (w *Workspace) Search(ctx context.Context, request port.SearchRequest) (*port.SearchResponse, error) {
	return w.search(ctx, request, nil)
}

func (w *Workspace) SearchScratch(ctx context.Context, request port.SearchRequest, binding port.ScratchReadBinding) (*port.SearchResponse, error) {
	leaf := mutation.ScratchPath(binding.RunID)
	if !validScratchReadBinding(binding) || (request.RelativePath != leaf+"/check.txt" && request.RelativePath != leaf) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	return w.search(ctx, request, &binding)
}

func (w *Workspace) search(ctx context.Context, request port.SearchRequest, scratch *port.ScratchReadBinding) (*port.SearchResponse, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	expression, err := searchExpression(request.Pattern)
	if err != nil {
		return nil, err
	}
	parts, err := components(request.RelativePath, false, true)
	if err != nil {
		return nil, err
	}
	p, err := w.parsePolicy(request.Workspace)
	if err != nil {
		return nil, err
	}
	if p.denies(parts) {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	root, binding, err := openedRoot(request.Workspace)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	binding.RelativePath = request.RelativePath
	scan := searchScan{ctx: ctx, deadline: time.Now().Add(5 * time.Second), workspace: w, root: root, policy: p, expression: expression, result: &port.SearchResponse{Binding: binding, Matches: make([]port.SearchMatch, 0)}, scratch: scratch}
	if len(parts) == 0 {
		if p.exact != nil {
			return nil, refusal("WORKSPACE_PATH_REFUSED")
		}
		err = scan.directory(root, nil, nil, 0)
	} else {
		parent, openErr := walk(root, parts[:len(parts)-1])
		if openErr != nil {
			return nil, openErr
		}
		defer unix.Close(parent)
		var listed unix.Stat_t
		if err := unix.Fstatat(parent, parts[len(parts)-1], &listed, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, openError(err)
		}
		if scratch != nil && listed.Mode&unix.S_IFMT != unix.S_IFREG && listed.Mode&unix.S_IFMT != unix.S_IFDIR {
			return nil, refusal("WORKSPACE_RACE_DETECTED")
		}
		if listed.Mode&unix.S_IFMT == unix.S_IFDIR {
			if p.exact != nil {
				return nil, refusal("WORKSPACE_PATH_REFUSED")
			}
			// Load root-to-parent ignore rules, as the native helper does. Explicit
			// directory selection bypasses ignore on that directory, not its children.
			var rules []searchIgnoreRule
			if scratch == nil {
				var ruleErr error
				rules, ruleErr = scan.ancestorRules(parts[:len(parts)-1])
				if ruleErr != nil {
					return nil, ruleErr
				}
			}
			child, openErr := directory(parent, parts[len(parts)-1])
			if openErr != nil {
				return nil, openErr
			}
			opened, statErr := stat(child)
			if statErr != nil || !stable(listed, opened) {
				unix.Close(child)
				return nil, refusal("WORKSPACE_RACE_DETECTED")
			}
			if scratch != nil {
				fixture, _, openErr := regular(child, "check.txt")
				if openErr != nil {
					unix.Close(child)
					return nil, refusal("WORKSPACE_RACE_DETECTED")
				}
				matches := scratchOpenedMatches(root, child, fixture, *scratch)
				unix.Close(fixture)
				if !matches {
					unix.Close(child)
					return nil, refusal("WORKSPACE_RACE_DETECTED")
				}
			}
			err = scan.directory(child, parts, rules, 0)
			unix.Close(child)
		} else {
			before, statErr := stat(parent)
			if statErr != nil {
				return nil, refusal("WORKSPACE_PATH_REFUSED")
			}
			if !p.permitsFile(request.RelativePath) {
				return nil, refusal("WORKSPACE_PATH_REFUSED")
			}
			err = scan.file(parent, parts[len(parts)-1], request.RelativePath, true)
			if err == nil {
				err = scan.recheckDirectory(parent, parts[:len(parts)-1], before)
			}
		}
	}
	if err != nil {
		if rootErr := recheckBinding(request.Workspace, binding); rootErr != nil {
			return nil, rootErr
		}
		return nil, err
	}
	if err := recheckBinding(request.Workspace, binding); err != nil {
		return nil, err
	}
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	return scan.result, nil
}

type searchScan struct {
	ctx                                 context.Context
	deadline                            time.Time
	workspace                           *Workspace
	root                                int
	policy                              policy
	expression                          *regexp.Regexp
	result                              *port.SearchResponse
	entries, directories, bytes, output int
	stop                                bool
	scratch                             *port.ScratchReadBinding
}

func (s *searchScan) checkpoint() error {
	if err := cancelled(s.ctx); err != nil {
		return err
	}
	if !time.Now().Before(s.deadline) {
		return refusal("WORKSPACE_SEARCH_TIMEOUT")
	}
	return nil
}

// readSearchBytes verifies both the opened object and its current directory
// entry after reading. It shares regular/stable/no-follow mechanics with Read.
func (s *searchScan) readSearchBytes(parent int, name string, ceiling int, explicit bool) ([]byte, error) {
	fd, before, err := regular(parent, name)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	if s.scratch != nil && !scratchOpenedMatches(s.root, parent, fd, *s.scratch) {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	allowed, err := s.allowBytes(before.Size, ceiling, explicit)
	if err != nil || !allowed {
		return nil, err
	}
	raw := make([]byte, int(before.Size))
	for n := 0; n < len(raw); {
		if err := s.checkpoint(); err != nil {
			return nil, err
		}
		if s.stop {
			return nil, nil
		}
		read, err := unix.Pread(fd, raw[n:], int64(n))
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || read == 0 {
			return nil, refusal("WORKSPACE_RACE_DETECTED")
		}
		n += read
	}
	if s.workspace.afterRead != nil {
		s.workspace.afterRead()
	}
	after, err := stat(fd)
	var current unix.Stat_t
	if err != nil || !stable(before, after) || after.Nlink != 1 || unix.Fstatat(parent, name, &current, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(before, current) || current.Nlink != 1 || s.scratch != nil && !scratchOpenedMatches(s.root, parent, fd, *s.scratch) {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	s.bytes += len(raw)
	return raw, nil
}

// Both content and ignore metadata use this monotonic request byte budget.
func (s *searchScan) allowBytes(size int64, ceiling int, explicit bool) (bool, error) {
	if size < 0 {
		return false, refusal("WORKSPACE_RACE_DETECTED")
	}
	if size > int64(ceiling) {
		if explicit {
			return false, refusal("WORKSPACE_FILE_TOO_LARGE")
		}
		s.result.ScanLimited = true
		return false, nil
	}
	if size > int64(searchTotalBytes-s.bytes) {
		s.result.ScanLimited = true
		s.stop = true
		return false, nil
	}
	return true, nil
}

func (s *searchScan) file(parent int, name, path string, explicit bool) error {
	if err := s.checkpoint(); err != nil {
		return err
	}
	if s.stop {
		return nil
	}
	raw, err := s.readSearchBytes(parent, name, searchFileBytes, explicit)
	if err != nil || raw == nil {
		return err
	}
	if bytes.IndexByte(raw, 0) >= 0 || !utf8.Valid(raw) {
		if explicit {
			return refusal("WORKSPACE_NOT_TEXT")
		}
		return nil
	}
	return s.lines(path, string(raw))
}
func (s *searchScan) lines(path, text string) error {
	// Empty input has no lines, and a final LF does not create a phantom hit.
	for number := uint64(1); text != ""; number++ {
		if err := s.checkpoint(); err != nil {
			return err
		}
		if s.stop {
			break
		}
		line, rest, found := strings.Cut(text, "\n")
		if found {
			text = rest
		} else {
			text = ""
		}
		line = strings.TrimSuffix(line, "\r")
		location := s.expression.FindStringIndex(line)
		if location == nil {
			continue
		}
		excerpt, truncated := searchExcerpt(line, location[0], location[1])
		match := port.SearchMatch{Path: path, Line: number, Text: excerpt, Truncated: truncated}
		// Charge using the active ASCII-escaped JSON shape, reserving the envelope.
		charge := searchMatchBytes(match)
		if len(s.result.Matches) == searchMatches || charge > searchOutputBytes-s.output {
			s.result.ResultLimited = true
			s.stop = true
			break
		}
		s.output += charge
		s.result.Matches = append(s.result.Matches, match)
	}
	return nil
}

func (s *searchScan) directory(fd int, parts []string, inherited []searchIgnoreRule, depth int) error {
	if err := s.checkpoint(); err != nil {
		return err
	}
	if s.stop {
		return nil
	}
	if depth > searchDepth || s.directories >= searchDirectories {
		s.result.ScanLimited = true
		return nil
	}
	s.directories++
	before, err := stat(fd)
	if err != nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	rules := inherited
	if s.scratch == nil {
		rules, err = s.ignoreRules(fd, strings.Join(parts, "/"), inherited)
		if err != nil {
			return err
		}
	}
	// Reopen "." rather than Dup: directory offsets must not be shared with an
	// ancestor or another operation (the repeated Markdown discovery invariant).
	copyFD, err := directory(fd, ".")
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(copyFD), "workspace-search-directory")
	names, overflow, err := s.names(file)
	file.Close()
	if err != nil {
		return err
	}
	if overflow {
		s.result.ScanLimited = true
	}
	// Diagnostic traversal may read only the retained fixture, never user
	// files, ignore metadata, symlinks or nested directories.
	if s.scratch != nil && (depth != 0 || overflow || len(names) != 1 || names[0] != "check.txt") {
		return refusal("WORKSPACE_RACE_DETECTED")
	}
	fold := cases.Fold()
	folder := fold.String
	sort.Slice(names, func(i, j int) bool {
		a, b := folder(names[i]), folder(names[j])
		if a == b {
			return names[i] < names[j]
		}
		return a < b
	})
	for _, name := range names {
		if err := s.checkpoint(); err != nil {
			return err
		}
		if s.stop {
			break
		}
		if _, err := components(name, false, false); err != nil || strings.Contains(name, "/") {
			s.result.ScanLimited = true
			continue
		}
		target := append(append([]string{}, parts...), name)
		if s.policy.denies(target) {
			continue
		}
		path := strings.Join(target, "/")
		if _, err := components(path, false, false); err != nil {
			s.result.ScanLimited = true
			continue
		}
		var listed unix.Stat_t
		if unix.Fstatat(fd, name, &listed, unix.AT_SYMLINK_NOFOLLOW) != nil {
			return refusal("WORKSPACE_RACE_DETECTED")
		}
		kind := listed.Mode & unix.S_IFMT
		if s.scratch != nil && (kind != unix.S_IFREG || listed.Nlink != 1) {
			return refusal("WORKSPACE_RACE_DETECTED")
		}
		if searchIgnored(rules, path, kind == unix.S_IFDIR) {
			continue
		}
		switch kind {
		case unix.S_IFDIR:
			child, err := directory(fd, name)
			if err != nil {
				return err
			}
			opened, statErr := stat(child)
			if statErr != nil || !stable(listed, opened) {
				unix.Close(child)
				return refusal("WORKSPACE_RACE_DETECTED")
			}
			err = s.directory(child, target, rules, depth+1)
			unix.Close(child)
			if err != nil {
				return err
			}
		case unix.S_IFREG:
			if listed.Nlink != 1 {
				continue
			}
			if err := s.file(fd, name, path, false); err != nil {
				return err
			}
		}
	}
	return s.recheckDirectory(fd, parts, before)
}

func (s *searchScan) recheckDirectory(fd int, parts []string, before unix.Stat_t) error {
	after, err := stat(fd)
	if err != nil || !stable(before, after) {
		return refusal("WORKSPACE_RACE_DETECTED")
	}
	// Rewalk the directory from the retained root: a renamed/replaced subtree
	// cannot disclose results merely because its old descriptor still exists.
	currentFD, err := walk(s.root, parts)
	if err != nil {
		return refusal("WORKSPACE_RACE_DETECTED")
	}
	defer unix.Close(currentFD)
	current, err := stat(currentFD)
	if err != nil || !stable(before, current) {
		return refusal("WORKSPACE_RACE_DETECTED")
	}
	return nil
}
func (s *searchScan) names(reader nameReader) ([]string, bool, error) {
	names := make([]string, 0)
	remaining := searchEntries - s.entries
	if remaining <= 0 {
		return names, true, nil
	}
	for {
		if err := s.checkpoint(); err != nil {
			return nil, false, err
		}
		if s.stop {
			return nil, true, nil
		}
		batch, err := reader.Readdirnames(min(1000, remaining-len(names)+1))
		if len(batch) > remaining-len(names) {
			s.entries = searchEntries
			return nil, true, nil
		}
		names = append(names, batch...)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, false, refusal("WORKSPACE_PATH_REFUSED")
		}
	}
	s.entries += len(names)
	return names, false, nil
}
