//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"

	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"golang.org/x/sys/unix"
)

// LaunchServices starts the production CGO-free launcher and real Electron;
// Electron uses the built production lifetime-channel adapter and the real
// fd3/4 protocol to dispatch the Go live helper. Its explicitly bound home and
// app trees are disposable; the desktop adapter's OS-home selection is not used.
// No window, owner state, shared slot or package acceptance.
func TestDesktopLauncherNativeRelaunchAfterHelper(t *testing.T) {
	if os.Getenv("FAROL_DESKTOP_LAUNCHER_NATIVE") != "1" {
		t.Skip("explicit hidden LaunchServices lane required")
	}
	liveNativeRequire(t)
	electron := os.Getenv("FAROL_TEST_HELPER_ELECTRON")
	adapter := os.Getenv("FAROL_TEST_LIFETIME_MODULE")
	if !filepath.IsAbs(electron) || !filepath.IsAbs(adapter) {
		t.Fatal("explicit reviewed runtime and built production adapter required")
	}
	f := newLiveNativeFixture(t, true)
	// No t.TempDir cleanup: any unknown process/effect retains this root.
	t.Log("LaunchServices witness:", f.dir)
	// LaunchServices resolves the app through a separate service. Keep fixture
	// records private while allowing traversal to the bundle and its executable.
	if err := os.Chmod(f.dir, 0711); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(f.dir, "Farol Lifetime Witness.app")
	contents := filepath.Join(app, "Contents")
	resources := filepath.Join(contents, "Resources", "app")
	for _, p := range []string{resources, filepath.Join(contents, "MacOS"), filepath.Join(contents, "Frameworks")} {
		if err := os.MkdirAll(p, 0755); err != nil {
			t.Fatal(err)
		}
	}
	binary, err := os.ReadFile(execNativeCompiled(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "farol-backend"), binary, 0555); err != nil {
		t.Fatal(err)
	}
	// Runtime is an explicit fixture input. This is not a candidate package.
	if err := os.Symlink(filepath.Dir(filepath.Dir(filepath.Dir(electron))), filepath.Join(contents, "Frameworks", "Electron Runtime.app")); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Farol</string><key>CFBundleIdentifier</key><string>io.github.legrch.farol.lifetime-witness.` + filepath.Base(f.dir) + `</string><key>CFBundleName</key><string>Farol Lifetime Witness</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>CFBundleShortVersionString</key><string>0.5.16</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>CFBundleDevelopmentRegion</key><string>en</string><key>CFBundleVersion</key><string>1</string></dict></plist>`
	launcher := "#!/bin/sh\nexec \"" + filepath.Join(resources, "farol-backend") + "\" run-desktop-launcher 2>\"" + filepath.Join(f.dir, "guardian.log") + "\"\n"
	for p, data := range map[string]string{filepath.Join(contents, "Info.plist"): plist, filepath.Join(contents, "MacOS", "Farol"): launcher, filepath.Join(resources, "package.json"): `{"name":"farol-lifetime-witness","main":"index.cjs"}`} {
		mode := os.FileMode(0644)
		if p == filepath.Join(contents, "MacOS", "Farol") {
			mode = 0755
		}
		if err := os.WriteFile(p, []byte(data), mode); err != nil {
			t.Fatal(err)
		}
	}
	const source = `const {app}=require('electron'); const fs=require('node:fs'); const path=require('node:path'); const {execFileSync}=require('node:child_process');
const root=ROOT; const adapter=ADAPTER; app.setPath('userData',path.join(root,'electron-profile'));
app.whenReady().then(()=>{app.dock?.hide(); let started=false;
const watcher=fs.watch(root,()=>{if(started||!fs.existsSync(path.join(root,'plan.json')))return; started=true; watcher.close();
(async()=>{const plan=JSON.parse(fs.readFileSync(path.join(root,'plan.json'),'utf8')); const api=require(adapter);
const lifetime=api.createDesktopHelperLifetime(); if(!lifetime.available())throw Error('fixture guardian unavailable');
const out=fs.openSync(path.join(root,'terminal.json'),'wx',0o600), err=fs.openSync(path.join(root,'helper.stderr'),'wx',0o600);
const child=require('node:child_process').spawn(plan.binary,['run-live-release-helper'],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},detached:true,stdio:['ignore',out,err,'pipe','pipe']});
fs.closeSync(out);fs.closeSync(err);child.unref();
const helper={pid:child.pid,processStart:execFileSync('/bin/ps',['-p',String(child.pid),'-o','lstart='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}).trim()};
fs.writeFileSync(path.join(root,'helper.json'),JSON.stringify(helper),{mode:0o600});
await lifetime.retain(plan.request,helper,Date.now()+15000);
child.stdio[3].end(JSON.stringify(plan.request)+'\n');
const frame=await new Promise((resolve,reject)=>{let text='';child.stdio[4].on('data',b=>{text+=b;});child.stdio[4].on('error',reject);child.stdio[4].on('end',()=>resolve(JSON.parse(text)));});
fs.writeFileSync(path.join(root,'handoff.json'),JSON.stringify(frame),{mode:0o600});
if(frame.phase!=='waiting_for_exit')throw Error('fixture handoff not ready');
fs.writeFileSync(path.join(plan.state,'last-quit.json'),JSON.stringify({schema:1,at:new Date().toISOString(),drained:true,unconfirmed:[]}),{mode:0o600});
fs.unlinkSync(path.join(plan.state,'running.json')); app.quit();
})().catch(e=>{fs.writeFileSync(path.join(root,'fixture-error'),String(e));app.exit(79);});});
const start=execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).trim();
fs.writeFileSync(path.join(root,'desktop.json'),JSON.stringify({pid:process.pid,start,parent:process.ppid}),{mode:0o600});});`
	script := strings.ReplaceAll(strings.ReplaceAll(source, "ROOT", string(closedHelperJSON(t, f.dir))), "ADAPTER", string(closedHelperJSON(t, adapter)))
	if err := os.WriteFile(filepath.Join(resources, "index.cjs"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	targetDigest := desktopWitnessTarget(t, f, electron)
	// -g starts the old fixture hidden. The helper's later launch uses the
	// production relaunch arguments and the newly installed canonical slot.
	if output, err := exec.Command("/usr/bin/open", "-g", "-a", app).CombinedOutput(); err != nil {
		t.Fatalf("fixture open: %v %s", err, output)
	}
	var desktop struct {
		PID    int    `json:"pid"`
		Start  string `json:"start"`
		Parent int    `json:"parent"`
	}
	until := time.Now().Add(90 * time.Second)
	waitFile := func(name string) []byte {
		t.Helper()
		for time.Now().Before(until) {
			if b, err := os.ReadFile(filepath.Join(f.dir, name)); err == nil {
				return b
			}
			time.Sleep(10 * time.Millisecond)
		}
		var evidence []string
		for _, filename := range []string{"guardian.log", "fixture-error", "helper.stderr"} {
			data, err := os.ReadFile(filepath.Join(f.dir, filename))
			if err == nil {
				if len(data) > 4096 {
					data = data[:4096]
				}
				evidence = append(evidence, filename+": "+string(data))
			} else {
				evidence = append(evidence, filename+": "+err.Error())
			}
		}
		t.Fatalf("missing %s; retain %s; %s", name, f.dir, strings.Join(evidence, "; "))
		return nil
	}
	if json.Unmarshal(waitFile("desktop.json"), &desktop) != nil || desktop.PID <= 1 || desktop.Parent <= 1 {
		t.Fatal("fixture desktop identity unknown")
	}
	queue, err := unix.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(queue)
	change := unix.Kevent_t{Ident: uint64(desktop.Parent), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ONESHOT | unix.EV_RECEIPT, Fflags: unix.NOTE_EXIT | unix.NOTE_EXITSTATUS | unix.NOTE_EXIT_DETAIL}
	var receipt [1]unix.Kevent_t
	n, err := unix.Kevent(queue, []unix.Kevent_t{change}, receipt[:], nil)
	if err != nil || n != 1 || receipt[0].Data != 0 {
		t.Fatal("original guardian observation unavailable", err)
	}
	f.predecessorPID, f.processStart = desktop.PID, desktop.Start
	f.startedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	marker := closedHelperJSON(t, map[string]any{"schema": 1, "pid": desktop.PID, "processStart": desktop.Start, "startedAt": f.startedAt, "bootTime": nil})
	if err := os.WriteFile(filepath.Join(f.statePath, "running.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	request := f.request("apply", true)
	request["target"].(map[string]any)["digest"] = targetDigest
	request["waitSeconds"] = 90
	protocol, err := protocolapp.Bind(context.Background(), closedHelperJSON(t, request), inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	slot, err := protocol.BuildSlotBinding(context.Background(), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.operation, "slot-binding.json"), slot, 0600); err != nil {
		t.Fatal(err)
	}
	plan := closedHelperJSON(t, map[string]any{"binary": execNativeCompiled(t), "request": request, "state": f.statePath})
	if err := os.WriteFile(filepath.Join(f.dir, "plan.tmp"), plan, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.dir, "plan.tmp"), filepath.Join(f.dir, "plan.json")); err != nil {
		t.Fatal(err)
	}
	var handoff struct {
		Phase string `json:"phase"`
	}
	if json.Unmarshal(waitFile("handoff.json"), &handoff) != nil || handoff.Phase != "waiting_for_exit" {
		t.Fatal("helper was not ready")
	}
	var events [1]unix.Kevent_t
	timeout := unix.NsecToTimespec(int64(time.Until(until)))
	n, err = unix.Kevent(queue, nil, events[:], &timeout)
	if err != nil || n != 1 || events[0].Fflags&unix.NOTE_EXIT == 0 || events[0].Data != 0 {
		t.Fatalf("original guardian terminal missing/nonzero: %d %v %+v; retain %s", n, err, events, f.dir)
	}
	log := execNativeRead(t, filepath.Join(f.dir, "guardian.log"))
	if !strings.Contains(log, "desktop_launcher_helper_exit") || !strings.Contains(log, "waitStatus=0") || !strings.Contains(log, "desktop_launcher_desktop_exit") {
		t.Fatal("original helper terminal missing: ", log)
	}
	if f.phase(t) != "completed" {
		t.Fatal("real helper did not complete disposable relaunch")
	}
	if !strings.Contains(execNativeRead(t, filepath.Join(f.dir, "terminal.json")), `"phase": "completed"`) {
		t.Fatal("real helper terminal did not complete")
	}
	if !strings.Contains(execNativeRead(t, filepath.Join(f.home, "Applications/Farol.app/Contents/Info.plist")), "<string>io.github.legrch.farol</string>") {
		t.Fatal("target not installed")
	}
	var successor struct {
		PID, Parent           int
		Exe, AppPath, Version string
		Argv                  []string
	}
	if err := json.Unmarshal(waitFile("successor.json"), &successor); err != nil || successor.PID <= 1 || successor.Parent <= 1 || successor.PID == desktop.PID || successor.Parent == desktop.Parent || successor.Version != "1.2.3" || !strings.Contains(successor.Exe, filepath.Join(f.home, "Applications/Farol.app/Contents/Frameworks/Electron Runtime.app/")) || successor.AppPath != filepath.Join(f.home, "Applications/Farol.app/Contents/Resources/app") {
		t.Fatalf("canonical successor identity invalid: %+v %v; retain %s", successor, err, f.dir)
	}
	if len(successor.Argv) == 0 || !strings.HasPrefix(successor.Argv[len(successor.Argv)-1], "--farol-installed-update-relaunch=") {
		t.Fatal("successor did not receive correlated launch hint")
	}
	change = unix.Kevent_t{Ident: uint64(successor.Parent), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ONESHOT | unix.EV_RECEIPT, Fflags: unix.NOTE_EXIT | unix.NOTE_EXITSTATUS | unix.NOTE_EXIT_DETAIL}
	n, err = unix.Kevent(queue, []unix.Kevent_t{change}, receipt[:], nil)
	if err != nil || n != 1 || receipt[0].Data != 0 {
		t.Fatalf("successor guardian observation unavailable: %v; retain %s", err, f.dir)
	}
	if err := os.WriteFile(filepath.Join(f.dir, "successor.quit"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("original guardian=%d desktop=%d successor guardian=%d desktop=%d: %s", desktop.Parent, desktop.PID, successor.Parent, successor.PID, log)
	// The test-owned successor must leave normally before its disposable tree
	// is removed; no production process or profile was used.
	timeout = unix.NsecToTimespec(int64((10 * time.Second)))
	n, err = unix.Kevent(queue, nil, events[:], &timeout)
	if err != nil || n != 1 || events[0].Fflags&unix.NOTE_EXIT == 0 || events[0].Data != 0 {
		t.Fatalf("successor guardian terminal missing/nonzero: %d %v %+v; retain %s", n, err, events, f.dir)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "successor-timeout")); err == nil {
		t.Fatalf("successor timed out; retain %s", f.dir)
	}
	if err := os.RemoveAll(f.dir); err != nil {
		t.Fatal(err)
	}
}

// The target is a runnable, disposable image in the admitted owner-home slot.
// The original desktop above is registered under a distinct fixture bundle ID.
// This target retains the production bundle identity checks and a real nested
// Electron runtime; it is never copied into the owner's /Applications.
func desktopWitnessTarget(t *testing.T, f *liveNativeFixture, electron string) string {
	t.Helper()
	stage := filepath.Join(f.operation, "staged.app")
	if err := os.RemoveAll(stage); err != nil {
		t.Fatal(err)
	}
	resources := filepath.Join(stage, "Contents", "Resources", "app")
	frameworks := filepath.Join(stage, "Contents", "Frameworks")
	if err := os.MkdirAll(filepath.Join(stage, "Contents", "MacOS"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(resources, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(frameworks, 0755); err != nil {
		t.Fatal(err)
	}
	runtimeApp := filepath.Dir(filepath.Dir(filepath.Dir(electron)))
	if out, err := exec.Command("/usr/bin/ditto", runtimeApp, filepath.Join(frameworks, "Electron Runtime.app")).CombinedOutput(); err != nil {
		t.Fatalf("copy fixture runtime: %v %s", err, out)
	}
	backend := execNativeCompiled(t)
	if out, err := exec.Command("/usr/bin/ditto", backend, filepath.Join(resources, "farol-backend")).CombinedOutput(); err != nil {
		t.Fatalf("copy fixture backend: %v %s", err, out)
	}
	plist := `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Farol</string><key>CFBundleIdentifier</key><string>io.github.legrch.farol</string><key>CFBundleName</key><string>Farol</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleVersion</key><string>1</string></dict></plist>`
	launcher := "#!/bin/sh\nexec \"" + filepath.Join(resources, "farol-backend") + "\" run-desktop-launcher 2>\"" + filepath.Join(f.dir, "successor-guardian.log") + "\"\n"
	const successor = `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');
