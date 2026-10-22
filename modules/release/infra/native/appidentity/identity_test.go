package appidentity

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"unicode/utf16"
)

const testVersion = "1.2.3-preview.4"

var testID = strings.Repeat("a", 64)

func xmlDoc(extra string) []byte {
	return []byte(`<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.legrch.farol</string><key>CFBundleShortVersionString</key><string>1.2.3</string>` + extra + `</dict></plist>`)
}
func jsonDoc(extra string) []byte {
	return []byte(`{"bundleId":"io.github.legrch.farol","version":"1.2.3-preview.4","buildId":"` + testID + `"` + extra + `}`)
}
func wantCode(t *testing.T, err error, code Code) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code || err.Error() != string(code) {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, e := os.ReadFile("testdata/" + name)
	if e != nil {
		t.Fatal(e)
	}
	return raw
}

// These static fixtures were emitted and roundtripped by Python 3 plistlib/json,
// not this implementation. They exercise accepted scalar/collection projection;
// they do not establish signing, native-host or installed-route acceptance.
func TestIndependentOracleFixtures(t *testing.T) {
	for _, name := range []string{"oracle.xml", "oracle.bplist", "oracle-uid.bplist", "oracle-utf16.xml", "oracle-padded.bplist", "oracle-signed128.bplist", "oracle-width3.bplist"} {
		t.Run(name, func(t *testing.T) {
			if e := Verify(context.Background(), fixture(t, name), fixture(t, "oracle.json"), testVersion, testID); e != nil {
				t.Fatal(e)
			}
		})
	}
}
func TestIdentityProjection(t *testing.T) {
	for _, tc := range []struct {
		name string
		p, j []byte
		code Code
	}{
		{"bundle", bytes.Replace(xmlDoc(""), []byte(bundle), []byte("foreign"), 1), jsonDoc(""), BundleMismatch},
		{"short", bytes.Replace(xmlDoc(""), []byte("1.2.3"), []byte(testVersion), 1), jsonDoc(""), BundleMismatch},
		{"plist type", bytes.Replace(xmlDoc(""), []byte("<string>1.2.3</string>"), []byte("<array/>"), 1), jsonDoc(""), BundleMismatch},
		{"missing plist", []byte("<plist><dict/></plist>"), jsonDoc(""), BundleMismatch},
		{"json full version", xmlDoc(""), bytes.Replace(jsonDoc(""), []byte(testVersion), []byte("1.2.3"), 1), BuildMismatch},
		{"json build", xmlDoc(""), bytes.Replace(jsonDoc(""), []byte(testID), []byte(strings.Repeat("b", 64)), 1), BuildMismatch},
		{"json bundle", xmlDoc(""), bytes.Replace(jsonDoc(""), []byte(bundle), []byte("foreign"), 1), BuildMismatch},
		{"missing json", xmlDoc(""), []byte("{}"), BuildMismatch},
		{"plist top array", []byte("<plist><array/></plist>"), jsonDoc(""), InvalidPlist},
		{"json top array", xmlDoc(""), []byte("[]"), InvalidJSON},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantCode(t, Verify(context.Background(), tc.p, tc.j, testVersion, testID), tc.code)
		})
	}
	for _, v := range []string{"null", "true", "1", "[]", "{}"} {
		j := bytes.Replace(jsonDoc(""), []byte(`"`+testVersion+`"`), []byte(v), 1)
		wantCode(t, Verify(context.Background(), xmlDoc(""), j, testVersion, testID), BuildMismatch)
	}
}
func TestStrictJSON(t *testing.T) {
	bad := []string{
		`,"version":"1.2.3-preview.4"`, `,"\u0076ersion":"1.2.3-preview.4"`, `,"unknown":{"x":1,"\u0078":2}`,
		`,"unknown":"\ud800"`, `,"unknown":"\udc00"`, `,"unknown":"\ud800\u0041"`, `,"unknown":"\uQQQQ"`, `,"unknown":NaN`, `,"unknown":01`, `,"unknown":"\q"`, `,"unknown":"` + string([]byte{255}) + `"`,
	}
	for _, s := range bad {
		wantCode(t, Verify(context.Background(), xmlDoc(""), jsonDoc(s), testVersion, testID), InvalidJSON)
	}
	for _, suffix := range []string{"{}", "null", " garbage"} {
		wantCode(t, Verify(context.Background(), xmlDoc(""), append(jsonDoc(""), suffix...), testVersion, testID), InvalidJSON)
	}
	for _, s := range []string{`,"unknown":"\ud83d\ude00"`, `,"unknown":{"x":1e999,"a":[null,false,true]}`, `,"unknown":"\\ud800"`} {
		if e := Verify(context.Background(), xmlDoc(""), jsonDoc(s), testVersion, testID); e != nil {
			t.Fatal(e)
		}
	}
}
func TestStrictXML(t *testing.T) {
	for _, extra := range []string{
		`<key>CFBundleIdentifier</key><string>io.github.legrch.farol</string>`,
		`<key>CFBundleIdentifi&#101;r</key><string>io.github.legrch.farol</string>`,
		`<key>x</key><integer>abc</integer>`, `<key>x</key><integer>0x-1</integer>`, `<key>x</key><real>0x1p2</real>`, `<key>x</key><date>0000-01-01T00:00:00Z</date>`, `<key>x</key><real>NaN</real>`, `<key>x</key><real>1e999</real>`, `<key>x</key><true>yes</true>`,
		`<key>x</key><data>!@</data>`, `<key>x</key><date>2026-99-99T00:00:00Z</date>`, `<key>x</key><string>&evil;</string>`,
		`<key>x</key><dict><key>k</key><true/><key>k</key><false/></dict>`, `<key>x</key><string><true/></string>`, `<key>x</key><null/>`, `<key>x</key>`,
		`<key>x</key><string xmlns="foreign">v</string>`, `<key>x</key><string a="b">v</string>`, `<key>x</key><string>` + string([]byte{255}) + `</string>`,
	} {
		wantCode(t, Verify(context.Background(), xmlDoc(extra), jsonDoc(""), testVersion, testID), InvalidPlist)
	}
	for _, prefix := range []string{`<!DOCTYPE plist [<!ENTITY evil "expanded">]>`, `<!DOCTYPE plist SYSTEM "http://example.test/remote">`, `<?custom value?>`, `<?xml?>`, `<?xml version="1.0" version="1.0"?>`, `<?xml version="1.0" encoding="UTF-16"?>`, `<?xml version="1.0"?><?xml version="1.0"?>`, ` <?xml version="1.0"?>`, `<?xml version="1.0" standalone="maybe"?>`, `<?xml version="1.0" encoding="ISO-8859-1"?>`} {
		wantCode(t, Verify(context.Background(), append([]byte(prefix), xmlDoc("")...), jsonDoc(""), testVersion, testID), InvalidPlist)
	}
	wantCode(t, Verify(context.Background(), append(xmlDoc(""), xmlDoc("")...), jsonDoc(""), testVersion, testID), InvalidPlist)
	for _, prefix := range []string{`<?xml version='1.0' encoding='UTF-8' standalone='yes'?>`, `<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' 'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>`} {
		if e := Verify(context.Background(), append([]byte(prefix), xmlDoc("")...), jsonDoc(""), testVersion, testID); e != nil {
			t.Fatal(e)
		}
	}
	wantCode(t, Verify(context.Background(), append([]byte("\u00a0"), xmlDoc("")...), jsonDoc(""), testVersion, testID), InvalidPlist)

	if e := Verify(context.Background(), append([]byte{0xef, 0xbb, 0xbf}, xmlDoc(`<key>scalar</key><array><integer>0xFF</integer><real>-1.5</real><date>2026-10-15T12:00:00Z</date><data>AP8=</data><true/><false/><string>&amp;é😀</string></array>`)...), jsonDoc(""), testVersion, testID); e != nil {
		t.Fatal(e)
	}
	for _, be := range []bool{false, true} {
		u := utf16.Encode([]rune(string(xmlDoc(""))))
		raw := []byte{0xff, 0xfe}
		var order binary.AppendByteOrder = binary.LittleEndian
		if be {
			raw = []byte{0xfe, 0xff}
			order = binary.BigEndian
		}
		for _, c := range u {
			raw = order.AppendUint16(raw, c)
		}
		if e := Verify(context.Background(), raw, jsonDoc(""), testVersion, testID); e != nil {
			t.Fatal(e)
		}
		wantCode(t, Verify(context.Background(), append(raw, 0), jsonDoc(""), testVersion, testID), InvalidPlist)
	}
}
func TestInputAndDocumentBounds(t *testing.T) {
	wantCode(t, Verify(nil, xmlDoc(""), jsonDoc(""), testVersion, testID), InvalidInput)
	for _, v := range []string{"", strings.Repeat("😀", 129), string([]byte{255})} {
		wantCode(t, Verify(context.Background(), xmlDoc(""), jsonDoc(""), v, testID), InvalidInput)
	}
	for _, id := range []string{"", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("z", 64)} {
		wantCode(t, Verify(context.Background(), xmlDoc(""), jsonDoc(""), testVersion, id), InvalidInput)
	}
	for _, n := range []int{0, 65537} {
		wantCode(t, Verify(context.Background(), make([]byte, n), jsonDoc(""), testVersion, testID), Limit)
		wantCode(t, Verify(context.Background(), xmlDoc(""), make([]byte, n), testVersion, testID), Limit)
	}
	p, j := xmlDoc(""), jsonDoc("")
	p = append(p, bytes.Repeat([]byte(" "), 65536-len(p))...)
	j = append(j, bytes.Repeat([]byte(" "), 65536-len(j))...)
	if e := Verify(context.Background(), p, j, testVersion, testID); e != nil {
		t.Fatal(e)
	}
	// Version limit counts Unicode scalar values rather than UTF-8 bytes.
	v := strings.Repeat("😀", 128)
	p = bytes.Replace(xmlDoc(""), []byte("1.2.3"), []byte(v), 1)
	j = bytes.Replace(jsonDoc(""), []byte(testVersion), []byte(v), 1)
	if e := Verify(context.Background(), p, j, v, testID); e != nil {
		t.Fatal(e)
	}
}
func TestDepthBounds(t *testing.T) {
	for _, depth := range []int{127, 128} {
		p := xmlDoc(`<key>deep</key>` + strings.Repeat("<array>", depth) + `<true/>` + strings.Repeat("</array>", depth))
		e := Verify(context.Background(), p, jsonDoc(""), testVersion, testID)
		if depth == 127 {
			if e != nil {
				t.Fatal(e)
			}
		} else {
			wantCode(t, e, Limit)
		}
		j := jsonDoc(`,"deep":` + strings.Repeat("[", depth) + `true` + strings.Repeat("]", depth))
		e = Verify(context.Background(), xmlDoc(""), j, testVersion, testID)
		if depth == 127 {
			if e != nil {
				t.Fatal(e)
			}
		} else {
			wantCode(t, e, Limit)
		}
	}
}

// A deterministic context becomes canceled during parsing, without timing races.
type stepContext struct {
	context.Context
	n int
}

func (c *stepContext) Err() error {
	c.n--
	if c.n <= 0 {
		return context.Canceled
	}
	return nil
}
func TestCancellationAndConcurrentCalls(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	wantCode(t, Verify(ctx, xmlDoc(""), jsonDoc(""), testVersion, testID), Canceled)
	for _, p := range [][]byte{xmlDoc(`<key>a</key><array>` + strings.Repeat(`<true/>`, 100) + `</array>`), fixture(t, "oracle.bplist")} {
		wantCode(t, Verify(&stepContext{Context: context.Background(), n: 30}, p, jsonDoc(""), testVersion, testID), Canceled)
	}
	j := jsonDoc(`,"array":[` + strings.Repeat(`true,`, 100) + `true]`)
	wantCode(t, Verify(&stepContext{Context: context.Background(), n: 100}, xmlDoc(""), j, testVersion, testID), Canceled)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 20 {
				if e := Verify(context.Background(), xmlDoc(""), jsonDoc(""), testVersion, testID); e != nil {
					t.Error(e)
				}
			}
		})
	}
	wg.Wait()
}
