## Downloads

All parts of a release carry the same version (the tag).

| File | What it is | For |
| --- | --- | --- |
| `kesher-server-linux-amd64.tar.gz` | Server with embedded web UI | Linux server, x86 |
| `kesher-server-linux-arm64.tar.gz` | Server with embedded web UI | Linux server, ARM (e.g. a Pi as server) |
| `kesher-server-windows-amd64.zip` | Server with embedded web UI | Windows |
| `kesher-server-darwin-amd64.tar.gz` | Server with embedded web UI | Mac with Intel |
| `kesher-server-darwin-arm64.tar.gz` | Server with embedded web UI | Mac with Apple silicon |
| `kesher-desktop-windows-amd64-setup.exe` | Desktop app, installer | Windows |
| `kesher-desktop-windows-amd64.msi` | Desktop app, MSI package | Windows (managed rollout) |
| `kesher-desktop-macos-arm64.dmg` | Desktop app | Mac with Apple silicon |
| `kesher-desktop-macos-amd64.dmg` | Desktop app | Mac with Intel |
| `kesher-node-raspberrypi-arm64.deb` | Station (headless, USB headset), Debian package | Raspberry Pi 3/4/5 with 64-bit Raspberry Pi OS |
| `kesher-node-raspberrypi-arm64.tar.gz` | Station, program only | 64-bit ARM Linux without `apt` |
| `kesher-node-linux-amd64.deb` | Station, Debian package | x86 Linux (Debian/Ubuntu) |
| `kesher-node-linux-amd64.tar.gz` | Station, program only | x86 Linux without `apt` |

Server: unpack and run the binary, or use Docker (see the README).
Stations: `sudo apt install ./kesher-node-raspberrypi-arm64.deb`, then follow
[docs/hardware/raspberry-pi.md](https://github.com/KesherCom/kesher/blob/main/docs/hardware/raspberry-pi.md).
