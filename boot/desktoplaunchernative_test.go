//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
// No window, owner state, shared slot, target relaunch or package acceptance.
func TestDesktopLauncherNativeLiveHelperSurvivesDesktopQuit(t *testing.T) {
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
	app := filepath.Join(f.dir, "Farol Lifetime Witness.app")
	contents := filepath.Join(app, "Contents")
	resources := filepath.Join(contents, "Resources", "app")
	for _, p := range []string{resources, filepath.Join(contents, "MacOS"), filepath.Join(contents, "Frameworks")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	binary, err := os.ReadFile(execNativeCompiled(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "farol-backend"), binary, 0500); err != nil {
		t.Fatal(err)
	}
	// Runtime is an explicit fixture input. This is not a candidate package.
	if err := os.Symlink(filepath.Dir(filepath.Dir(filepath.Dir(electron))), filepath.Join(contents, "Frameworks", "Electron Runtime.app")); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Farol</string><key>CFBundleIdentifier</key><string>io.github.legrch.farol.lifetime-witness.` + filepath.Base(f.dir) + `</string><key>CFBundleName</key><string>Farol Lifetime Witness</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`
	launcher := "#!/bin/sh\nexec \"" + filepath.Join(resources, "farol-backend") + "\" run-desktop-launcher 2>\"" + filepath.Join(f.dir, "guardian.log") + "\"\n"
	for p, data := range map[string]string{filepath.Join(contents, "Info.plist"): plist, filepath.Join(contents, "MacOS", "Farol"): launcher, filepath.Join(resources, "package.json"): `{"name":"farol-lifetime-witness","main":"index.cjs"}`} {
		if err := os.WriteFile(p, []byte(data), 0700); err != nil {
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
const helper={pid:child.pid,processStart:await api.captureInstalledProcessStart(child.pid)};
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
	// -g starts this completely hidden fixture without activating another app.
	// It deliberately does not qualify the production relaunch argv contract.
	if output, err := exec.Command("/usr/bin/open", "-g", "-a", app).CombinedOutput(); err != nil {
		t.Fatalf("fixture open: %v %s", err, output)
	}
	var desktop struct {
		PID    int    `json:"pid"`
		Start  string `json:"start"`
		Parent int    `json:"parent"`
	}
	until := time.Now().Add(30 * time.Second)
	waitFile := func(name string) []byte {
		t.Helper()
		for time.Now().Before(until) {
			if b, err := os.ReadFile(filepath.Join(f.dir, name)); err == nil {
				return b
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("missing %s; retain %s", name, f.dir)
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
	request := f.request("apply", false)
	request["waitSeconds"] = 15
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
	if f.phase(t) != "verified" {
		t.Fatal("real helper did not verify disposable apply")
	}
	if !strings.Contains(execNativeRead(t, filepath.Join(f.dir, "terminal.json")), `"phase": "verified"`) {
		t.Fatal("real helper terminal did not verify")
	}
	if execNativeRead(t, filepath.Join(f.home, "Applications/Farol.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.bplist") {
		t.Fatal("target not installed")
	}
	t.Logf("original guardian=%d desktop=%d: %s", desktop.Parent, desktop.PID, log)
	// Root exited only after original helper terminal; its single child was
	// reaped inside the production loop. This fixture has no successor process.
	if err := os.RemoveAll(f.dir); err != nil {
		t.Fatal(err)
	}
}
