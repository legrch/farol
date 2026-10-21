package helperprotocol_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	nativeinput "github.com/legrch/farol/modules/release/infra/native/helperinput"
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

// Frozen vectors are reproduced by a development-only Python AST allowlist.
// No helper module import, entrypoint, selected launcher or effect is executed.
func TestSlotBindingOriginalPythonASTGolden(t *testing.T) {
	const producer = "../../../../../resources/native/update_helper.py"
	original, err := os.ReadFile(producer)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(original)
	if hex.EncodeToString(digest[:]) != "9bd3bf1e06984deeae37cdc61c30063d01b466d26a518952c599fba9c1142c02" {
		t.Fatal("original slot producer source identity changed")
	}
	raw, err := os.ReadFile("testdata/slot-binding-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Source         string `json:"source"`
		SHA256         string `json:"sha256"`
		ProducerCommit string `json:"producerCommit"`
		ProducerBlob   string `json:"producerBlob"`
		Cases          []struct {
			Name             string  `json:"name"`
			Request          string  `json:"request"`
			InputError       string  `json:"inputError"`
			ProducerError    string  `json:"producerError"`
			Bytes            *string `json:"bytes"`
			SlotReads        int     `json:"slotReads"`
			GoError          string  `json:"goError"`
			DomainDifference string  `json:"domainDifference"`
		} `json:"cases"`
		CanonicalCases []struct {
			Name  string `json:"name"`
			Hex   string `json:"hex"`
			Error string `json:"error"`
		} `json:"canonicalCases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Source != "resources/native/update_helper.py" || fixture.SHA256 != hex.EncodeToString(digest[:]) ||
		fixture.ProducerCommit != "bf1d1436990e8f1b230042fd4efe3910738fc78b" ||
		fixture.ProducerBlob != "8d04fed8baeda480212bd27512df0e835ae228d7" || len(fixture.Cases) != 21 || len(fixture.CanonicalCases) != 19 {
		t.Fatal("invalid original slot oracle provenance or corpus")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "python3", "-I", "-B", "-c", slotBindingPythonOracle, producer).CombinedOutput()
	if err != nil {
		t.Fatalf("development Python AST oracle: %v\n%s", err, output)
	}
	var frozen, regenerated any
	if json.Unmarshal(raw, &frozen) != nil || json.Unmarshal(output, &regenerated) != nil || !reflect.DeepEqual(frozen, regenerated) {
		t.Fatal("frozen slot corpus differs from allowlisted original Python AST")
	}
	for _, c := range fixture.Cases {
		t.Run("input/"+c.Name, func(t *testing.T) {
			s, err := protocolapp.Bind(context.Background(), []byte(c.Request), inputapp.New(nativeinput.JSONDecoder{}), helperprotocol.JSONCodec{})
			if c.GoError != "" {
				compositionAppFailure(t, err, c.GoError)
				if s != nil {
					t.Fatal("refused input retained a service")
				}
				if c.GoError != c.InputError && c.DomainDifference == "" {
					t.Fatal("undocumented oracle input-domain difference")
				}
				return
			}
			if err != nil {
				t.Fatalf("real Go input refused original request: %v", err)
			}
			data, err := s.BuildSlotBinding(context.Background(), helperprotocol.JSONCodec{})
			if err != nil {
				t.Fatal(err)
			}
			if c.Bytes == nil {
				if data != nil || c.SlotReads != 0 || c.ProducerError != "slot_binding_invalid" {
					t.Fatal("absent location acquired slot binding/observation")
				}
				return
			}
			if c.SlotReads != 1 || c.ProducerError != "" || !bytes.Equal(data, []byte(*c.Bytes)) {
				t.Fatalf("original producer bytes differ: %q", data)
			}
			if len(data) > 8192 || !bytes.HasSuffix(data, []byte{'\n'}) || bytes.Count(data, []byte{'\n'}) != 1 {
				t.Fatal("slot byte framing/bound changed")
			}
			for _, b := range data {
				if b >= 0x7f {
					t.Fatal("non-ASCII slot byte")
				}
			}
		})
	}
	// Constructor validation uses the production canonical predicate. A real
	// disposable directory is borrowed here, but no native verification is run.
	directory, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	for _, c := range fixture.CanonicalCases {
		t.Run("canonical/"+c.Name, func(t *testing.T) {
			data, err := hex.DecodeString(c.Hex)
			if err != nil {
				t.Fatal(err)
			}
			v, err := slotbinding.NewVerifier(directory, slotbinding.Identity{Device: "1", Inode: "2"}, data, time.Now().Add(time.Minute))
			if c.Error == "" {
				if err != nil || v == nil {
					t.Fatalf("original canonical bytes refused: %v", err)
				}
				return
			}
			var failure *slotbinding.VerificationFailure
			if !errors.As(err, &failure) || failure.Code != c.Error || failure.Internal || v != nil {
				t.Fatalf("canonical refusal %v, want %s", err, c.Error)
			}
		})
	}
}

const slotBindingPythonOracle = `
import ast
import copy
import hashlib
import io
import json
import pathlib
import posixpath
import sys
import types

source = pathlib.Path(sys.argv[1]).read_bytes()
digest = "9bd3bf1e06984deeae37cdc61c30063d01b466d26a518952c599fba9c1142c02"
assert hashlib.sha256(source).hexdigest() == digest, "original producer changed"
functions = ["fail", "slot_binding_bytes", "canonical_slot_binding", "verify_slot_binding",
             "components", "valid_inode", "parse_request"]
constants = ["MAX_RECORD", "SLOT_SCHEMA"]
nodes = []
for node in ast.parse(source).body:
    if isinstance(node, ast.FunctionDef) and node.name in functions:
        nodes.append(node)
    elif isinstance(node, ast.ClassDef) and node.name == "Refusal":
        nodes.append(node)
    elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in constants:
        nodes.append(node)
assert len(nodes) == len(functions) + len(constants) + 1
# Never import/execute the helper module or its entrypoint. Only fd3 reads and
# slot reads are substituted, in memory; all validation/encoding is original AST.
feed = io.BytesIO()
slot_reads = []
slot_data = b""
def read(fd, size):
    assert fd == 3
    return feed.read(size)
def read_slot(fd):
    assert fd == 99
    slot_reads.append(fd)
    return slot_data
scope = {"json": json, "os": types.SimpleNamespace(read=read, path=posixpath,
         fsencode=lambda s: s.encode("utf-8", "surrogateescape")), "read_slot_binding": read_slot}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "original-slot-allowlist", "exec"), scope)

