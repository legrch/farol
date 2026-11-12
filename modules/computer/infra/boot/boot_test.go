package boot

import (
	"context"
	"testing"
)

func TestBootIdentityStrict(t *testing.T) {
	for _, c := range []string{"", "not-a-uuid", "11111111-1111-4111-8111-111111111111 extra", "00000000-0000-0000-0000-000000000000", "11111111-1111-4111-8111-11111111111z", "11111111-1111-4111-8111-111111111111\x00\x00"} {
		if _, e := canonical(c); e == nil {
			t.Fatalf("accepted %q", c)
		}
	}
	good, e := canonical("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\x00")
	if e != nil || good != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatal(good, e)
	}
	if _, e := New().Current(nil); e == nil {
		t.Fatal("nil context")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := New().Current(ctx); e == nil {
		t.Fatal("cancelled context")
	}
}
