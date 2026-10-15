package helperprotocol

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

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

func TestSlotBindingCodecByteBoundIsNotRequestReachability(t *testing.T) {
	// A trusted codec port can return any bytes. This checks the application
	// byte fence only; real request/codepoint bounds live with the input owner.
	s := bindFixture(t, requestFixture(), codecFixture{})
	for _, size := range []int{1, 8192, 8193} {
		t.Run("bytes="+strconv.Itoa(size), func(t *testing.T) {
			data := []byte(strings.Repeat("x", size))
			out, err := s.BuildSlotBinding(context.Background(), slotCodecFunc(func(port.HelperSlotBinding) ([]byte, error) { return data, nil }))
			if size > 8192 {
				requireFailure(t, err, "slot_binding_invalid", false)
				if out != nil {
					t.Fatal("oversize codec bytes escaped refusal")
				}
				return
			}
			if err != nil || len(out) != size {
				t.Fatalf("codec byte boundary: %d %v", len(out), err)
			}
			data[0] = 'y'
			if out[0] != 'x' {
				t.Fatal("returned codec bytes retain alias")
			}
		})
	}
}

func TestSlotBindingDeadlineDeliveredDuringCodecReturn(t *testing.T) {
	s := bindFixture(t, requestFixture(), codecFixture{})
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(time.Second))
	defer cancel()
	called := false
	out, err := s.BuildSlotBinding(ctx, slotCodecFunc(func(port.HelperSlotBinding) ([]byte, error) {
		called = true
		<-ctx.Done()
		return []byte("late codec bytes"), nil
	}))
	requireFailure(t, err, "canceled", false)
	if !called || out != nil || !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("late codec bytes escaped delivered deadline")
	}
}
