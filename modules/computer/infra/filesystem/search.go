package filesystem

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"regexp/syntax"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
	"golang.org/x/text/cases"
)

const (
	searchFileBytes   = 8 * 1024 * 1024
	searchTotalBytes  = 64 * 1024 * 1024
	searchOutputBytes = 512*1024 - 1024
	searchEntries     = 100000
	searchDirectories = 10000
	searchDepth       = 64
	searchMatches     = 100
	searchLineRunes   = 500
	searchIgnoreBytes = 256 * 1024
	searchIgnoreRules = 4096
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
	if !validScratchReadBinding(binding) || request.RelativePath != mutation.ScratchPath(binding.RunID)+"/check.txt" {
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
	rootInfo, err := stat(root)
	if err != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
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
		if scratch != nil && listed.Mode&unix.S_IFMT != unix.S_IFREG {
			return nil, refusal("WORKSPACE_RACE_DETECTED")
		}
		if listed.Mode&unix.S_IFMT == unix.S_IFDIR {
			if p.exact != nil {
				return nil, refusal("WORKSPACE_PATH_REFUSED")
			}
			// Load root-to-parent ignore rules, as the native helper does. Explicit
			// directory selection bypasses ignore on that directory, not its children.
			rules, ruleErr := scan.ancestorRules(parts[:len(parts)-1])
			if ruleErr != nil {
				return nil, ruleErr
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
		if rootErr := recheckRoot(request.Workspace, rootInfo); rootErr != nil {
			return nil, rootErr
		}
		return nil, err
	}
	if err := recheckRoot(request.Workspace, rootInfo); err != nil {
		return nil, err
	}
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	return scan.result, nil
}

// RE2 gives bounded linear matching. Python-only constructs and escapes with
// different Unicode shorthand semantics are refused. This is a conservative
// RE2 subset, not full Python regex equivalence. It includes Unicode literals,
// groups, alternation, classes, anchors, flags and standalone quantifiers. No interpreter or fallback is launched.
func searchExpression(pattern string) (*regexp.Regexp, error) {
	units := 0
	if !utf8.ValidString(pattern) || pattern == "" {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	for _, r := range pattern {
		units++
		if r > 0xffff {
			units++
		}
		if r < 32 || r == 127 || units > 4096 {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
	}
	for i := 0; i < len(pattern); i++ {
		if pattern[i] != '\\' {
			continue
		}
		i++
		if i == len(pattern) {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
		// Python uses Unicode word/digit/space classes and boundaries; RE2 uses
		// ASCII for these escapes. Refuse until their contract is explicitly mapped.
		if strings.ContainsRune("wWdDsSbBpPzQ", rune(pattern[i])) {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
	}
	if strings.Contains(pattern, "(?U") || strings.Contains(pattern, `\x{`) || strings.Contains(pattern, "[[:") || strings.Contains(pattern, "(?<") {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	tree, err := syntax.Parse(pattern, syntax.Perl)
	if err != nil || !searchSafeRegex(tree, false) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	expression, err := regexp.Compile(pattern)
	if err != nil {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	return expression, nil
}

// Preserve the helper's refusal of nested/adjacent repetitions and repeated
// alternatives even though RE2 itself does not backtrack. Parser simplification
// may refuse additional equivalent forms; it never enables a Python-only form.
func searchRepeat(tree *syntax.Regexp) bool {
	return tree.Op == syntax.OpStar || tree.Op == syntax.OpPlus || tree.Op == syntax.OpQuest || tree.Op == syntax.OpRepeat
}
func searchContainsRepeat(tree *syntax.Regexp) bool {
	if searchRepeat(tree) {
		return true
	}
	for _, child := range tree.Sub {
		if searchContainsRepeat(child) {
			return true
		}
	}
	return false
}
func searchSafeRegex(tree *syntax.Regexp, inside bool) bool {
	if searchRepeat(tree) {
		if inside {
			return false
		}
		return searchSafeRegex(tree.Sub[0], true)
	}
	if tree.Op == syntax.OpAlternate {
		if inside {
			return false
		}
		for _, child := range tree.Sub {
			if searchContainsRepeat(child) {
				return false
			}
		}
	}
	previous := false
	for _, child := range tree.Sub {
		if !searchSafeRegex(child, inside) {
			return false
		}
		if tree.Op == syntax.OpConcat {
			repeated := searchRepeat(child)
			if repeated && previous {
				return false
			}
			// Anchors do not separate adjacent repetitions in the active helper.
			if child.Op != syntax.OpBeginLine && child.Op != syntax.OpEndLine && child.Op != syntax.OpBeginText && child.Op != syntax.OpEndText {
				previous = repeated
			}
		}
	}
	return true
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
func searchExcerpt(line string, startByte, endByte int) (string, bool) {
	runes := []rune(line)
	start, end := utf8.RuneCountInString(line[:startByte]), utf8.RuneCountInString(line[:endByte])
	for i, r := range runes {
		if r != '\t' && (r < 32 || r == 127) {
			runes[i] = '�'
		}
	}
	if len(runes) <= searchLineRunes {
		return string(runes), false
	}
	begin := 0
	if end > searchLineRunes {
		begin = min(start-min(start, searchLineRunes/4), len(runes)-searchLineRunes)
	}
	return string(runes[begin : begin+searchLineRunes]), true
}
func searchMatchBytes(match port.SearchMatch) int {
	value := struct {
		Line      uint64 `json:"line"`
		Path      string `json:"path"`
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
	}{match.Line, match.Path, match.Text, match.Truncated}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	// Encode's final LF charges the match separator used by the active helper.
	_ = encoder.Encode(value)
	charge := encoded.Len()
	// encoding/json emits non-ASCII UTF-8; Python ensure_ascii expands each rune.
	for _, r := range match.Path + match.Text {
		if r > 127 && r != '\u2028' && r != '\u2029' {
			// encoding/json already escapes U+2028/U+2029 to six ASCII bytes.
			width := 6
			if r > 0xffff {
				width = 12
			}
			charge += width - utf8.RuneLen(r)
		}
	}
	return charge
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
	rules, err := s.ignoreRules(fd, strings.Join(parts, "/"), inherited)
	if err != nil {
		return err
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

type searchIgnoreRule struct {
	base, pattern                    string
	expression                       *regexp.Regexp
	negated, directoryOnly, anchored bool
}

func (s *searchScan) ancestorRules(parts []string) ([]searchIgnoreRule, error) {
	var rules []searchIgnoreRule
	for depth := 0; depth <= len(parts); depth++ {
		fd, err := walk(s.root, parts[:depth])
		if err != nil {
			return nil, err
		}
		rules, err = s.ignoreRules(fd, strings.Join(parts[:depth], "/"), rules)
		unix.Close(fd)
		if err != nil {
			return nil, err
		}
	}
	return rules, nil
}
func (s *searchScan) ignoreRules(fd int, base string, inherited []searchIgnoreRule) ([]searchIgnoreRule, error) {
	rules := append([]searchIgnoreRule(nil), inherited...)
	target := ".gitignore"
	if base != "" {
		target = base + "/" + target
	}
	parts := strings.Split(target, "/")
	// Ignore metadata never bypasses exclusions or exact-file policy.
	if s.policy.denies(parts) || !s.policy.permitsFile(target) {
		s.result.ScanLimited = true
		return rules, nil
	}
	var listed unix.Stat_t
	if err := unix.Fstatat(fd, ".gitignore", &listed, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return rules, nil
		}
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	if listed.Mode&unix.S_IFMT != unix.S_IFREG || listed.Nlink != 1 {
		s.result.ScanLimited = true
		return rules, nil
	}
	raw, err := s.readSearchBytes(fd, ".gitignore", searchIgnoreBytes, false)
	if err != nil {
		return nil, err
	}
	if raw == nil || !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 {
		s.result.ScanLimited = true
		return rules, nil
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if err := s.checkpoint(); err != nil {
			return nil, err
		}
		if s.stop {
			break
		}
		line = strings.TrimSuffix(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		rule, ok := searchIgnore(base, line)
		if !ok {
			s.result.ScanLimited = true
			continue
		}
		if len(rules) >= searchIgnoreRules {
			s.result.ScanLimited = true
			s.stop = true
			break
		}
		rules = append(rules, rule)
	}
	return rules, nil
}
func searchIgnore(base, pattern string) (searchIgnoreRule, bool) {
	rule := searchIgnoreRule{base: base}
	if strings.HasPrefix(pattern, "!") {
		rule.negated = true
		pattern = pattern[1:]
	}
	rule.directoryOnly = strings.HasSuffix(pattern, "/")
	rule.anchored = strings.HasPrefix(pattern, "/")
	pattern = strings.Trim(pattern, "/")
	if pattern == "" || strings.ContainsAny(pattern, "\\\x00") || len(pattern) > 4096 {
		return rule, false
	}
	for _, part := range strings.Split(pattern, "/") {
		if part == "" || part == "." || part == ".." {
			return rule, false
		}
	}
	var translated strings.Builder
	translated.WriteString("^(?:")
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				for i+1 < len(pattern) && pattern[i+1] == '*' {
					i++
				}
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					translated.WriteString("(?:.*/)?")
					i++
				} else {
					translated.WriteString(".*")
				}
			} else {
				translated.WriteString("[^/]*")
			}
		case '?':
			translated.WriteString("[^/]")
		case '[':
			end := strings.IndexByte(pattern[i+1:], ']')
			if end < 0 {
				return rule, false
			}
			end += i + 1
			body := pattern[i+1 : end]
			if body == "" {
				return rule, false
			}
			if body[0] == '!' {
				body = "^" + body[1:]
			} else if body[0] == '^' {
				body = "\\" + body
			}
			translated.WriteString("[" + body + "]")
			i = end
		default:
			translated.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
		}
	}
	translated.WriteString(")$")
	expression, err := regexp.Compile(translated.String())
	if err != nil {
		return rule, false
	}
	rule.pattern = pattern
	rule.expression = expression
	return rule, true
}
func searchIgnored(rules []searchIgnoreRule, relative string, directory bool) bool {
	ignored := false
	for _, rule := range rules {
		local := relative
		if rule.base != "" {
			if !strings.HasPrefix(relative, rule.base+"/") {
				continue
			}
			local = strings.TrimPrefix(relative, rule.base+"/")
		}
		if local == "" || rule.directoryOnly && !directory {
			continue
		}
		matched := false
		if !rule.anchored && !strings.Contains(rule.pattern, "/") {
			for _, part := range strings.Split(local, "/") {
				if rule.expression.MatchString(part) {
					matched = true
					break
				}
			}
		} else {
			matched = rule.expression.MatchString(local)
		}
		if matched {
			ignored = !rule.negated
		}
	}
	return ignored
}
