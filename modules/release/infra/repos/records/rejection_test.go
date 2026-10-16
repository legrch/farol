package records

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestRejectedTargetEncoderPreservesExistingSchema(t *testing.T) {
	for _, identity := range [][2]string{{"0", "1"}, {"18446744073709551615", "18446744073709551615"}, {"0001", "123456789012345678901234567890"}} {
		value := RejectedTarget{Operation: acceptedOperation(), Device: identity[0], Inode: identity[1]}
		value.Operation.Source.Version = "alpha-😀"
		data, err := EncodeRejectedTarget(value)
		if err != nil || len(data) > MaxHelperRecordBytes || !bytes.HasSuffix(data, []byte("\n")) {
			t.Fatalf("encoding: %v", err)
		}
		decoded, err := DecodeRejectedTarget(data, value.Operation)
		if err != nil || !reflect.DeepEqual(decoded, &value) {
			t.Fatalf("existing decoder compatibility: %v", err)
		}
		other := value.Operation
		other.Target.Version += "changed"
		if _, err := DecodeRejectedTarget(data, other); !errors.Is(err, BindingMismatch) {
			t.Fatal("full operation not bound")
		}
	}
}
func TestRejectedTargetEncoderRefusesInvalidClosedValues(t *testing.T) {
	for _, kind := range []string{"id", "source", "target", "device", "inode", "wide", "unicode", "version"} {
		t.Run(kind, func(t *testing.T) {
			value := RejectedTarget{Operation: acceptedOperation(), Device: "1", Inode: "2"}
			switch kind {
			case "id":
				value.Operation.ID = "invalid"
			case "source":
				value.Operation.Source.BuildID = strings.Repeat("F", 64)
			case "target":
				value.Operation.Target.Digest = ""
			case "device":
				value.Device = "+1"
			case "inode":
				value.Inode = "١"
			case "wide":
				value.Inode = strings.Repeat("1", 31)
			case "unicode":
				value.Operation.Target.Version = string([]byte{0xff})
			case "version":
				value.Operation.Source.Version = strings.Repeat("😀", 65)
			}
			if data, err := EncodeRejectedTarget(value); data != nil || err == nil {
				t.Fatal("invalid encoding admitted")
			}
		})
	}
}
func TestRejectedTargetEncoderCannotIntroduceUnknownOrDuplicateFields(t *testing.T) {
	value := RejectedTarget{Operation: acceptedOperation(), Device: "1", Inode: "2"}
	data, err := EncodeRejectedTarget(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"schema", "operationId", "source", "target", "directoryIdentity", "device", "inode"} {
		if bytes.Count(data, []byte(`"`+key+`":`)) != 1 {
			t.Fatal("duplicate or absent field")
		}
	}
	bad := bytes.Replace(data, []byte(`"device":"1"`), []byte(`"device":"1","extra":true`), 1)
	if _, err := DecodeRejectedTarget(bad, value.Operation); err == nil {
		t.Fatal("unknown identity field admitted")
	}
	bad = bytes.Replace(data, []byte(`"version":`), []byte(`"extra":0,"version":`), 1)
	if _, err := DecodeRejectedTarget(bad, value.Operation); err == nil {
		t.Fatal("unknown build field admitted")
	}
	bad = bytes.Replace(data, []byte(`"version":`), []byte(`"version":"\ud800","extra":`), 1)
	if _, err := DecodeRejectedTarget(bad, value.Operation); !errors.Is(err, EncodingInvalid) {
		t.Fatal("invalid Unicode admitted")
	}
}
