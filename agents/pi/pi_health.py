#!/usr/bin/env python3
"""Raspberry Pi health agent for the local MQTT broker (../../README.md "MQTT").

Every INTERVAL seconds it publishes the Pi's health as a retained JSON message on
devices/<name>/health, keeps status/<name> at "online" (the broker sets "offline" as its
last will when the Pi drops), and raises its own alerts on alerts/<name>/<id> for overheating,
under-voltage, throttling, a full disk, security updates waiting, a reboot needed to finish updates
and package lists gone stale (an empty retained message clears them).

Python 3 standard library only (a minimal MQTT 3.1.1 client is included), so it runs on a
stock Raspberry Pi OS. Settings: ~/.config/pi-health/config.json
  {"host": "<broker>", "port": 1883, "username": "<name>", "password": "...", "interval": 30}
Installed and started by deploy.mjs as a systemd user service (pi-health.service).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

CONFIG = Path(os.environ.get("PI_HEALTH_CONFIG", Path.home() / ".config" / "pi-health" / "config.json"))
VERSION = "1.6"


# ---------------------------------------------------------------- minimal MQTT 3.1.1 client

def _str(s: str | bytes) -> bytes:
    b = s.encode() if isinstance(s, str) else s
    return struct.pack("!H", len(b)) + b


def _packet(kind: int, body: bytes) -> bytes:
    n, length = len(body), b""
    while True:
        byte, n = n % 128, n // 128
        length += bytes([byte | (0x80 if n else 0)])
        if not n:
            return bytes([kind]) + length + body


class Mqtt:
    """Just enough MQTT: connect with a login and a last will, publish (QoS 0), ping.

    A Wi-Fi outage can leave the connection looking open here while the broker has dropped it:
    Windows Firewall silently discards the retransmissions instead of resetting the connection.
    So every socket operation times out, Linux gives up on unacknowledged data after 30 s
    (TCP_USER_TIMEOUT) instead of its default 15+ minutes, and check() asks the broker for an
    answer every cycle.
    """

    def __init__(self, host, port, client_id, username, password, will_topic, will_payload, keepalive=60):
        self.sock = socket.create_connection((host, port), timeout=10)
        if hasattr(socket, "TCP_USER_TIMEOUT"):
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 30_000)
        flags = 0x02 | 0x04 | 0x20 | 0x80 | 0x40   # clean session, will, will retain, username, password
        body = _str("MQTT") + bytes([4, flags]) + struct.pack("!H", keepalive)
        body += _str(client_id) + _str(will_topic) + _str(will_payload) + _str(username) + _str(password)
        self.sock.sendall(_packet(0x10, body))
        ack = self.sock.recv(4)
        if len(ack) < 4 or ack[0] != 0x20 or ack[3] != 0:
            raise ConnectionError(f"broker refused the connection (code {ack[3] if len(ack) == 4 else '?'})")

    def publish(self, topic: str, payload: str | bytes, retain=False):
        data = payload.encode() if isinstance(payload, str) else payload
        self.sock.sendall(_packet(0x30 | (0x01 if retain else 0), _str(topic) + data))

    def check(self):
        """PINGREQ, and the broker's PINGRESP within the socket timeout, or the connection is dead."""
        self.sock.sendall(b"\xc0\x00")
        if self.sock.recv(2) != b"\xd0\x00":
            raise ConnectionError("no answer from the broker")

    def close(self):
        try:
            self.sock.sendall(b"\xe0\x00")   # DISCONNECT
        finally:
            self.sock.close()


# ---------------------------------------------------------------- readings

def _read(path: str, default: str = "") -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return default


def _cpu_times():
    fields = [int(x) for x in _read("/proc/stat").splitlines()[0].split()[1:]]
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    return idle, sum(fields)


THROTTLE_BITS = {0: "under-voltage", 1: "frequency capped", 2: "throttled", 3: "soft temperature limit"}


def throttling() -> dict:
    """vcgencmd get_throttled: what is happening now (bits 0-3) and since boot (bits 16-19)."""
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=5).stdout
        value = int(out.strip().split("=")[1], 16)
    except (OSError, IndexError, ValueError, subprocess.TimeoutExpired):
        return {"raw": None, "now": [], "since_boot": []}
    return {"raw": hex(value), "now": [n for b, n in THROTTLE_BITS.items() if value & (1 << b)],
            "since_boot": [n for b, n in THROTTLE_BITS.items() if value & (1 << (b + 16))]}


