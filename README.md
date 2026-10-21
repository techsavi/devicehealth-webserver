# Local services front door

One Caddy server on port 80 that routes paths to services running on this PC and shows a tiles page with a live summary of each. `serve.mjs` is also the single startup service for those services: it runs each one listed in `services.json`, restarts any that exit, and lets you start, stop and restart them from the tiles. An MQTT broker (Mosquitto) carries alerts between the projects and devices: see [MQTT](#mqtt).

It lives in `localweb/` beside the projects it runs (`../linuxserver`, `../tebletpanel`), and every path in it is relative, so the whole `localweb` folder can move. A service of this PC's own may live elsewhere: its path is in the local `services.json` (see [This PC's own services](#this-pcs-own-services)). After a move, run `install-autostart.ps1` again from the new place (its logon task stores the folder).

| Path | Routed to | Service |
| --- | --- | --- |
| `/` | `front/public/index.html` | Tiles page: live summaries from each service's API |
| `/statuspanel/` | `127.0.0.1:3003` | StatusPanel dashboard and REST API, served by `../linuxserver/local/poller.mjs` |
| `/tabletpanel/` | `127.0.0.1:8787` | TabletPanel control UI, REST API and WebSocket, served by `../tebletpanel/server` |
| `/mqtt/` | `front/public/mqtt/` | MQTT details page: broker statistics, clients, active alerts, recent messages |
| `/mqtt/ws` | `127.0.0.1:9001` | MQTT over WebSockets for the pages: anonymous and read-only |
| `/devices/` | `front/public/devices/` | IoT devices (Raspberry Pis, NodeMCUs): full status of each, add, edit, update, identify, forget and remove (`/pis/` redirects here) |

The front server strips the path prefix before forwarding and adds it back to root-relative `Location` redirect headers. Bare paths such as `/statuspanel` redirect to a trailing slash so relative links resolve.

## Start and stop

Requires Node.js 18 or newer, `npm install` once in this folder (the MQTT client library), and Mosquitto (`winget install EclipseFoundation.Mosquitto`; then stop and disable its Windows service, since `serve.mjs` runs it with `mqtt/mosquitto.conf`; elsewhere, install it and change the `mqtt` command in `services.json`). A portable Caddy 2.10.2 Windows executable is included in `bin`. On macOS/Linux install Caddy on PATH, or set `CADDY_BIN` to its executable path. Binding port 80 may need an operating-system permission on macOS/Linux.

```sh
node serve.mjs start
node serve.mjs status
node serve.mjs stop
```

For foreground operation and live logs, use `node serve.mjs run` and press Ctrl+C to stop. Background logs are in `.run/server.log`. `status` lists each service's state. Port 3080 is a local supervisor endpoint secured by a random token saved in `.run/state.json`.

### Start at logon

One scheduled task starts everything when you log on (no admin rights needed):

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1             # install and start now
powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall  # remove the task
```

The task ("Local services (webserver)") runs `node serve.mjs start` and exits once the stack is up, so ending the task does not stop anything. Use `node serve.mjs stop`. It starts at logon rather than at boot, so set Windows to sign in automatically if the PC should recover by itself after a power cut. The services must not have their own startup entries as well: two copies would compete for the same port.

### Services

`serve.mjs` runs each service in `services.json` as a child process. That file is this PC's own and isn't in git: copy `services.example.json` to `services.json` and edit it (without one, `serve.mjs` uses the example).

- **Start** and **Stop** on a tile also enable and disable the service, and that choice survives restarts (`.run/services-state.json`). A stopped service stays stopped until you start it again.
- **Restart** stops and starts it.
- A service that exits on its own is restarted after 1 s, doubling to a minute if it keeps crashing (never sooner than its `minRestartSeconds`).
- Its output goes to `.run/logs/<name>.log`, rotated at 5 MB.
- Stopping kills the service's whole process tree. If `serve.mjs` itself is killed outright, the next start removes the processes it left behind (pids recorded in `.run/children.json`).
- A service counts as running when its `health` URL returns HTTP 200, or for a `tcp://host:port` health (the MQTT broker) when it accepts a connection. If something else already serves it, the tile shows "running outside supervisor" and the supervisor leaves it alone until that copy stops.

The API behind the tiles is `GET /api/services` and `POST /api/services/<name>/start|stop|restart`. POSTs must carry `X-Requested-With: fetch`, which other websites cannot send without a CORS preflight, and that preflight is never granted.

## MQTT

The broker (`services.json` "mqtt", config `mqtt/mosquitto.conf`) is the shared alert bus. Publishers don't know who listens: the tiles page, the details page at `/mqtt/`, the TabletPanel server, and later pi_display and other devices all subscribe.

```
StatusPanel ────► alerts/statuspanel/<id> ─┐                 ┌─► TabletPanel server ──WebSocket──► tablets
Send alert tile ─► alerts/manual/<id> ─────┼─► MQTT broker ──┼─► tiles page banner, /mqtt/ page (WebSocket)
TabletPanel API ─► alerts/tabletpanel/<id> ┤   :1883, :9001  └─► pi_display, devices (later)
devices ─────────► status/<client> ────────┘
```

| Topic | Retained | Payload |
| --- | --- | --- |
| `alerts/<source>/<id>` | yes | JSON per active alert: `level` (`info`, `warning`, `critical`), `title`, `message`, `since` (epoch seconds), plus anything else the source adds (StatusPanel: `key`, `area`). Optional `help` (what it means and what to do about it) and `link` (a page with the details, a path or http(s) URL) are shown under **What to do** on the banner; StatusPanel and the Pi agent fill them in for every alert they raise. An empty retained message on the topic clears the alert. `<id>` is stable for the condition: letters, digits, `-` and `_` |
| `status/<client>` | yes | `online` when connected; `offline` when it leaves, set by the broker as the client's last will if it drops |
| `devices/<client>/...` | as the device chooses | A device's own readings and state (e.g. `devices/nodemcu-garage/temperature`) |
| `registry/devices/<name>` | yes | The hub's record of a device: `name`, `kind` (`raspberry-pi`, `nodemcu`, `tablet`, `other`), `subtitle`, `sshHost` (Pi), `deviceId` (tablet), `alerts` (what its display shows: `all`, `warning`, `critical`, `off`; absent = its default), `addedAt` (written by the `hub` login only; every device may read it) |
| `cmd/<name>/<command>` | no | A command for one device, from the `hub` login only; each device may read only its own. `identify` `{seconds, text, subtitle}`: pi_display fills its screen with the Pi's name until the time is up or the screen is tapped. Sent with an MQTT expiry, so a late delivery isn't shown |
| `$SYS/broker/...` | | Mosquitto statistics |

- **Listeners:** 1883 (MQTT, logins required) on all interfaces, for this PC's services and for devices on the LAN and tailnet; and 9001 (WebSockets for the pages, through Caddy at `/mqtt/ws`; anonymous and read-only) on 127.0.0.1. Windows Firewall admits TCP 1883 only from the local subnet and the tailnet, on the Private profile (rule "webserver MQTT (LAN + tailnet)"). 1883 is unencrypted, which is usual on a home LAN (NodeMCUs can't afford TLS); never forward it from the router.
- **Users:** every service and device has its own login. `node serve.mjs mqtt-user <name>` sets a new random password (hashed in `.run/mqtt/passwd`; also saved for local clients in `.run/mqtt/users/<name>.json`) and restarts the broker so the login works at once (clients reconnect by themselves within seconds; Mosquitto's reload signal doesn't take effect on Windows). Running it again for a name changes that password; `mosquitto_passwd -D .run/mqtt/passwd <name>` and a broker restart remove a login.
- **Permissions** (`mqtt/acl.conf`, by login name, so a new device needs no ACL lines): every login reads `alerts/#`, `devices/#` and `status/#`; writes its own `status/<name>`, its data under `devices/<name>/...` and its alerts under `alerts/<name>/...`. The `admin` login reads and writes everything, for testing.
- **Devices** (Pis, NodeMCUs...): connect to `<this PC>:1883` with their login, set a last will of `offline` on `status/<name>` and publish `online` there (retained), publish readings under `devices/<name>/...`, and subscribe to `alerts/#` (retained, so a device gets the current alerts as soon as it connects).
- **Retained alerts** are saved in `.run/mqtt/` and survive broker restarts.
- **Send alert** (the tile on the tiles page) publishes `alerts/manual/<id>` with the `manual` login through `POST /api/alerts` on `serve.mjs`: `{title, message, level, durationSeconds, id?}`, where `durationSeconds` becomes the message's expiry (0 = until cleared) and a fixed `id` (the Doorbell preset's `doorbell`) replaces the previous one. `DELETE /api/alerts/<id>` clears it. Same-origin guard as the service controls.
- **TabletPanel** subscribes to `alerts/#` itself and relays to the tablets over its WebSocket (`../tebletpanel/server/src/mqtt.js`): warnings and criticals from every source, and every level from `manual` and `tabletpanel`. A tablet chimes when an alert first appears, when its level rises, and every 24 h while it lasts. Dismissing on a tablet hides it there only; it stays on the bus for other displays. Its `POST /api/alerts` publishes `alerts/tabletpanel/<id>`.
- **NWS weather alerts:** TabletPanel also polls the National Weather Service every 2 minutes for its display location and publishes active alerts as `alerts/tabletpanel/nws-<id>` (`sentBy: "nws"`, plus `area`, `severity`, `urgency`, `nwsId`), expiring when the hazard ends. `critical` is reserved for Extreme and Immediate events (Tornado Warning, Extreme Wind Warning, Flash Flood Emergency), other warnings and watches are `warning`, advisories and statements `info`. The pages label them "NWS".
- **Adding a publisher or device:** `node serve.mjs mqtt-user <name>`, then publish retained JSON alerts under `alerts/<name>/` and anything else under `devices/<name>/` (and `status/<name>` with a last will). The `/mqtt/` page shows a `mosquitto_pub` example.

