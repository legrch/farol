package appidentity

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

func parsePlist(raw []byte, b *budget) (any, error) {
	if bytes.HasPrefix(raw, []byte("bplist00")) {
		return parseBinary(raw, b)
	}
	return parseXML(raw, b)
}
func utf16Text(raw []byte, order binary.ByteOrder) (string, bool) {
	if len(raw)%2 != 0 {
		return "", false
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = order.Uint16(raw[i*2:])
	}
	for i := 0; i < len(u); i++ {
		if u[i] >= 0xdc00 && u[i] <= 0xdfff {
			return "", false
		}
		if u[i] >= 0xd800 && u[i] <= 0xdbff {
			i++
			if i >= len(u) || u[i] < 0xdc00 || u[i] > 0xdfff {
				return "", false
			}
		}
	}
	return string(utf16.Decode(u)), true
}

type xmlParser struct {
	d *xml.Decoder
	b *budget
}

func parseXML(raw []byte, b *budget) (any, error) {
	converted := false
	endian := ""
	if len(raw) >= 2 && (bytes.Equal(raw[:2], []byte{0xff, 0xfe}) || bytes.Equal(raw[:2], []byte{0xfe, 0xff})) {
		var order binary.ByteOrder = binary.BigEndian
		if raw[0] == 0xff {
			order = binary.LittleEndian
			endian = "utf-16le"
		}
		if endian == "" {
			endian = "utf-16be"
		}
		s, ok := utf16Text(raw[2:], order)
		if !ok {
			return nil, refusal(InvalidPlist)
		}
		raw = []byte(s)
		converted = true
	} else {
		raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	}
	if !utf8.Valid(raw) {
		return nil, refusal(InvalidPlist)
	}
	d := xml.NewDecoder(bytes.NewReader(raw))
	d.CharsetReader = func(name string, r io.Reader) (io.Reader, error) {
		if converted && (strings.EqualFold(name, "utf-16") || strings.EqualFold(name, "utf-16le") || strings.EqualFold(name, "utf-16be")) {
			return r, nil
		}
		return nil, refusal(InvalidPlist)
	}
	p := xmlParser{d: d, b: b}
	doctype := false
	seenPrefix := false
	var root xml.StartElement
	for {
		t, e := d.Token()
		if e != nil {
			return nil, refusal(InvalidPlist)
		}
		if e = b.check(); e != nil {
			return nil, e
		}
		switch v := t.(type) {
		case xml.StartElement:
			root = v
			goto start
		case xml.CharData:
			if strings.Trim(string(v), " \t\r\n") != "" {
				return nil, refusal(InvalidPlist)
			}
		case xml.Directive:
			if doctype || strings.Join(strings.FieldsFunc(strings.ReplaceAll(string(v), "'", "\""), func(r rune) bool { return r == ' ' || r == '\t' || r == '\r' || r == '\n' }), " ") != `DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"` {
				return nil, refusal(InvalidPlist)
			}
			doctype = true
		case xml.Comment:
		case xml.ProcInst:
			if seenPrefix || v.Target != "xml" || !xmlDeclaration(v.Inst, converted, endian) {
				return nil, refusal(InvalidPlist)
			}
		default:
			return nil, refusal(InvalidPlist)
		}
		seenPrefix = true
	}
start:
	if root.Name.Space != "" || root.Name.Local != "plist" || len(root.Attr) > 1 {
		return nil, refusal(InvalidPlist)
	}
	if len(root.Attr) == 1 && (root.Attr[0].Name.Space != "" || root.Attr[0].Name.Local != "version" || root.Attr[0].Value != "1.0") {
		return nil, refusal(InvalidPlist)
	}
	t, e := p.next()
	if e != nil {
		return nil, e
	}
	s, ok := t.(xml.StartElement)
	if !ok {
		return nil, refusal(InvalidPlist)
	}
	v, e := p.value(s, 0)
	if e != nil {
		return nil, e
	}
	t, e = p.next()
	if e != nil {
		return nil, e
	}
	if t != root.End() {
		return nil, refusal(InvalidPlist)
	}
	for {
		t, e = d.Token()
		if e == io.EOF {
			return v, nil
		}
		if e != nil {
			return nil, refusal(InvalidPlist)
		}
		switch x := t.(type) {
		case xml.Comment:
		case xml.CharData:
			if strings.Trim(string(x), " \t\r\n") != "" {
				return nil, refusal(InvalidPlist)
			}
		default:
			return nil, refusal(InvalidPlist)
		}
	}
}
func (p *xmlParser) next() (xml.Token, error) {
	for {
		if e := p.b.check(); e != nil {
			return nil, e
		}
		t, e := p.d.Token()
		if e != nil {
			return nil, refusal(InvalidPlist)
		}
		switch v := t.(type) {
		case xml.Comment:
			continue
		case xml.CharData:
			if strings.Trim(string(v), " \t\r\n") == "" {
				continue
			}
		}
		return t, nil
	}
}
func (p *xmlParser) text(s xml.StartElement) (string, error) {
	var out strings.Builder
	for {
		if e := p.b.check(); e != nil {
			return "", e
		}
		t, e := p.d.Token()
		if e != nil {
			return "", refusal(InvalidPlist)
		}
		switch v := t.(type) {
		case xml.CharData:
			if e = p.b.add(0, len(v)); e != nil {
				return "", e
			}
			out.Write(v)
		case xml.Comment:
		case xml.EndElement:
			if v == s.End() {
				return out.String(), nil
			}
			return "", refusal(InvalidPlist)
		default:
			return "", refusal(InvalidPlist)
		}
	}
}
func (p *xmlParser) value(s xml.StartElement, depth int) (any, error) {
	if e := p.b.node(depth); e != nil {
		return nil, e
	}
	if s.Name.Space != "" || len(s.Attr) != 0 {
		return nil, refusal(InvalidPlist)
	}
	switch s.Name.Local {
	case "dict":
		m := map[string]any{}
		for {
			t, e := p.next()
			if e != nil {
				return nil, e
			}
			if t == s.End() {
				return m, nil
			}
			k, ok := t.(xml.StartElement)
			if !ok || k.Name.Space != "" || k.Name.Local != "key" || len(k.Attr) != 0 {
				return nil, refusal(InvalidPlist)
			}
			if e = p.b.node(depth + 1); e != nil {
				return nil, e
			}
			key, e := p.text(k)
			if e != nil {
				return nil, e
			}
			if _, ok = m[key]; ok {
				return nil, refusal(InvalidPlist)
			}
			if e = p.b.add(2, 0); e != nil {
				return nil, e
			}
			t, e = p.next()
			if e != nil {
				return nil, e
			}
			v, ok := t.(xml.StartElement)
			if !ok {
				return nil, refusal(InvalidPlist)
			}
			m[key], e = p.value(v, depth+1)
			if e != nil {
				return nil, e
			}
		}
	case "array":
		var a []any
		for {
			t, e := p.next()
			if e != nil {
				return nil, e
			}
			if t == s.End() {
				return a, nil
			}
			v, ok := t.(xml.StartElement)
			if !ok {
				return nil, refusal(InvalidPlist)
			}
			if e = p.b.add(1, 0); e != nil {
				return nil, e
			}
			n, e := p.value(v, depth+1)
			if e != nil {
				return nil, e
			}
			a = append(a, n)
		}
	}
	text, e := p.text(s)
	if e != nil {
		return nil, e
	}
	trim := strings.TrimSpace(text)
	switch s.Name.Local {
	case "string":
		return text, nil
	case "true", "false":
		if text == "" {
			return s.Name.Local == "true", nil
		}
	case "integer":
		base := 10
		n := trim
		if strings.HasPrefix(n, "0x") {
			base = 16
			n = n[2:]
			if len(n) == 0 || n[0] == '+' || n[0] == '-' {
				return nil, refusal(InvalidPlist)
			}
		}
		if _, ok := new(big.Int).SetString(n, base); ok {
			return struct{}{}, nil
		}
	case "real":
		if strings.ContainsAny(trim, "xXpP_") {
			return nil, refusal(InvalidPlist)
		}
		if n, e := strconv.ParseFloat(trim, 64); e == nil && !math.IsInf(n, 0) && !math.IsNaN(n) {
			return struct{}{}, nil
		}
	case "date":
		if n, e := time.Parse("2006-01-02T15:04:05Z", text); e == nil && n.Year() >= 1 {
			return struct{}{}, nil
		}
	case "data":
		compact := strings.Join(strings.Fields(text), "")
		data, e := base64.StdEncoding.Strict().DecodeString(compact)
		if e == nil {
			if e = p.b.add(0, len(data)); e != nil {
				return nil, e
			}
			return data, nil
		}
	}
	return nil, refusal(InvalidPlist)
}