def wifi() -> dict | None:
    for line in _read("/proc/net/wireless").splitlines()[2:]:
        parts = line.split()
        if len(parts) > 3:
            return {"iface": parts[0].rstrip(":"), "link": float(parts[2].rstrip(".")), "dbm": float(parts[3].rstrip("."))}
    return None


def _kedei_screen(sys_root: Path, boot_config: Path, dev_root: Path) -> dict | None:
    """Recognize the explicitly configured V6.2 without opening SPI or GPIO.

    Generic spidev wiring does not identify an LCD. The marker is written by the
    meter's KeDei installer after its screen test; live wiring must also match.
    """
    try:
        config = boot_config.read_text()
        marker = '# wifi-meter KeDei V6.2 shared userspace SPI'
        if marker not in (line.strip() for line in config.splitlines()):
            return None
        configured = False
        for line in config.splitlines():
            active = line.split('#', 1)[0].strip().lower()
            if not active.startswith('dtoverlay='):
                continue
            name, *options = active.split('=', 1)[1].split(',')
            if name.strip() == 'spi0-1cs' and {option.strip() for option in options} == {'cs0_pin=7'}:
                configured = True
        if not configured:
            return None
        value = (sys_root / 'class/spi_master/spi0/device/of_node/cs-gpios').read_bytes()
        if len(value) != 12:
            return None
        controller, pin, flags = struct.unpack('>III', value)
        if not controller or (pin, flags) != (7, 1):
            return None
        devices = sys_root / 'bus/spi/devices'
        if sorted(node.name for node in devices.glob('spi0.*')) != ['spi0.0']:
            return None
        if (devices / 'spi0.0/driver').resolve(strict=True).name != 'spidev':
            return None
        if not (dev_root / 'spidev0.0').exists():
            return None
    except (OSError, ValueError, UnicodeError, RuntimeError):
        return None
    return {'kind': 'spi', 'id': 'spi0.0', 'driver': 'kedei-v6.2',
            'model': 'KeDei 3.5-inch SPI TFT LCD V6.2', 'width': 480, 'height': 320,
            'bpp': 16, 'touch': 'XPT2046 resistive', 'status': 'configured'}


def screens(sys_root: Path = Path('/sys'),
            boot_config: Path = Path('/boot/firmware/config.txt'),
            dev_root: Path = Path('/dev')) -> list[dict]:
    """Kernel framebuffers and DRM ports, plus the configured userspace KeDei LCD."""
    out = []
    for fb in sorted((sys_root / 'class/graphics').glob("fb[0-9]*")):
        size = _read(str(fb / "virtual_size"))
        if "," in size:
            w, h = (int(x) for x in size.split(",")[:2])
            out.append({"kind": "framebuffer", "id": fb.name, "driver": _read(str(fb / "name")) or None,
                        "width": w, "height": h, "bpp": int(_read(str(fb / "bits_per_pixel"), "0")) or None,
                        "rotate": int(_read(str(fb / "rotate"), "0"))})
    kedei = _kedei_screen(sys_root, boot_config, dev_root)
    if kedei:
        out.append(kedei)
    for conn in sorted((sys_root / 'class/drm').glob("card*-*")):
        port = conn.name.split("-", 1)[1]
        if port.startswith("Writeback"):
            continue
        modes = _read(str(conn / "modes")).splitlines()
        out.append({"kind": "port", "id": port, "status": _read(str(conn / "status")) or None,
                    "mode": modes[0] if modes else None})
    return out


def ip_address(host: str) -> str | None:
    try:   # the address this Pi uses to reach the broker; nothing is sent
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((host, 1))
            return s.getsockname()[0]
    except OSError:
        return None


def os_name() -> str:
    for line in _read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    return sys.platform


# ---------------------------------------------------------------- package updates

