package git

import (
	"bytes"
	"io"
	"strings"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

type advertisement struct {
	rows         [][]byte
	capabilities map[string]bool
}

func readAdvertisement(r io.Reader, in egress.Intent) (*advertisement, error) {
	ad := &advertisement{capabilities: map[string]bool{}}
	seen := map[string]bool{}
	total := 0
	target := ""
	empty := false
	version := false
	for {
		line, flush, err := readPacket(r)
		if err != nil {
			return nil, err
		}
		total += len(line) + 4
		if total > in.Limits.AdvertisementBytes {
			return nil, ErrLimit
		}
		if flush {
			break
		}
		line = bytes.TrimSuffix(line, []byte{'\n'})
		if len(ad.rows) == 0 && !version && string(line) == "version 1" {
			version = true
			continue
		}
		if len(ad.rows) >= in.Limits.RefCount {
			return nil, ErrLimit
		}
		if bytes.HasPrefix(line, []byte("ERR ")) {
			return nil, ErrRemote
		}
		parts := bytes.Split(line, []byte{0})
		if len(ad.rows) == 0 {
			if len(parts) != 2 {
				return nil, ErrProtocol
			}
			for _, c := range strings.Fields(string(parts[1])) {
				if ad.capabilities[c] || len(c) > 256 {
					return nil, ErrProtocol
				}
				for _, b := range c {
					if b < 33 || b > 126 {
						return nil, ErrProtocol
					}
				}
				ad.capabilities[c] = true
			}
		} else if len(parts) != 1 {
			return nil, ErrProtocol
		}
		fields := strings.Split(string(parts[0]), " ")
		if len(fields) != 2 || !egress.ValidOID(in.Format, fields[0], true) {
			return nil, ErrProtocol
		}
		id, ref := fields[0], fields[1]
		if seen[ref] {
			return nil, ErrProtocol
		}
		seen[ref] = true
		if ref == "capabilities^{}" {
			if len(ad.rows) != 0 || !egress.IsZero(id) {
				return nil, ErrProtocol
			}
			empty = true
		} else if empty || egress.IsZero(id) || (!egress.ValidRef(strings.TrimSuffix(ref, "^{}")) && ref != ".have") {
			return nil, ErrProtocol
		}
		if ref == in.Ref {
			target = id
		}
		ad.rows = append(ad.rows, bytes.Clone(parts[0]))
	}
	if len(ad.rows) == 0 || !ad.capabilities["report-status"] {
		return nil, ErrProtocol
	}
	for c := range ad.capabilities {
		if strings.HasPrefix(c, "object-format=") && c != "object-format="+in.Format {
			return nil, ErrProtocol
		}
	}
	if in.Format == "sha256" && !ad.capabilities["object-format=sha256"] {
		return nil, ErrProtocol
	}
	if egress.IsZero(in.Old) {
		if target != "" {
			return nil, ErrRemote
		}
	} else if target != in.Old {
		return nil, ErrRemote
	}
	// Only these negotiated features enter the managed v0 push. In particular,
	// no push options, signed-push certificates, deletes or sideband protocol.
	selected := map[string]bool{"report-status": true}
	for _, c := range []string{"ofs-delta", "atomic", "object-format=" + in.Format} {
		if ad.capabilities[c] {
			selected[c] = true
		}
	}
	ad.capabilities = selected
	return ad, nil
}
func (ad *advertisement) writeTo(w io.Writer) error {
	caps := []string{"report-status"}
	for _, c := range []string{"ofs-delta", "atomic", "object-format=sha1", "object-format=sha256"} {
		if ad.capabilities[c] {
			caps = append(caps, c)
		}
	}
	for i, row := range ad.rows {
		line := bytes.Clone(row)
		if i == 0 {
			line = append(line, 0)
			line = append(line, []byte(strings.Join(caps, " "))...)
		}
		line = append(line, '\n')
		wire, err := packet(line)
		if err != nil {
			return err
		}
		if _, err = writeAll(w, wire); err != nil {
			return err
		}
	}
	_, err := writeAll(w, []byte("0000"))
	return err
}
func readUpdate(r io.Reader, in egress.Intent, ad *advertisement) ([]byte, bool, error) {
	line, flush, err := readPacket(r)
	if err != nil {
		return nil, false, err
	}
	if flush {
		return nil, true, nil
	}
	line = bytes.TrimSuffix(line, []byte{'\n'})
	parts := bytes.Split(line, []byte{0})
	if len(parts) != 2 {
		return nil, false, ErrProtocol
	}
	if string(parts[0]) != in.Old+" "+in.Head+" "+in.Ref || in.Old == in.Head {
		return nil, false, ErrScope
	}
	// Native send-pack prefixes its capabilities with one ASCII space.
	// Accept that documented deployed spelling, not general whitespace.
	caps := strings.Split(strings.TrimPrefix(string(parts[1]), " "), " ")
	seen := map[string]bool{}
	for _, c := range caps {
		if seen[c] || !ad.capabilities[c] {
			return nil, false, ErrProtocol
		}
		seen[c] = true
	}
	if !seen["report-status"] {
		return nil, false, ErrProtocol
	}
	if in.Format == "sha256" && !seen["object-format=sha256"] {
		return nil, false, ErrProtocol
	}
	_, flush, err = readPacket(r)
	if err != nil {
		return nil, false, err
	}
	if !flush {
		return nil, false, ErrScope
	}
	// Re-encode only the one validated command. Never relay the untrusted
	// client's entire prelude or any additional/implicit refspec.
	// A fixed upstream prelude removes client-controlled capability ordering,
	// whitespace and irrelevant compression choices from the external effect.
	upstreamCaps := []string{"report-status"}
	if ad.capabilities["atomic"] {
		upstreamCaps = append(upstreamCaps, "atomic")
	}
	if ad.capabilities["object-format="+in.Format] {
		upstreamCaps = append(upstreamCaps, "object-format="+in.Format)
	}
	wire, err := packet([]byte(in.Old + " " + in.Head + " " + in.Ref + "\x00" + strings.Join(upstreamCaps, " ") + "\n"))
	if err != nil {
		return nil, false, err
	}
	return append(wire, []byte("0000")...), false, nil
}

func readStatus(r io.Reader, ref string) (bool, []byte, error) {
	unpack, flush, err := readPacket(r)
	if err != nil {
		return false, nil, err
	}
	if flush || len(unpack) > 2048 {
		return false, nil, ErrProtocol
	}
	unpack = bytes.TrimSuffix(unpack, []byte{'\n'})
	if bytes.HasPrefix(unpack, []byte("ERR ")) {
		return false, nil, ErrRemote // the remote refused the session instead of reporting
	}
	if !bytes.HasPrefix(unpack, []byte("unpack ")) || len(unpack) <= 7 {
		return false, nil, ErrProtocol
	}
	status, flush, err := readPacket(r)
	if err != nil {
		return false, nil, err
	}
	if flush || len(status) > 2048 {
		return false, nil, ErrProtocol
	}
	status = bytes.TrimSuffix(status, []byte{'\n'})
	accepted := string(status) == "ok "+ref
	if !accepted && !strings.HasPrefix(string(status), "ng "+ref+" ") {
		return false, nil, ErrProtocol
	}
	if accepted && string(unpack) != "unpack ok" {
		return false, nil, ErrProtocol
	}
	_, flush, err = readPacket(r)
	if err != nil {
		return false, nil, err
	}
	if !flush {
		return false, nil, ErrProtocol
	}
	// Remote text is untrusted and may contain secrets/terminal escapes. Return
	// a closed failure reason rather than persisting or echoing arbitrary text.
	one := []byte("unpack ok\n")
	two := []byte("ok " + ref + "\n")
	if !accepted {
		if string(unpack) != "unpack ok" {
			one = []byte("unpack remote rejection\n")
		}
		two = []byte("ng " + ref + " remote rejection\n")
	}
	a, _ := packet(one)
	b, _ := packet(two)
	return accepted, append(append(a, b...), []byte("0000")...), nil
}
