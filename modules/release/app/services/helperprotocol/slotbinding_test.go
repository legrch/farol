package helperprotocol

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type slotCodecFunc func(port.HelperSlotBinding) ([]byte, error)

func (f slotCodecFunc) SlotBinding(v port.HelperSlotBinding) ([]byte, error) { return f(v) }

func TestSlotBindingCapturesOperationAndExplicitLocation(t *testing.T) {
	for _, location := range []string{"legacy", "shared"} {
		r := requestFixture()
		r.InstallLocation = &location
		s := bindFixture(t, r, codecFixture{})
		original := copyRequest(r)
		*r.InstallLocation = "changed"
		r.Source.Version = "changed"
		data := []byte("independent encoded record")
		var seen port.HelperSlotBinding
		out, err := s.BuildSlotBinding(context.Background(), slotCodecFunc(func(v port.HelperSlotBinding) ([]byte, error) {
			seen = v
			return data, nil
		}))
		want := port.HelperSlotBinding{OperationID: original.OperationID, InstallLocation: *original.InstallLocation, Source: original.Source, Target: original.Target}
		if err != nil || !reflect.DeepEqual(seen, want) || string(out) != string(data) {
			t.Fatal("lost original operation binding", seen, out, err)
		}
		data[0] = 'X'
		if string(out) != "independent encoded record" {
			t.Fatal("record aliases codec output")
		}
	}
	// Only an omitted field preserves the original unbound legacy wire behavior.
	r := requestFixture()
	r.InstallLocation = nil
	s := bindFixture(t, r, codecFixture{})
	for range 2 {
		data, err := s.BuildSlotBinding(context.Background(), nil)
		if data != nil || err != nil {
			t.Fatal("absent original location acquired a slot-record requirement")
		}
	}
}

func TestSlotBindingRefusalsAndFinalCancellation(t *testing.T) {
	s := bindFixture(t, requestFixture(), codecFixture{})
	for _, tc := range []struct {
		data     []byte
		err      error
		code     string
		internal bool
	}{
		{nil, nil, "slot_binding_invalid", false},
		{[]byte(strings.Repeat("x", 8193)), nil, "slot_binding_invalid", false},
		{nil, errors.New("helper_protocol_size"), "slot_binding_invalid", false},
		{nil, errors.New("private codec detail"), "internal", true},
	} {
		_, err := s.BuildSlotBinding(context.Background(), slotCodecFunc(func(port.HelperSlotBinding) ([]byte, error) { return tc.data, tc.err }))
		requireFailure(t, err, tc.code, tc.internal)
	}
	_, err := s.BuildSlotBinding(context.Background(), nil)
	requireFailure(t, err, "internal", true)
	_, err = s.BuildSlotBinding(nil, nil)
	requireFailure(t, err, "internal", true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.BuildSlotBinding(ctx, nil)
	requireFailure(t, err, "canceled", false)
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	_, err = s.BuildSlotBinding(ctx, slotCodecFunc(func(port.HelperSlotBinding) ([]byte, error) { cancel(); return []byte("bounded"), nil }))
	requireFailure(t, err, "canceled", false)
}