class Updates:
    """Updates waiting (apt-get's simulated full-upgrade, which needs no root) and whether a reboot
    is needed to finish them. The simulation takes ~25 s of CPU on a Pi 3, so it runs in the
    background at the lowest priority, and only when its inputs have changed and then held still
    for a cycle (the package lists were refreshed, or something was installed: an upgrade clears
    its warnings within a minute), else once a day. `state` is None until the first check is done:
      {total, security, security_pkgs (first 10), reboot (why one is needed, or None), lists_at,
       checked_at, error?}
    """
    INPUTS = ("/var/lib/apt/lists", "/var/lib/apt/lists/partial", "/var/lib/dpkg/status")
    DAILY_S = 86400

    def __init__(self):
        self.state: dict | None = None
        self._seen = self._done = None
        self._checked = 0.0
        self._running = False

    @staticmethod
    def _mtime(path: str) -> float:
        try:
            return os.stat(path).st_mtime
        except OSError:
            return 0.0

    def poll(self) -> dict | None:
        """Each cycle: start a check if one is due. Returns the latest result."""
        inputs = tuple(self._mtime(p) for p in self.INPUTS)
        settled, self._seen = inputs == self._seen, inputs
        due = inputs != self._done or time.time() - self._checked > self.DAILY_S
        if settled and due and not self._running:
            self._running = True
            threading.Thread(target=self._check, args=(inputs,), daemon=True).start()
        return self.state

    def _check(self, inputs):
        try:
            self.state = {**pending_updates(), "reboot": reboot_needed(),
                          "lists_at": int(max(inputs[:2])) or None, "checked_at": int(time.time())}
        except Exception as e:   # noqa: BLE001 - report it rather than stop the agent
            self.state = {**(self.state or {}), "error": str(e)[:200], "checked_at": int(time.time())}
        finally:
            self._done, self._checked, self._running = inputs, time.time(), False


def pending_updates() -> dict:
    """{total, security, security_pkgs}: from `apt-get -s full-upgrade`. An "Inst" line with the
    installed version in [brackets] is an upgrade; one from a *-security suite is a security fix."""
    res = subprocess.run(["nice", "-n", "19", "apt-get", "-s", "-o", "Debug::NoLocking=1", "full-upgrade"],
                         capture_output=True, text=True, timeout=600, env={**os.environ, "LC_ALL": "C"})
    if res.returncode != 0:
        lines = (res.stderr or res.stdout).strip().splitlines()
        raise RuntimeError(lines[-1] if lines else f"apt-get exited {res.returncode}")
    return parse_upgrades(res.stdout)


def parse_upgrades(text: str) -> dict:
    total, security = 0, []
    for line in text.splitlines():
        m = re.match(r"Inst (\S+) \[[^\]]*\] \(([^)]*)\)", line)
        if m:
            total += 1
            if "-security" in m.group(2):
                security.append(m.group(1))
    return {"total": total, "security": len(security), "security_pkgs": security[:10]}


