package lease

import (
	"strings"
	"testing"
)

const plistPrefix = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>`
const plistSuffix = `</dict></plist>
`

func validXML() string {
	return plistPrefix + `<key>Internal</key><true/>
<key>GlobalPermissionsEnabled</key><true/>
<key>FilesystemType</key><string>apfs</string>
<key>Bootable</key><true/>
<key>MountPoint</key><string>/</string>
<key>APFSVolumeGroupID</key><string>11111111-2222-3333-4444-555555555555</string>
<key>APFSSnapshot</key><true/>
<key>IgnoredArray</key><array><string>irrelevant</string><dict><key>nested</key><false/></dict></array>
` + plistSuffix
}
func TestStructuredPlistExactRequiredFields(t *testing.T) {
	m, err := decodeMetadata([]byte(validXML()), "/")
	if err != nil || !m.Internal || !m.GlobalPermissions || !m.Bootable || !m.Snapshot || m.MountPoint != "/" {
		t.Fatalf("plist refused %+v: %v", m, err)
	}
	data := strings.Replace(validXML(), "<string>/</string>", "<string>/System/Volumes/Data</string>", 1)
	data = strings.Replace(data, "<key>APFSSnapshot</key><true/>", "<key>APFSSnapshot</key><false/>", 1)
	m, err = decodeMetadata([]byte(data), "/System/Volumes/Data")
	if err != nil || m.Snapshot {
		t.Fatalf("Data refused %+v %v", m, err)
	}
}
func TestPlistMalformedAndAmbiguousRefuse(t *testing.T) {
	xml := validXML()
	tests := []struct{ name, raw string }{
		{"missing pairing", strings.Replace(xml, `<key>APFSVolumeGroupID</key><string>11111111-2222-3333-4444-555555555555</string>`, "", 1)},
		{"missing snapshot", strings.Replace(xml, `<key>APFSSnapshot</key><true/>`, "", 1)},
		{"false internal", strings.Replace(xml, `<key>Internal</key><true/>`, `<key>Internal</key><false/>`, 1)},
		{"wrong typed", strings.Replace(xml, `<key>Internal</key><true/>`, `<key>Internal</key><string>true</string>`, 1)},
		{"wrong group type", strings.Replace(xml, `<key>APFSVolumeGroupID</key><string>11111111-2222-3333-4444-555555555555</string>`, `<key>APFSVolumeGroupID</key><true/>`, 1)},
		{"duplicate key", strings.Replace(xml, `<key>Internal</key><true/>`, `<key>Internal</key><true/><key>Internal</key><true/>`, 1)},
		{"duplicate nested", strings.Replace(xml, `<key>nested</key><false/>`, `<key>nested</key><false/><key>nested</key><false/>`, 1)},
		{"malformed entity", strings.Replace(xml, "apfs", "&hidden;", 1)},
		{"malformed XML", strings.Replace(xml, "</plist>", "", 1)},
		{"directed DTD", strings.Replace(xml, "DOCTYPE plist PUBLIC", "DOCTYPE entity PUBLIC", 1)},
		{"overflow", xml + strings.Repeat("x", maxPlistBytes)},
		{"empty group", strings.Replace(xml, "11111111-2222-3333-4444-555555555555", "", 1)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m, e := decodeMetadata([]byte(tc.raw), "/")
			if e == nil { // The validly typed but false Internal is rejected at qualification, not parsing.
				if tc.name == "false internal" || tc.name == "empty group" {
					if m.Internal && tc.name == "false internal" {
						t.Fatal("false internal became true")
					}
					return
				}
				t.Fatal("accepted malformed", tc.name)
			}
		})
	}
}

func TestStructuredPlistOutputAndComplexityLimits(t *testing.T) {
	w := &boundWriter{}
	if _, err := w.Write([]byte(strings.Repeat("x", maxPlistBytes))); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("y")); anchorCode(err) != "WORKSPACE_ANCHOR_METADATA_INVALID" {
		t.Fatal("accepted over-limit command output")
	}
	if len(w.data) != maxPlistBytes {
		t.Fatal("over-limit write mutated output")
	}
	nested := validXML()
	nested = strings.Replace(nested, `<key>IgnoredArray</key><array><string>irrelevant</string><dict><key>nested</key><false/></dict></array>`,
		`<key>IgnoredArray</key>`+strings.Repeat("<array>", maxPlistDepth+2)+strings.Repeat("</array>", maxPlistDepth+2), 1)
	if _, err := decodeMetadata([]byte(nested), "/"); err == nil {
		t.Fatal("accepted overly deep plist")
	}
}