// encoding/xml does not validate declaration placement or pseudo-attributes.
func xmlDeclaration(inst []byte, converted bool, endian string) bool {
	if bytes.ContainsAny(inst, "&<>") {
		return false
	}
	d := xml.NewDecoder(bytes.NewReader(append(append([]byte("<declaration "), inst...), []byte("/>")...)))
	token, e := d.Token()
	if e != nil {
		return false
	}
	s, ok := token.(xml.StartElement)
	if !ok || len(s.Attr) == 0 || len(s.Attr) > 3 {
		return false
	}
	if s.Attr[0].Name.Space != "" || s.Attr[0].Name.Local != "version" || s.Attr[0].Value != "1.0" {
		return false
	}
	pos := 1
	if pos < len(s.Attr) && s.Attr[pos].Name.Local == "encoding" {
		a := s.Attr[pos]
		if a.Name.Space != "" {
			return false
		}
		name := strings.ToLower(a.Value)
		if converted {
			if name != "utf-16" && name != endian {
				return false
			}
		} else if name != "utf-8" {
			return false
		}
		pos++
	}
	if pos < len(s.Attr) && s.Attr[pos].Name.Local == "standalone" {
		a := s.Attr[pos]
		if a.Name.Space != "" || (a.Value != "yes" && a.Value != "no") {
			return false
		}
		pos++
	}
	if pos != len(s.Attr) {
		return false
	}
	token, e = d.Token()
	if e != nil || token != s.End() {
		return false
	}
	_, e = d.Token()
	return e == io.EOF
}
