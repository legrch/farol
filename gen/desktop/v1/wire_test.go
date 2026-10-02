package desktop

import (
	"encoding/json"
	"testing"
)

func TestIntegerJSONValueSpellings(t *testing.T) {
	for _, number := range []string{"1", "1.0", "1e0", "10e-1"} {
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