base = {"schema": "farol.installed-update/1", "action": "apply", "home": "/synthetic/home",
        "operationId": "1" * 32,
        "source": {"digest": "2" * 64, "version": "1.0", "buildId": "3" * 64},
        "target": {"digest": "4" * 64, "version": "1.1", "buildId": "5" * 64},
        "drain": {"status": "reconciled", "acceptedSource": "3" * 64, "acceptedTarget": "5" * 64},
        "pid": 2345, "processStart": "synthetic parent start", "waitSeconds": 30,
        "relaunch": True, "installLocation": "shared"}
def compact(v):
    return json.dumps(v, separators=(",", ":"), ensure_ascii=True)
def refusal(fn):
    try:
        return fn(), ""
    except scope["Refusal"] as error:
        return None, error.code
cases = []
def case(name, mutate=lambda r: None, raw=None, go_error=None, difference=""):
    global feed, slot_data
    request = copy.deepcopy(base)
    mutate(request)
    wire = compact(request) if raw is None else raw
    feed = io.BytesIO(wire.encode("ascii"))
    parsed, error = refusal(scope["parse_request"])
    encoded = None
    producer_error = ""
    reads = 0
    if not error:
        data, producer_error = refusal(lambda: scope["slot_binding_bytes"](parsed))
        slot_data = data or b""
        slot_reads.clear()
        scope["verify_slot_binding"](99, parsed)
        reads = len(slot_reads)
        if "installLocation" in parsed:
            assert not producer_error
            scope["canonical_slot_binding"](data)
            encoded = data.decode("ascii")
    cases.append({"name": name, "request": wire, "inputError": error,
                  "producerError": producer_error, "bytes": encoded, "slotReads": reads,
                  "goError": error if go_error is None else go_error, "domainDifference": difference})