## IoT devices

Raspberry Pis and NodeMCUs (and other devices) report over MQTT the same way: `status/<name>` (`online`, `offline` as the last will) and a retained `devices/<name>/health` every 30 s whose `"kind"` says what they are (`raspberry-pi`, `nodemcu`). The **IoT Devices** tile lists them one line each, grouped by kind (status, name, subtitle, then temperature and CPU for a Pi, Wi-Fi signal for a NodeMCU, or the problem; a NodeMCU whose sketch publishes a retained `devices/<name>/wifi` reading `{dbm, pct, ssid, bssid, channel, at}`, like `../Arduino/nodemcu_nodisp` every 5 s, shows it live as signal bars, dBm and %); clicking it opens **`/devices/`**, the status and management page, with a section per kind:

- **Grouping is automatic:** a device that reports is shown in its kind's section even before it is registered (as "not registered", with **Add to registry**). **Add a device** has a **Group** selector for ones that haven't reported yet.
- **Raspberry Pi** (`agents/pi/pi_health.py`, installed over SSH): model, OS, kernel and agent version, temperature, CPU, memory and disk, load, uptime, IP and Wi-Fi, throttling, screens. **Add** (name, SSH host, subtitle; optionally installing the agent), **Update agent**, **Uninstall** (over SSH: stop and delete the agent, delete its MQTT login, clear its retained topics; other software on the Pi using the same login, such as pi_display, loses access too).
- **NodeMCU** (its own sketch, e.g. `../Arduino/nodemcu_disp`; nothing to install from here): chip, core and SDK, sketch version, IP and Wi-Fi, free heap and fragmentation, CPU, flash, uptime and last reset reason, display. **Add** creates its MQTT login and shows the four lines to paste into the sketch (`mqttHost`, `mqttPort`, `mqttName`, `mqttPassword`) once; **New password** replaces it (reflash afterwards); **Remove** deletes the login and clears its retained topics.
- For every kind: its active alerts, anything else it publishes under `devices/<name>/` (e.g. pi_display's Wi-Fi scan), **Edit** (subtitle; SSH host for a Pi), **Forget** (remove from the list only) and **Identify**, which shows the name full screen on the device's display for 30 s (tap to dismiss). Identify needs software on the device that takes commands (pi_display on a Pi, or a device whose health lists `"commands": ["identify"]`); the button is greyed out otherwise.
- These actions work from any browser on the LAN or tailnet (same-origin guard; one SSH job at a time; names and SSH hosts are validated so a host can't be an `ssh` option). Pi installs run with this PC's SSH keys.

**Subtitles and the registry** are the hub's: `.run/devices.json` holds each device's `{name, kind, subtitle, sshHost (Pi), addedAt}`, and `serve.mjs` publishes it as retained `registry/devices/<name>` with the `hub` login (and again whenever the broker starts), so any subscriber can show "pi3b-1 · Wifi Scanner" and a device can be listed before it reports or while it's off. The API is `/api/devices` (see the comment in `serve.mjs`). (Before kinds existed this was `.run/pis.json` and `registry/pis/<name>`; it is migrated automatically.)

**Show alerts on its display** (on each card of a device with a display): Default, All alerts, Warnings and up, Critical only, or Off. It is stored with the device in the hub's registry (`"alerts"` in `registry/devices/<name>`; absent = the device's own default), so it is managed in one place, survives a device being off or reimaged, and reaches the device as soon as it connects. Each display applies it itself: pi_display (Pis) and TabletPanel (it sends each tablet only the alerts its setting allows) do; a NodeMCU sketch can by subscribing to its own registry entry. **Tablets** are listed in their own section from TabletPanel's API (they don't use MQTT); choosing a setting for one registers it as `tablet-<start of its id>` with its `deviceId`.

