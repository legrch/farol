package currentsource

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/app/port"
)

const maxSafe int64 = 9007199254740991
const maxDate int64 = 8640000000000000
const protocol = "codex-app-server/v2"

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var identifierPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var threadPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var turnPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)
var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)
var modelAliasPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$`)
var modelPattern = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)
var wireIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
var effortPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
var identityPattern = regexp.MustCompile(`^[0-9]{1,20}$`)
var isoPattern = regexp.MustCompile(`^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`)

func text(v any) string        { s, _ := v.(string); return s }
func obj(v any) map[string]any { o, _ := v.(map[string]any); return o }
func yes(v any) bool           { b, _ := v.(bool); return b }
func closed(o map[string]any, required, optional string) bool {
	if o == nil {
		return false
	}
	for _, k := range strings.Fields(required) {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	allowed := strings.Fields(required + " " + optional)
	for k := range o {
		found := false
		for _, name := range allowed {
			if k == name {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func nonempty(s string, max int) bool {
	if s == "" || !utf8.ValidString(s) {
		return false
	}
	units := 0
	for _, r := range s {
		units += utf16.RuneLen(r)
		if units > max {
			return false
		}
	}
	return true
}
func path(s string) bool {
	if len(s) < 2 || s[0] != '/' || strings.HasSuffix(s, "/") || strings.ContainsRune(s, 0) || !utf8.ValidString(s) {
		return false
	}
	for _, p := range strings.Split(s[1:], "/") {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}
func identity(v any) bool {
	o := obj(v)
	return closed(o, "device inode", "") && identityPattern.MatchString(text(o["device"])) && identityPattern.MatchString(text(o["inode"]))
}

// The decoder emits coefficient/exponent tokens. Inspect their bounded decimal
// size before arithmetic: enormous exponents never expand or pass through float.
func safeNumber(v any) (int64, bool) {
	n, ok := v.(port.TaskSettingsNumber)
	if !ok {
		return 0, false
	}
	s := string(n)
	negative := strings.HasPrefix(s, "-")
	if negative {
		s = s[1:]
	}
	i := strings.IndexByte(s, 'e')
	if i < 1 || strings.IndexByte(s[i+1:], 'e') >= 0 {
		return 0, false
	}
	coefficient, exponent := s[:i], s[i+1:]
	if len(coefficient) > 16 || !digits(coefficient) || len(exponent) < 1 || len(exponent) > 3 {
		return 0, false
	}
	e, err := strconv.Atoi(exponent)
	if err != nil || e < -16 || e > 16 {
		return 0, false
	}
	if e < 0 {
		count := -e
		if count >= len(coefficient) {
			if strings.Trim(coefficient, "0") != "" {
				return 0, false
			}
			return 0, true
		}
		if strings.Trim(coefficient[len(coefficient)-count:], "0") != "" {
			return 0, false
		}
		coefficient = coefficient[:len(coefficient)-count]
		e = 0
	}
	if len(coefficient)+e > 16 {
		return 0, false
	}
	value, err := strconv.ParseInt(coefficient, 10, 64)
	if err != nil {
		return 0, false
	}
	for range e {
		value *= 10
	}
	if value > maxSafe {
		return 0, false
	}
	if negative {
		value = -value
	}
	return value, true
}
func digits(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
func generation(s string) (int64, bool) {
	if len(s) > 16 || !digits(s) || (len(s) > 1 && s[0] == '0') {
		return 0, false
	}
	n, e := strconv.ParseInt(s, 10, 64)
	return n, e == nil && n > 0 && n <= maxSafe
}
func positive(v any) (int64, bool) { n, ok := safeNumber(v); return n, ok && n > 0 }

// JS toISOString uses 4 digits for 0..9999 and signed 6 digits otherwise.
func iso(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	y := t.Year()
	year := fmt.Sprintf("%04d", y)
	if y < 0 {
		year = fmt.Sprintf("-%06d", -y)
	} else if y > 9999 {
		year = fmt.Sprintf("+%06d", y)
	}
	return year + t.Format("-01-02T15:04:05.000Z")
}
func timestamp(s string) (int64, bool) {
	if !isoPattern.MatchString(s) {
		return 0, false
	}
	end := 4
	if s[0] == '+' || s[0] == '-' {
		end = 7
	}
	year, err := strconv.Atoi(s[:end])
	if err != nil {
		return 0, false
	}
	// Parse calendar fields against a leap reference year, then round-trip with
	// the actual year to reject rollover dates and noncanonical extended years.
	reference, err := time.ParseInLocation("2006-01-02T15:04:05.000Z", "2000"+s[end:], time.UTC)
	if err != nil {
		return 0, false
	}
	t := time.Date(year, reference.Month(), reference.Day(), reference.Hour(), reference.Minute(), reference.Second(), reference.Nanosecond(), time.UTC)
	ms := t.UnixMilli()
	return ms, ms >= -maxDate && ms <= maxDate && iso(ms) == s
}
func local(v any) bool {
	o := obj(v)
	if !closed(o, "executableSha256 schemaSha256 buildId verifiedAt", "") {
		return false
	}
	for _, k := range []string{"executableSha256", "schemaSha256", "buildId"} {
		if !digestPattern.MatchString(text(o[k])) {
			return false
		}
	}
	_, ok := timestamp(text(o["verifiedAt"]))
	return ok
}
func validModel(s *port.TaskSourceModelSelection) bool {
	return s != nil && s.Harness == "codex" && len(s.ModelAlias) <= 80 && modelAliasPattern.MatchString(s.ModelAlias) && len(s.Model) <= 120 && modelPattern.MatchString(s.Model) && digestPattern.MatchString(s.ConfigSHA256) && (s.Effort == nil || effortPattern.MatchString(*s.Effort))
}
func validReference(route map[string]any) bool {
	thread, hasThread := route["observeThreadId"]
	turn, hasTurn := route["observeTurnId"]
	return (!hasThread || threadPattern.MatchString(text(thread))) && (!hasTurn || (hasThread && turnPattern.MatchString(text(turn))))
}