case("shared")
case("explicit-legacy", lambda r: r.update(installLocation="legacy"))
case("absent-location", lambda r: r.pop("installLocation"))
case("unicode-controls", lambda r: r["source"].update(version='<>&\x00\b\f\n\r\t"\\/\x7fé😀\u2028\u2029'))
case("version-one", lambda r: r["source"].update(version="x"))
case("version-128", lambda r: r["source"].update(version="x" * 128))
case("version-128-astral", lambda r: (r["source"].update(version="😀" * 128), r["target"].update(version="😀" * 128)))
case("version-empty", lambda r: r["source"].update(version=""))
case("version-129", lambda r: r["source"].update(version="x" * 129))
case("version-null", lambda r: r["target"].update(version=None))
case("uppercase-digest", lambda r: r["source"].update(digest="A" * 64))
case("short-operation", lambda r: r.update(operationId="1" * 31))
case("nested-extra", lambda r: r["source"].update(extra=True))
case("unknown-location", lambda r: r.update(installLocation="elsewhere"))
case("null-location", lambda r: r.update(installLocation=None))
case("envelope-extra", lambda r: r.update(extra=True))
case("acceptance-mismatch", lambda r: r["drain"].update(acceptedTarget="6" * 64))
case("malformed-json", raw="{")
case("trailing-json", raw=compact(base) + "{}")
for name, value in [("unpaired-high-surrogate", "\ud800"), ("unpaired-low-surrogate", "\udfff")]:
    case(name, lambda r, v=value: r["source"].update(version=v), go_error="input",
         difference="Python accepts escaped unpaired UTF-16; Go input intentionally rejects it before string replacement")

canonical = []
def canonical_case(name, data):
    _, error = refusal(lambda: scope["canonical_slot_binding"](data))
    canonical.append({"name": name, "hex": data.hex(), "error": error})
for c in cases:
    if c["bytes"] is not None:
        canonical_case(c["name"], c["bytes"].encode("ascii"))
good = cases[0]["bytes"].encode("ascii")
canonical_case("missing-newline", good[:-1])
canonical_case("extra-newline", good + b"\n")
canonical_case("nested-key-order", good.replace(b'{"buildId":', b'{"digest":', 1).replace(b',"digest":', b',"buildId":', 1))
value = json.loads(good)
canonical_case("root-key-order", (compact(dict(reversed(list(value.items())))) + "\n").encode("ascii"))
canonical_case("pretty-json", (json.dumps(value, indent=2) + "\n").encode("ascii"))
canonical_case("wrong-schema", good.replace(b"operation-slot/1", b"operation-slot/2"))
canonical_case("extra-field", good[:-2] + b',"extra":true}\n')
canonical_case("malformed-utf8", b"\xff")
canonical_case("empty", b"")
canonical_case("8192-invalid-bytes", b"x" * 8192)
canonical_case("8193-invalid-bytes", b"x" * 8193)
print(json.dumps({"source": "resources/native/update_helper.py", "sha256": digest,
    "producerCommit": "bf1d1436990e8f1b230042fd4efe3910738fc78b",
    "producerBlob": "8d04fed8baeda480212bd27512df0e835ae228d7",
    "extraction": {"functions": functions, "classes": ["Refusal"], "constants": constants,
        "substitutions": ["fd3 read from in-memory bytes", "slot read from in-memory expected bytes"],
        "limits": "Development Python pure AST oracle; synthetic requests only; no helper entrypoint, native custody, runtime selection or Python retirement evidence"},
    "cases": cases, "canonicalCases": canonical}, indent=2, ensure_ascii=True))
`
