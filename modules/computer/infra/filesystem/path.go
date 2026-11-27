package filesystem

import (
	"bytes"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

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