**Out of service:** a device taken offline on purpose can be marked so on its card (with an optional note; stored with it in the registry as `outOfService: {since, note}`). It then stops counting as a problem: the tiles page shows it greyed out as "out of service" and leaves it out of "N of M online" ("3 of 3 online · 1 out of service"), while its card keeps a yellow notice with the date and note, and its last readings. **Return to service** removes the mark; a device that comes back online while marked shows as online with a reminder to do so.

**A device that goes offline** (its `status/<name>` becomes `offline`: its last will, or a clean shutdown) can't clear its own alerts, so for registered devices the hub clears its retained `alerts/<name>/…` then; its agent raises them again on reconnecting if they still hold. The tile shows the device as offline rather than its last warning, and its card marks the readings as from its last report.

**A device's MQTT login is its name.** A NodeMCU that logs in with a name that isn't registered still shows up (by its health report), but under the name it logs in with.

```sh
node agents/pi/deploy.mjs pi3b-1           # <ssh host> [mqtt name]; run again to update the agent
node agents/pi/deploy.mjs --remove pi3b-1  # stop and delete the agent (the page also removes its login)
```

`deploy.mjs` uses your SSH login to the Pi (no sudo): it creates the Pi's MQTT login if needed, copies the agent to `~/pi-health`, writes `~/.config/pi-health/config.json` (this PC's address as the Pi sees it, the login, a 30 s interval) and starts the systemd user service `pi-health`, enabling linger so it runs without anyone logged in (it prints the `sudo` command if the Pi doesn't allow that).

The agent publishes `devices/<name>/health` (retained JSON, `"kind": "raspberry-pi"`) every 30 s, keeps `status/<name>` at `online` (`offline` as its last will), and raises its own alerts on `alerts/<name>/…`: CPU at 80 °C (critical at 85), under-voltage or throttling now, disk 90% full (critical at 97). A Pi counts as offline on the tile when its status is `offline` or it hasn't reported for 2 minutes.

**After a Wi-Fi outage** the broker drops the Pi within 90 s (its last will marks it offline). The Pi can't rely on being told: Windows Firewall silently discards packets for the dropped connection, so without a check the Pi would keep retrying it for 15+ minutes. The agent therefore expects the broker's answer to a ping after every report (10 s timeout) and makes Linux give up on unacknowledged data after 30 s, then reconnects, retrying every 5 s and backing off to a minute. A Pi is back on the tile within about a minute of the Wi-Fi returning.

## The tiles page

The banner at the top shows every active warning and critical alert. **×** hides one in that browser until it changes (a new occurrence or a higher level); "N hidden · show" brings them back. Hiding doesn't clear an alert for other displays: its source clears it when the condition ends (manual alerts have **Clear** in the Send alert tile).

Tiles can be rearranged: drag one by the grip at its top edge (mouse or touch), or focus the grip and use the arrow keys. The order is kept in that browser (`localStorage`); **Reset tile order** in the header restores the default. A new tile goes at the end of a saved order.

## Network access

The server listens on all interfaces but only serves clients on private address ranges (LAN and this machine) or Tailscale (100.64.0.0/10), and disconnects anyone else. Windows Firewall must also allow inbound TCP 80 on the Private profile. The services behind it bind to 127.0.0.1, except TabletPanel, which listens on all interfaces at 8787 because the tablets connect to it directly, and the MQTT broker's port 1883 for LAN and tailnet devices (logins required; see [MQTT](#mqtt)).

## Adding a service

1. Add it to `services.json`: `name`, `title`, `cwd` (relative to this folder), `command` (`node` means this Node.js), a `health` URL that returns 200 while it is up, and optionally `cleanup` (files to delete before each start, such as a stale pid file), `minRestartSeconds`, `env`, and `mqttUser` (a broker login from `mqtt-user`, passed to the service as `MQTT_URL`, `MQTT_USERNAME` and `MQTT_PASSWORD`, so no password goes in this file). It should listen on its own port, bound to 127.0.0.1, and must not also have its own startup entry.
2. In `front/Caddyfile`, add a `redir /name /name/ 308` and a `handle_path /name/* { reverse_proxy 127.0.0.1:PORT { ... } }` block like the existing ones.
3. Add a tile to `front/public/index.html` with `data-service="name"` and an empty `<span class="svc">` in its footer for the controls, and optionally a live summary fetched from the service's API through its path, e.g. `/name/api/...`.

### This PC's own services

A service that shouldn't be in this repo (a private project) goes in local files instead, all gitignored:

- `services.json`: its entry, as above.
- `front/local/<name>.caddy`: its `redir` and `handle_path` lines. The Caddyfile imports every `front/local/*.caddy` into its route (none is fine).
- `front/local/tiles.js`: its tile. The tiles page loads this file before its main script (an empty script when there is none), so a tile it inserts into `<main>` takes part in the tile order and, with `data-service="name"`, gets the service controls. Code that uses the page's helpers (`esc`, `stat`, `REFRESH`...) runs from `DOMContentLoaded`.

Restart the stack after changing a `.caddy` file (Caddy runs without its admin API, so it reads the Caddyfile only at start); `tiles.js` takes effect on the next page load.

## Files

- `front/Caddyfile`: path routing and the LAN/Tailscale restriction
- `front/public/index.html`: the tiles page, with the live alert banner and the Send alert tile
- `front/public/mqtt/`: the MQTT details page and `bus.js`, the pages' shared MQTT subscriber
- `front/public/devices/`: the IoT devices status and management page
- `serve.mjs`: starts, stops and supervises Caddy and the services; `mqtt-user` creates broker logins; `/api/alerts` publishes manual alerts
- `services.example.json`: the services to run, with their commands and health URLs (copy to `services.json`, which is local)
- `front/local/`: this PC's own routes and tiles (local, see [This PC's own services](#this-pcs-own-services))
- `mqtt/mosquitto.conf`, `mqtt/acl.conf`: broker settings and who may publish or read what
- `agents/pi/`: the Raspberry Pi health agent, its systemd user unit and `deploy.mjs`
- `package.json`: the MQTT client library (`npm install`)
- `install-autostart.ps1`: installs or removes the logon task
- `bin/caddy.exe`: portable Caddy for Windows (not committed)

The folder can be moved without editing paths.
