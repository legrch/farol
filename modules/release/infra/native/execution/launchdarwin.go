//go:build darwin

package execution

import (
	"context"
	"errors"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	helperprocess "github.com/legrch/farol/modules/release/infra/native/process"
)

// The native seam reads kernel state only: sysctl kern.proc.uid and
// kern.procargs2 for discovery, csops(CS_OPS_CDHASH) for the code-signing hash,
// proc_info(PROC_PIDREGIONPATHINFO) for the exec vnode and kern.proc.pid for
// the birth time. It never executes a tool, so no path is resolved a second time.
//
// The vnode identity is the first executable, file-backed memory region: that is
// the main executable's text mapping, reported with the stat of the vnode the
// kernel mapped it from. Unlike proc_pidpath it does not follow a renamed path.
type nativePlatform struct{}

func nativeLaunchPlatform() launchPlatform { return nativePlatform{} }

const (
	csOpsCDHash       = 5   // CS_OPS_CDHASH
	procInfoPIDInfo   = 2   // PROC_INFO_CALL_PIDINFO
	procRegionPath    = 8   // PROC_PIDREGIONPATHINFO
	protectionExecute = 4   // VM_PROT_EXECUTE
	regionScanLimit   = 256 // regions inspected before giving up on a vnode
)

func (nativePlatform) open(ctx context.Context, until time.Time, arguments []string, fence func(context.Context) error) error {
	return helperprocess.Open(ctx, until, arguments, fence)
}

func (nativePlatform) now() time.Time { return time.Now() }
func (nativePlatform) sleep(ctx context.Context, d time.Duration) error {
	return helperprocess.Clock{}.Sleep(ctx, d)
}

func (nativePlatform) candidates(_ context.Context, argument string) ([]int, error) {
	uid := os.Geteuid()
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.uid", uid)
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, process := range processes {
		pid := int(process.Proc.P_pid)
		if pid == os.Getpid() || int(process.Eproc.Ucred.Uid) != uid {
			continue
		}
		raw, err := unix.SysctlRaw("kern.procargs2", pid)
		if err != nil {
			// A process that exited, or whose arguments are not readable, cannot
			// be the freshly launched same-user child that open just returned.
			continue
		}
		if argvHolds(raw, argument) {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

func (nativePlatform) start(pid int) (processStart, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		// For a pid with no process the kernel answers with an empty result,
		// which the sysctl wrapper reports as EIO; signal 0 tells it apart.
		if errors.Is(err, unix.ESRCH) || errors.Is(err, unix.ENOENT) || errors.Is(err, unix.EIO) && errors.Is(unix.Kill(pid, 0), unix.ESRCH) {
			return processStart{}, errProcessGone
		}
		return processStart{}, err
	}
	if int(info.Proc.P_pid) != pid {
		return processStart{}, errProcessGone
	}
	return processStart{Seconds: int64(info.Proc.P_starttime.Sec), Microseconds: int64(info.Proc.P_starttime.Usec)}, nil
}

// kqueueWatch is a private kqueue holding one EVFILT_PROC/NOTE_EXIT
// registration. The registration is the only thing that ties the later signal
// to the process that was observed.
type kqueueWatch struct {
	fd   int
	done bool // the exit event was already consumed by the registration call
}

func (nativePlatform) watch(pid int) (exitWatch, error) {
	fd, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(fd)
	change := unix.Kevent_t{Ident: uint64(pid), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ENABLE | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT}
	var events [1]unix.Kevent_t
	zero := unix.Timespec{}
	n, err := kevent(fd, []unix.Kevent_t{change}, events[:], &zero)
	if err == nil && n > 0 && events[0].Flags&unix.EV_ERROR != 0 && events[0].Data != 0 {
		err = unix.Errno(events[0].Data)
	}
	if err != nil {
		_ = unix.Close(fd)
		if errors.Is(err, unix.ESRCH) {
			return nil, errProcessGone
		}
		return nil, err
	}
	return &kqueueWatch{fd: fd, done: n > 0 && events[0].Filter == unix.EVFILT_PROC && events[0].Fflags&unix.NOTE_EXIT != 0}, nil
}

func kevent(fd int, changes, events []unix.Kevent_t, timeout *unix.Timespec) (int, error) {
	for {
		n, err := unix.Kevent(fd, changes, events, timeout)
		if err != unix.EINTR {
			return n, err
		}
	}
}

func (w *kqueueWatch) exited() (bool, error) {
	if w.done {
		return true, nil
	}
	var events [1]unix.Kevent_t
	zero := unix.Timespec{}
	n, err := kevent(w.fd, nil, events[:], &zero)
	if err != nil {
		return false, err
	}
	if n > 0 && events[0].Filter == unix.EVFILT_PROC && events[0].Fflags&unix.NOTE_EXIT != 0 {
		w.done = true
	}
	return w.done, nil
}

func (w *kqueueWatch) close() error { return unix.Close(w.fd) }

func (nativePlatform) kill(pid int) error {
	err := unix.Kill(pid, unix.SIGKILL)
	if errors.Is(err, unix.ESRCH) {
		return errProcessGone
	}
	return err
}

// Layout of struct proc_regionwithpathinfo from <sys/proc_info.h>.
type vinfoStat struct {
	Dev     uint32
	Mode    uint16
	Nlink   uint16
	Ino     uint64
	UID     uint32
	GID     uint32
	_       [8]int64
	Size    int64
	Blocks  int64
	Blksize int32
	Flags   uint32
	Gen     uint32
	Rdev    uint32
	_       [2]int64
}

type regionInfo struct {
	Protection, MaxProtection, Inheritance, Flags uint32
	Offset                                        uint64
	_                                             [14]uint32
	Address, Size                                 uint64
}

type regionWithPath struct {
	Region regionInfo
	Stat   vinfoStat
	Type   int32
	_      int32
	Fsid   [2]int32
	Path   [1024]byte
}

func (n nativePlatform) image(pid int) (liveImage, error) {
	before, err := n.start(pid)
	if err != nil {
		return liveImage{}, err
	}
	var live liveImage
	var hash [20]byte
	if _, _, errno := unix.Syscall6(unix.SYS_CSOPS, uintptr(pid), csOpsCDHash, uintptr(unsafe.Pointer(&hash[0])), uintptr(len(hash)), 0, 0); errno != 0 {
		if errno == unix.ESRCH {
			return liveImage{}, errProcessGone
		}
		return liveImage{}, errno
	}
	live.Image.CDHash = hash
	var address uint64
	found := false
	for i := 0; i < regionScanLimit && !found; i++ {
		var region regionWithPath
		_, _, errno := unix.Syscall6(unix.SYS_PROC_INFO, procInfoPIDInfo, uintptr(pid), procRegionPath, uintptr(address), uintptr(unsafe.Pointer(&region)), unsafe.Sizeof(region))
		if errno != 0 {
			if errno == unix.ESRCH {
				return liveImage{}, errProcessGone
			}
			return liveImage{}, errno
		}
		if region.Region.Size == 0 {
			break
		}
		if region.Region.Protection&protectionExecute != 0 && region.Stat.Ino != 0 {
			live.Image.Device, live.Image.Inode = region.Stat.Dev, region.Stat.Ino
			found = true
		}
		address = region.Region.Address + region.Region.Size
	}
	if !found {
		return liveImage{}, errors.New("no file-backed executable region")
	}
	after, err := n.start(pid)
	if err != nil {
		return liveImage{}, err
	}
	if after != before {
		return liveImage{}, errProcessGone
	}
	live.Start = before
	return live, nil
}
