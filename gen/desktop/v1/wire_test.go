package desktop

import (
	"encoding/json"
	"testing"
)

func TestIntegerJSONValueSpellings(t *testing.T) {
	for _, number := range []string{"1", "1.0", "1e0", "10e-1", "1.00000000000000001", "0.99999999999999999"} {
		raw := []byte(`{"protocolMajor":` + number + `,"protocolMinor":0.0,"buildId":"build","profileId":"test"}`)
		if err := Validate("Handshake", raw); err != nil {
			t.Fatalf("%s: %v", number, err)
		}
		var hello Handshake
		if err := json.Unmarshal(raw, &hello); err != nil || hello.ProtocolMajor != 1 || hello.ProtocolMinor != 0 {
			t.Fatalf("typed %s: %+v %v", number, hello, err)
		}
	}
	for _, number := range []string{"1.5", "-1", "4294967296", "1e1000"} {
		raw := []byte(`{"protocolMajor":` + number + `,"protocolMinor":0,"buildId":"build","profileId":"test"}`)
		var hello Handshake
		if Validate("Handshake", raw) == nil || json.Unmarshal(raw, &hello) == nil {
			t.Fatalf("admitted %s", number)
		}
	}
	for _, number := range []string{"-32600", "-32600.0", "-3.26e4"} {
		raw := []byte(`{"code":` + number + `,"message":"invalid request"}`)
		var fault Fault
		if Validate("Fault", raw) != nil || json.Unmarshal(raw, &fault) != nil || fault.Code != -32600 {
			t.Fatalf("fault %s: %+v", number, fault)
		}
	}
}

func TestTimestampGrammar(t *testing.T) {
	for _, value := range []string{"0001-01-01T00:00:00Z", "2024-02-29T12:00:00Z", "2026-10-02T12:00:00.1Z", "2026-10-02T12:00:00.123456789Z"} {
		raw, _ := json.Marshal(value)
		if err := Validate("utc", raw); err != nil {
			t.Fatalf("valid %q: %v", value, err)
		}
	}
	for _, value := range []string{"0000-01-01T00:00:00Z", "2023-02-29T12:00:00Z", "2026-10-02T12:00:00.1234567890Z", "2026-10-02T12:00:00,1Z", "2026-10-02T12:00:00.Z", "2026-10-02T12:00:00+00:00", "2026-10-02T12:00:00Z\n"} {
		raw, _ := json.Marshal(value)
		if Validate("utc", raw) == nil {
			t.Fatalf("invalid %q admitted", value)
		}
	}
}
