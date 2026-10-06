//go:build windows

package app

import (
	"log/slog"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows 11 throttles processes without a foreground window (EcoQoS:
// efficiency cores, low clocks, coalesced timers). For the audio relay that
// showed up as 40-100 ms stalls in which no packet was received or
// forwarded. Opting out of power throttling, asking for 1 ms timer
// resolution and raising the priority class keeps the relay responsive.
const (
	processPowerThrottlingClass          = 4 // ProcessPowerThrottling
	processPowerThrottlingCurrentVer     = 1
	powerThrottlingExecutionSpeed        = 0x1
	powerThrottlingIgnoreTimerResolution = 0x4
)

type processPowerThrottlingState struct {
	Version     uint32
	ControlMask uint32
	StateMask   uint32
}

var (
	modKernel32               = windows.NewLazySystemDLL("kernel32.dll")
	procSetProcessInformation = modKernel32.NewProc("SetProcessInformation")
	modWinmm                  = windows.NewLazySystemDLL("winmm.dll")
	procTimeBeginPeriod       = modWinmm.NewProc("timeBeginPeriod")
)

// tuneProcessForRealtimeAudio applies the settings above; failures are
// logged and otherwise ignored (older Windows versions lack some APIs).
func tuneProcessForRealtimeAudio(logger *slog.Logger) {
	state := processPowerThrottlingState{
		Version:     processPowerThrottlingCurrentVer,
		ControlMask: powerThrottlingExecutionSpeed | powerThrottlingIgnoreTimerResolution,
		StateMask:   0, // controlled bits set to 0 = throttling off
	}
	if err := procSetProcessInformation.Find(); err == nil {
		r, _, callErr := procSetProcessInformation.Call(
			uintptr(windows.CurrentProcess()),
			processPowerThrottlingClass,
			uintptr(unsafe.Pointer(&state)),
			unsafe.Sizeof(state),
		)
		if r == 0 {
			logger.Warn("realtime: could not disable power throttling", "error", callErr)
		}
	}
	if err := procTimeBeginPeriod.Find(); err == nil {
		procTimeBeginPeriod.Call(1)
	}
	if err := windows.SetPriorityClass(windows.CurrentProcess(), windows.ABOVE_NORMAL_PRIORITY_CLASS); err != nil {
		logger.Warn("realtime: could not raise priority class", "error", err)
	}
	logger.Info("realtime: power throttling off, 1 ms timers, above-normal priority")
}

// processCPUSeconds is the user+kernel CPU time this process has used.
func processCPUSeconds() float64 {
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &creation, &exit, &kernel, &user); err != nil {
		return 0
	}
	ticks := func(f windows.Filetime) float64 {
		return float64(uint64(f.HighDateTime)<<32|uint64(f.LowDateTime)) / 1e7 // 100 ns units
	}
	return ticks(kernel) + ticks(user)
}