const root=ROOT;app.setPath('userData',path.join(root,'successor-profile'));
app.whenReady().then(()=>{app.dock?.hide();
const evidence={pid:process.pid,parent:process.ppid,exe:process.execPath,appPath:app.getAppPath(),version:app.getVersion(),argv:process.argv.slice(1)};
fs.writeFileSync(path.join(root,'successor.json'),JSON.stringify(evidence),{flag:'wx',mode:0o600});
const watcher=fs.watch(root,()=>{if(fs.existsSync(path.join(root,'successor.quit'))){watcher.close();app.quit();}});
setTimeout(()=>{fs.writeFileSync(path.join(root,'successor-timeout'),'fixture timeout');app.exit(79);},20000).unref();
});`
	files := map[string]string{
		filepath.Join(stage, "Contents", "Info.plist"):     plist,
		filepath.Join(stage, "Contents", "MacOS", "Farol"): launcher,
		filepath.Join(resources, "build-identity.json"):    execNativeTestdata(t, "oracle.json"),
		filepath.Join(resources, "package.json"):           `{"name":"farol-lifetime-successor","main":"index.cjs"}`,
		filepath.Join(resources, "index.cjs"):              strings.ReplaceAll(successor, "ROOT", string(closedHelperJSON(t, f.dir))),
	}
	for path, data := range files {
		mode := os.FileMode(0644)
		if strings.HasSuffix(path, "/MacOS/Farol") {
			mode = 0755
		}
		if err := os.WriteFile(path, []byte(data), mode); err != nil {
			t.Fatal(err)
		}
	}
	return desktopWitnessDigest(t, stage)
}

func desktopWitnessDigest(t *testing.T, root string) string {
	t.Helper()
	h := sha256.New()
	_, _ = h.Write([]byte("farol.tree-digest/v2\x00"))
	put32 := func(n int) { var b [4]byte; binary.BigEndian.PutUint32(b[:], uint32(n)); _, _ = h.Write(b[:]) }
	var walk func(string, string)
	walk = func(dir, prefix string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		sort.Slice(entries, func(i, j int) bool {
			a, b := utf16.Encode([]rune(entries[i].Name())), utf16.Encode([]rune(entries[j].Name()))
			for k := 0; k < len(a) && k < len(b); k++ {
				if a[k] != b[k] {
					return a[k] < b[k]
				}
			}
			return len(a) < len(b)
		})
		for _, entry := range entries {
			name := prefix + entry.Name()
			p := filepath.Join(dir, entry.Name())
			var st syscall.Stat_t
			if err := syscall.Lstat(p, &st); err != nil {
				t.Fatal(err)
			}
			put32(len([]byte(name)))
			_, _ = h.Write([]byte(name))
			switch st.Mode & syscall.S_IFMT {
			case syscall.S_IFDIR:
				_, _ = h.Write([]byte{'d'})
				put32(int(st.Mode & 07777))
				walk(p, name+"/")
			case syscall.S_IFREG:
				_, _ = h.Write([]byte{'f'})
				put32(int(st.Mode & 07777))
				data, err := os.ReadFile(p)
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(data)
				_, _ = h.Write(sum[:])
			case syscall.S_IFLNK:
				_, _ = h.Write([]byte{'l'})
				put32(int(st.Mode & 07777))
				link, err := os.Readlink(p)
				if err != nil {
					t.Fatal(err)
				}
				put32(len([]byte(link)))
				_, _ = h.Write([]byte(link))
			default:
				t.Fatalf("unsupported staged object: %s", p)
			}
		}
	}
	walk(root, "")
	return hex.EncodeToString(h.Sum(nil))
}
