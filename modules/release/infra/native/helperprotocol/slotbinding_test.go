package helperprotocol_test

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/slotbinding"
	"golang.org/x/sys/unix"
)

func TestSlotBindingCodecCanonicalKeyOrderAndASCII(t *testing.T) {
	value := port.HelperSlotBinding{
		OperationID: strings.Repeat("1", 32), InstallLocation: "shared",
		Source: port.HelperBuild{Digest: strings.Repeat("2", 64), BuildID: strings.Repeat("3", 64), Version: "<>&\x7f\u00e9\U0001f600\n"},
		Target: port.HelperBuild{Digest: strings.Repeat("4", 64), BuildID: strings.Repeat("5", 64), Version: "1.1"},
	}
	build := func(id, digest, version string) string {
		return `{"buildId":"` + id + `","digest":"` + digest + `","version":"` + version + `"}`
	}
	want := `{"installLocation":"shared","operationId":"` + value.OperationID + `","schema":"farol.installed-operation-slot/1","source":` +
		build(value.Source.BuildID, value.Source.Digest, `<>&\u007f\u00e9\ud83d\ude00\n`) + `,"target":` +
		build(value.Target.BuildID, value.Target.Digest, "1.1") + "}\n"
	got, err := (helperprotocol.JSONCodec{}).SlotBinding(value)
	if err != nil || string(got) != want {
		t.Fatalf("canonical slot record mismatch: %q, %v", got, err)
	}
	value.Source.Version = string([]byte{0xff})
	if _, err := (helperprotocol.JSONCodec{}).SlotBinding(value); err == nil {
		t.Fatal("invalid UTF-8 encoded")
	}
	value.Source.Version = strings.Repeat("x", 8193)
	if _, err := (helperprotocol.JSONCodec{}).SlotBinding(value); err == nil {
		t.Fatal("unbounded codec input encoded")
	}
}

// Real Go input validation and the existing Go publisher are composed with the
// new read-only verifier. Only a disposable directory is real; request process,
// predecessor and install identities are synthetic, never native admission.
func TestSlotBindingRealInputPublicationAndExpectedRead(t *testing.T) {
	ctx := context.Background()
	s := compositionBind(t, ctx)
	data, err := s.BuildSlotBinding(ctx, helperprotocol.JSONCodec{})
	if err != nil || len(data) == 0 {
		t.Fatal("bound record", err)
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	publisher, err := slotbinding.New(f)
	if err != nil {
		t.Fatal(err)
	}
	result, err := publisher.Publish(ctx, data)
	if err != nil || result.Decision != port.SlotBindingConfirmed {
		t.Fatal("existing publisher", result, err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &st); err != nil {
		t.Fatal(err)
	}
	identity := slotbinding.Identity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}
	v, err := slotbinding.NewVerifier(f, identity, data, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Verify(ctx); err != nil {
		t.Fatal("published expected record not observed", err)
	}
	for _, wrong := range [][]byte{
		bytes.Replace(data, []byte(`"shared"`), []byte(`"legacy"`), 1),
		bytes.Replace(data, []byte(strings.Repeat("1", 32)), []byte(strings.Repeat("a", 32)), 1),
		bytes.Replace(data, []byte(strings.Repeat("2", 64)), []byte(strings.Repeat("b", 64)), 1),
	} {
		v, err := slotbinding.NewVerifier(f, identity, wrong, time.Now().Add(time.Minute))
		if err != nil {
			t.Fatal("structurally valid alternate record", err)
		}
		if err := v.Verify(ctx); err == nil {
			t.Fatal("accepted another location, operation or build")
		}
	}
}