def _kernel_key(release: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", release.split("-", 1)[0]))


def reboot_needed() -> str | None:
    """Why a reboot is needed to finish installed updates, or None: a newer kernel of this one's
    flavour (rpi-v8...) is installed, or this one's package was rebuilt since boot. Raspberry Pi OS
    doesn't reliably create /run/reboot-required, but it counts when it is there."""
    if os.path.exists("/run/reboot-required"):
        return "installed updates asked for one"
    release, flavour = os.uname().release, os.uname().release.partition("-")[2]
    try:
        newer = [d.name for d in Path("/lib/modules").iterdir()
                 if flavour and d.name.endswith("-" + flavour) and _kernel_key(d.name) > _kernel_key(release)]
    except OSError:
        newer = []
    if newer:
        return f"kernel {max(newer, key=_kernel_key)} is installed"
    res = subprocess.run(["dpkg-query", "-W", "-f=${Version}", f"linux-image-{release}"], capture_output=True, text=True)
    installed = res.stdout.strip()
    if res.returncode == 0 and installed and installed not in os.uname().version:
        return f"kernel {release} was updated to {installed}"
    return None


def health(prev_cpu, host: str) -> tuple[dict, tuple]:
    cpu = _cpu_times()
    d_idle, d_total = cpu[0] - prev_cpu[0], cpu[1] - prev_cpu[1]
    mem = {k: int(v.split()[0]) * 1024 for k, v in (l.split(":", 1) for l in _read("/proc/meminfo").splitlines())}
    disk = shutil.disk_usage("/")
    temp = _read("/sys/class/thermal/thermal_zone0/temp")
    return {
        "kind": "raspberry-pi", "agent": VERSION, "at": int(time.time()),
        "hostname": socket.gethostname(), "model": _read("/proc/device-tree/model").rstrip("\x00") or None,
        "os": os_name(), "kernel": os.uname().release, "ip": ip_address(host),
        "uptime_s": int(float(_read("/proc/uptime", "0").split()[0])),
        "load": [round(x, 2) for x in os.getloadavg()], "cpus": os.cpu_count(),
        "cpu_pct": round(100 * (1 - d_idle / d_total), 1) if d_total > 0 else None,
        "temp_c": round(int(temp) / 1000, 1) if temp.isdigit() else None,
        "mem_pct": round(100 * (1 - mem.get("MemAvailable", 0) / mem["MemTotal"]), 1) if mem.get("MemTotal") else None,
        "mem_total": mem.get("MemTotal"),
        "disk_pct": round(100 * disk.used / disk.total, 1), "disk_total": disk.total,
        "throttling": throttling(), "wifi": wifi(), "screens": screens(), "updates": UPDATES.poll(),
    }, cpu


def alerts(h: dict, name: str) -> dict:
    """Active alerts by id; every id in ALERT_IDS that isn't here gets cleared."""
    out, title = {}, f"{name} (Raspberry Pi)"
    t = h["temp_c"]
    if t is not None and t >= 80:
        out["temperature"] = ("critical" if t >= 85 else "warning", f"CPU at {t:.0f} °C")
    if "under-voltage" in h["throttling"]["now"]:
        out["undervoltage"] = ("warning", "Under-voltage: the power supply is too weak")
    if "throttled" in h["throttling"]["now"]:
        out["throttled"] = ("warning", "CPU throttled")
    if h["disk_pct"] >= 90:
        out["disk"] = ("critical" if h["disk_pct"] >= 97 else "warning", f"Disk / is {h['disk_pct']:.0f}% full")
    u = h.get("updates") or {}
    if u.get("security"):
        out["security-updates"] = ("warning", f"{u['security']} security update{'s' if u['security'] > 1 else ''} waiting")
    if u.get("reboot"):
        out["reboot"] = ("warning", "Reboot needed to finish installing updates")
    if u.get("lists_at") and h["at"] - u["lists_at"] > LISTS_STALE_S:
        out["lists-stale"] = ("warning", f"Package lists not refreshed for {(h['at'] - u['lists_at']) // 86400} days")
    return {k: {"level": lvl, "title": title, "message": msg, "help": "\n".join(ALERT_HELP[k](h)), "link": "/devices/"}
            for k, (lvl, msg) in out.items()}


# What each alert means and what to do (the "help" every display can show): the first line says what
# is wrong, each further line is one step, and `backticks` mark a command to run on the Pi (over SSH:
# its SSH host is on the IoT Devices page).
ALERT_HELP = {
    "temperature": lambda h: [
        f"The CPU is at {h['temp_c']:.0f} °C; at 80 °C and up it slows itself down, and at 85 °C it throttles hard.",
        "Check it is not in direct sun or boxed in with other warm devices, and that the case vents are clear.",
        "Fit a heatsink, or a case with a fan (5 V fan on pins 4 and 6).",
        "Watch it cool down: `vcgencmd measure_temp` (the warning clears below 80 °C).",
    ],
    "undervoltage": lambda h: [
        "The power supply is not delivering a steady 5 V, so the Pi slows down and can crash or corrupt its SD card.",
        "Use the official 5.1 V supply (2.5 A for a Pi 3, 3 A for a Pi 4) rather than a phone charger or a USB port.",
        "Use a short, thick cable: long thin USB cables drop the voltage.",
        "Unplug USB devices that draw power (drives, cameras), or put them on a powered hub.",
        "Check it: `vcgencmd get_throttled` shows 0x0 when the power is fine (the warning clears on its own).",
    ],
    "throttled": lambda h: [
        "The Pi has slowed its CPU, because it is too hot or its power is too weak.",
        "Fix whichever cause its other warning names (temperature or under-voltage); it speeds up again by itself.",
        "Check it: `vcgencmd get_throttled` shows 0x0 when nothing is slowing it down.",
    ],
    "disk": lambda h: [
        f"The SD card is {h['disk_pct']:.0f}% full; when it fills, logs stop and programs fail to start.",
        "Clear downloaded package files: `sudo apt clean`.",
        "Shrink the system log: `sudo journalctl --vacuum-size=100M`.",
        "Find what is using the space: `sudo du -xh / --max-depth=2 | sort -h | tail -15`, then remove what you don't need.",
        "If it is still nearly full, move to a larger SD card.",
    ],
    "security-updates": lambda h: [
        f"{h['updates']['security']} of the {h['updates']['total']} updates waiting on this Pi fix security problems"
        f" ({', '.join(h['updates']['security_pkgs'][:5])}{', ...' if h['updates']['security'] > 5 else ''}).",
        "Install them all: `sudo apt update && sudo apt full-upgrade`.",
        "If a reboot is needed afterwards, this Pi says so here within a minute: then `sudo reboot`.",
        "This warning clears within a minute of the upgrade finishing.",
    ],
    "reboot": lambda h: [
        f"Updates are installed but not running yet ({h['updates']['reboot']}): until a reboot, the old kernel"
        " keeps running, without the new one's fixes.",
        "Reboot when nothing needs the Pi: `sudo reboot` (it reconnects by itself in about a minute).",
    ],
    "lists-stale": lambda h: [
        f"This Pi last refreshed its package lists {(h['at'] - h['updates']['lists_at']) // 86400} days ago, so it"
        " can't see new updates, security fixes included.",
        "Refresh them now: `sudo apt update`.",
        "With the desktop, its updater (PackageKit) refreshes them daily; without it, have apt do it daily:"
        """ `echo 'APT::Periodic::Update-Package-Lists "1";' | sudo tee /etc/apt/apt.conf.d/10periodic`.""",
    ],
}


ALERT_IDS = ("temperature", "undervoltage", "throttled", "disk", "security-updates", "reboot", "lists-stale")
LISTS_STALE_S = 3 * 86400
UPDATES = Updates()


# ---------------------------------------------------------------- main loop

def main():
    cfg = json.loads(CONFIG.read_text())
    name, host, port = cfg["username"], cfg["host"], int(cfg.get("port", 1883))
    interval = max(5, int(cfg.get("interval", 30)))
    status = f"status/{name}"
    backoff = 5
    while True:
        client = None
        try:
            # Each health message keeps the connection alive; the broker declares the Pi offline
            # (its last will) after 1.5 keepalives without one.
            client = Mqtt(host, port, f"{name}-health", name, cfg["password"], status, "offline", keepalive=interval * 2)
            client.publish(status, "online", retain=True)
            print(f"connected to {host}:{port} as {name}", flush=True)
            backoff = 5
            raised: dict[str, dict] = {}
            cleared_once = False
            cpu = _cpu_times()
            time.sleep(1)
            while True:
                h, cpu = health(cpu, host)
                client.publish(f"devices/{name}/health", json.dumps(h), retain=True)
                active = alerts(h, name)
                for aid in ALERT_IDS:
                    topic = f"alerts/{name}/{aid}"
                    if aid in active:
                        a = active[aid]
                        old = raised.get(aid)
                        if not old or old["level"] != a["level"] or old["message"] != a["message"]:
                            a["since"] = old["since"] if old else h["at"]
                            client.publish(topic, json.dumps(a), retain=True)
                            raised[aid] = a
                    elif aid in raised or not cleared_once:
                        client.publish(topic, b"", retain=True)   # clears it (and any left from an earlier run)
                        raised.pop(aid, None)
                cleared_once = True
                client.check()
                time.sleep(interval)
        except (OSError, ConnectionError) as e:
            print(f"MQTT: {e}; retrying in {backoff} s", file=sys.stderr, flush=True)
        finally:
            if client:
                try:
                    client.sock.close()
                except OSError:
                    pass
        time.sleep(backoff)
        backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    main()
