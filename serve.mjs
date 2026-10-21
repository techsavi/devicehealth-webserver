import { spawn, spawnSync } from 'node:child_process';
import { createServer as createTcpServer, connect as connectTcp } from 'node:net';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, writeSync, statSync, renameSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = join(root, '.run');
const statePath = join(runtime, 'state.json');
const front = join(root, 'front');
const controlPort = 3080;
const ports = [80, controlPort];
const command = process.argv[2] || 'run';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = process.env.CADDY_BIN || (process.platform === 'win32' ? join(root, 'bin', 'caddy.exe') : 'caddy');
const caddyArgs = ['--config', 'Caddyfile', '--adapter', 'caddyfile'];
// This PC's services: services.json (local, not in git), else services.example.json to start from.
const servicesPath = () => [join(root, 'services.json'), join(root, 'services.example.json')].find(p => existsSync(p));
const enabledPath = join(runtime, 'services-state.json');
const childrenPath = join(runtime, 'children.json');
const logsDir = join(runtime, 'logs');
const maxLogBytes = 5 * 1024 * 1024;
const busy = new Set();

async function control(action) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${controlPort}/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${state.token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Control request failed: ${response.status}`);
  return response.text();
}

async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use or unavailable (a supervisor that isn't answering? \`node serve.mjs stop\` ends it).`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

// ---- Supervisor: runs each service in services.json as a child process while it is enabled,
// restarts it with backoff if it exits, and stops it (with its child processes) when disabled
// from a tile or when the stack shuts down. The enabled/disabled choice survives restarts in
// .run/services-state.json; each service's output goes to .run/logs/<name>.log.

function loadServices() {
  const file = servicesPath();
  if (!file) throw new Error('No services.json: copy services.example.json to services.json and edit it.');
  const list = JSON.parse(readFileSync(file, 'utf8'));
  return list.map(service => ({ ...service, cwd: resolve(root, service.cwd || '.') }));
}

const services = new Map(); // name -> { def, child, state, message, startedAt, restarts, backoff, timer }
let shuttingDown = false;

const isEnabled = name => readJson(enabledPath, {})[name]?.enabled !== false;
function setEnabled(name, enabled) {
  const all = readJson(enabledPath, {});
  all[name] = { enabled };
  mkdirSync(runtime, { recursive: true });
  writeFileSync(enabledPath, JSON.stringify(all, null, 2));
}

// A service counts as up only when its health URL answers 200: any other response or none is down.
// A tcp://host:port health (for services that don't speak HTTP, like the MQTT broker) is up when it accepts a connection.
async function isUp(def) {
  if (def.health.startsWith('tcp://')) {
    const { hostname, port } = new URL(def.health);
    return new Promise(done => {
      const socket = connectTcp({ host: hostname, port: Number(port), timeout: 2000 });
      const finish = up => { socket.destroy(); done(up); };
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }
  try { return (await fetch(def.health, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

async function waitFor(def, up, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await isUp(def) === up) return true;
  return false;
}

function openLog(name) {
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, `${name}.log`);
  try { if (statSync(file).size > maxLogBytes) renameSync(file, `${file}.1`); } catch {}
  return openSync(file, 'a');
}

// A service with "mqttUser" in services.json gets that broker login as MQTT_URL, MQTT_USERNAME and
// MQTT_PASSWORD, so no password goes in a committed file. Without the login it starts without them.
const mqttUrl = 'mqtt://127.0.0.1:1883';
const mqttLogin = user => readJson(join(runtime, 'mqtt', 'users', `${user}.json`), null);
function mqttEnv(def) {
  const login = def.mqttUser && mqttLogin(def.mqttUser);
  return login ? { MQTT_URL: mqttUrl, MQTT_USERNAME: login.username, MQTT_PASSWORD: login.password } : {};
}

// Files a service leaves behind when it is killed without a chance to clean up (e.g. a pid file
// that would make the next start think it is already running).
function cleanUp(def) {
  for (const file of def.cleanup ?? []) rmSync(resolve(def.cwd, file), { force: true });
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

// Child pids are recorded so that if this process is ever killed outright (Task Manager, a
// forced shutdown of the scheduled task) the next start can remove the orphans it left.
let caddyPid = null;
function recordChildren() {
  const list = [...(caddyPid ? [{ name: 'caddy', pid: caddyPid }] : []), ...[...services.values()].filter(s => s.child).map(s => ({ name: s.def.name, pid: s.child.pid }))];
  try { writeFileSync(childrenPath, JSON.stringify(list)); } catch {}
}

function killOrphans() {
  const recorded = readJson(childrenPath, []);
  const alive = recorded.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  if (!alive.length) return;
  // Only kill a recorded pid if it still looks like ours: pids are reused by unrelated programs.
  const lines = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { @(${alive.map(a => a.pid).join(',')}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`],
        { encoding: 'utf8', windowsHide: true }).stdout ?? ''
    : spawnSync('ps', ['-o', 'pid=,args=', '-p', alive.map(a => a.pid).join(',')], { encoding: 'utf8' }).stdout ?? '';
  const defs = loadServices();
  for (const line of lines.split(/\r?\n/).filter(Boolean)) {
    const [pid, ...rest] = line.trim().split(' ');
    const cmd = rest.join(' ');
    const def = defs.find(d => cmd.includes(d.command.slice(1).join(' ')));
    if (def || cmd.includes('caddy')) {
      console.log(`Removing leftover ${def?.name ?? 'caddy'} process ${pid} from a previous run.`);
      killTree(Number(pid));
      if (def) cleanUp(def);
    }
  }
}

async function launch(entry) {
  const { def } = entry;
  clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.child || shuttingDown || !isEnabled(def.name)) return;
  if (await isUp(def)) {
    // Something else already serves this port: leave it alone and check again later.
    entry.state = 'external';
    entry.message = 'Running outside this supervisor. Stop that copy to let the supervisor manage it.';
    entry.timer = setTimeout(() => launch(entry), 15000);
    return;
  }
  if (!existsSync(def.cwd)) {
    entry.state = 'error';
    entry.message = `Folder not found: ${def.cwd}`;
    return;
  }
  cleanUp(def);
  const [file, ...args] = def.command[0] === 'node' ? [process.execPath, ...def.command.slice(1)] : def.command;
  const log = openLog(def.name);
  writeSync(log, `\n--- ${new Date().toISOString()} starting: ${def.command.join(' ')}\n`);
  const child = spawn(file, args, {
    cwd: def.cwd, stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, ...def.env, ...mqttEnv(def) },
  });
  closeSync(log);
  Object.assign(entry, { child, state: 'starting', message: '', startedAt: Date.now() });
  recordChildren();
  // Whatever the broker lost (it's restarted whenever a login is added), the hub's registry is put back.
  if (def.name === 'mqtt') publishRegistry();
  child.once('error', error => { entry.message = error.message; });
  child.once('exit', (code, signal) => {
    entry.child = null;
    recordChildren();
    cleanUp(def);
    if (shuttingDown || entry.stopping || !isEnabled(def.name)) {
      Object.assign(entry, { state: 'stopped', stopping: false, message: '' });
      return;
    }
    // Quick restart after a long run; a crash loop backs off to a minute (never below the service's minimum).
    const floor = (def.minRestartSeconds ?? 1) * 1000;
    entry.backoff = Date.now() - entry.startedAt > 60000 ? floor : Math.min(Math.max(entry.backoff * 2, floor), 60000);
    entry.restarts++;
    entry.state = 'restarting';
    entry.message = `Exited (${signal ?? code}); restarting in ${Math.round(entry.backoff / 1000)} s. Log: .run/logs/${def.name}.log`;
    entry.timer = setTimeout(() => launch(entry), entry.backoff);
  });
}

async function halt(entry) {
  clearTimeout(entry.timer);
  entry.timer = null;
  const { child } = entry;
  if (!child) {
    if (entry.state !== 'external') Object.assign(entry, { state: 'stopped', message: '' });
    return;
  }
  entry.stopping = true;
  const exited = new Promise(done => child.once('exit', done));
  killTree(child.pid);
  await Promise.race([exited, sleep(5000)]);
}

function startServices() {
  for (const def of loadServices()) {
    const entry = { def, child: null, state: 'stopped', message: '', startedAt: null, restarts: 0, backoff: (def.minRestartSeconds ?? 1) * 1000, timer: null };
    services.set(def.name, entry);
    if (isEnabled(def.name)) launch(entry);
  }
}

function stopServicesNow() {
  shuttingDown = true;
  for (const entry of services.values()) {
    clearTimeout(entry.timer);
    if (entry.child) { killTree(entry.child.pid); cleanUp(entry.def); }
  }
}

async function describe(entry) {
  const { def, child } = entry;
  const running = await isUp(def);
  let state = entry.state;
  if (child) state = running ? 'running' : 'starting';
  else if (running && state !== 'restarting') state = 'external';
  else if (state === 'external') state = 'stopped';
  return {
    name: def.name, title: def.title ?? def.name, enabled: isEnabled(def.name), running, state,
    message: state === 'external' && !entry.message ? 'Running outside this supervisor.' : entry.message,
    pid: child?.pid ?? null,
    uptimeSeconds: child && entry.startedAt ? Math.round((Date.now() - entry.startedAt) / 1000) : null,
    restarts: entry.restarts, busy: busy.has(def.name),
  };
}

// start/stop also enable/disable the service, so a stopped service stays stopped after a restart.
async function act(entry, action) {
  const { def } = entry;
  if (action === 'stop') {
    setEnabled(def.name, false);
    const owned = Boolean(entry.child);
    await halt(entry);
    if (await waitFor(def, false, 10000)) return { ok: true, message: 'Stopped.' };
    return { ok: false, message: owned ? 'Stopped, but it is still answering.' : 'Disabled here, but a copy running outside this supervisor is still answering.' };
  }
  setEnabled(def.name, true);
  if (action === 'restart') { await halt(entry); entry.stopping = false; }
  entry.restarts = action === 'start' ? 0 : entry.restarts;
  // Start from services.json as it is now, so an edit to it (a project moved) needs no restart of the stack.
  if (!entry.child) entry.def = loadServices().find(s => s.name === def.name) ?? def;
  if (!entry.child) await launch(entry);
  if (entry.state === 'external') return { ok: false, message: entry.message };
  if (await waitFor(entry.def, true, 20000)) return { ok: true, message: action === 'restart' ? 'Restarted.' : 'Started.' };
  return { ok: false, message: entry.message || `Started, but it is not answering yet. Log: .run/logs/${def.name}.log` };
}

// ---- Services API (routed by Caddy at /api/). Clients pick a service and an action; the
// commands themselves come only from services.json.

// ---- Manual alerts (the tiles page's Send alert), published on the MQTT broker with the "manual"
// login: POST /api/alerts {title, message, level, durationSeconds, id?} -> retained
// alerts/manual/<id> (durationSeconds becomes the message's expiry; 0 = until cleared);
// DELETE /api/alerts/<id> clears it. Every display subscribed to alerts/# shows them.

const LEVELS = ['info', 'warning', 'critical'];
const DEFAULT_SECONDS = { info: 300, warning: 1800, critical: 0 };

// A short MQTT connection as one of the hub's logins (it only publishes now and then).
async function mqttAs(user, fn) {
  const login = mqttLogin(user);
  if (!login) throw new Error(`No MQTT login "${user}": run node serve.mjs mqtt-user ${user}`);
  const { default: mqtt } = await import('mqtt');
  const client = await mqtt.connectAsync(mqttUrl, {
    username: login.username, password: login.password, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 5000,
  });
  try { return await fn(client); } finally { await client.endAsync(); }
}

async function publishManual(topic, payload, options = {}) {
  await mqttAs('manual', client => client.publishAsync(topic, payload, { retain: true, qos: 1, ...options }));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 16384) throw new Error('Body too large'); }
  return text ? JSON.parse(text) : {};
}

async function alertsApi(request, response, path, json) {
  const id = path.match(/^\/api\/alerts\/([\w-]{1,64})$/)?.[1];
  if (request.method === 'DELETE' && id) {
    await publishManual(`alerts/manual/${id}`, '');
    return json(200, { ok: true, cleared: `alerts/manual/${id}` });
  }
  if (request.method !== 'POST' || path !== '/api/alerts') return json(404, { error: 'Not found' });
  let body;
  try { body = await readBody(request); } catch (error) { return json(400, { error: error.message }); }
  const title = String(body.title ?? '').trim().slice(0, 120), message = String(body.message ?? '').trim().slice(0, 500);
  const level = body.level ?? 'info';
  const seconds = body.durationSeconds ?? DEFAULT_SECONDS[level];
  const alertId = body.id ?? randomBytes(4).toString('hex');
  if (!title && !message) return json(400, { error: 'A title or message is required.' });
  if (!LEVELS.includes(level)) return json(400, { error: `level must be one of ${LEVELS.join(', ')}` });
  if (typeof seconds !== 'number' || seconds < 0) return json(400, { error: 'durationSeconds must be 0 or more' });
  if (!/^[\w-]{1,64}$/.test(alertId)) return json(400, { error: 'id must be 1-64 letters, digits, - or _' });
  const since = Math.floor(Date.now() / 1000);
  const payload = { level, title: title || undefined, message: message || undefined, since, expires: seconds ? since + seconds : undefined };
  const topic = `alerts/manual/${alertId}`;
  await publishManual(topic, JSON.stringify(payload), seconds ? { properties: { messageExpiryInterval: seconds } } : {});
  return json(202, { ok: true, id: alertId, topic });
}

// ---- IoT devices (the /devices/ page). The hub keeps a registry in .run/devices.json: each
// device's kind ("raspberry-pi", "nodemcu" or "other"), its subtitle (e.g. "Wifi Scanner") and, for
// a Raspberry Pi, how to reach it over SSH. It is published as retained registry/devices/<name> with
// the "hub" login, so every subscriber discovers it, and works while a device is off. A device's
// own health report (devices/<name>/health, "kind") groups it even before it is registered.
//   Raspberry Pi: adding installs its health agent over SSH (agents/pi/deploy.mjs, with this PC's
//   SSH keys); uninstalling removes the agent, its MQTT login and its retained topics.
//   NodeMCU and other firmware devices: adding creates the MQTT login and returns it to flash into
//   the sketch; removing deletes the login and the retained topics.
//   GET    /api/devices                     {devices, job, broker}
//   POST   /api/devices                     {name, kind, subtitle?, sshHost?, install?} add
//   PATCH  /api/devices/<name>              {subtitle?, sshHost?, alerts?, outOfService?: {note?} | false}
// Tablets (kind "tablet") are the TabletPanel app's: the page lists them from TabletPanel's API and
// registers one (name tablet-<id>, with its deviceId) to give it a subtitle or an alerts setting.
//   POST   /api/devices/<name>/deploy       Raspberry Pi: install or update the agent
//   POST   /api/devices/<name>/login        firmware device: a new MQTT password (to reflash)
//   POST   /api/devices/<name>/identify     {seconds?} show its name on its screen (cmd/<name>/identify)
//   DELETE /api/devices/<name>[?uninstall=1]  forget it (and uninstall / remove its login)

const KINDS = ['raspberry-pi', 'nodemcu', 'tablet', 'other'];
// What a device with a display shows of the alert bus: null = its own default, else the lowest level
// shown ("all" = info and up) or "off". The device reads it from its registry/devices/<name> entry.
const ALERT_SETTINGS = [null, 'all', 'warning', 'critical', 'off'];
const TABLET_ID = /^[\w-]{1,64}$/;   // the TabletPanel app's deviceId (a UUID)
const devicesPath = join(runtime, 'devices.json');
const DEVICE_NAME = /^[A-Za-z0-9][\w-]{0,31}$/;
const SSH_HOST = /^(?:[A-Za-z0-9][\w.-]*@)?[A-Za-z0-9][\w.:-]{0,99}$/;   // [user@]host: never an ssh option
let deviceJob = null;   // one SSH install or uninstall at a time

function loadDevices() {
  if (existsSync(devicesPath)) return readJson(devicesPath, {});
  // Before there were kinds, the registry held only Raspberry Pis (.run/pis.json, registry/pis/<name>).
  const old = readJson(join(runtime, 'pis.json'), {});
  const devices = Object.fromEntries(Object.entries(old).map(([name, e]) => [name, { kind: 'raspberry-pi', ...e }]));
  saveDevices(devices);
  mqttAs('hub', async client => {
    for (const name of Object.keys(old)) await client.publishAsync(`registry/pis/${name}`, '', { retain: true, qos: 1 });
  }).catch(() => {});
  return devices;
}
const saveDevices = devices => writeFileSync(devicesPath, JSON.stringify(devices, null, 2));

const publishDevice = (name, entry) => mqttAs('hub', client =>
  client.publishAsync(`registry/devices/${name}`, entry ? JSON.stringify(entry) : '', { retain: true, qos: 1 }));

// At start and whenever the broker starts (it may have lost retained messages; it may still be starting).
async function publishRegistry() {
  for (let attempt = 0; attempt < 12; attempt++) {
    try { for (const [name, entry] of Object.entries(loadDevices())) await publishDevice(name, entry); return; } catch { await sleep(5000); }
  }
}

// A registered device that goes offline (its status/<name> becomes "offline": its last will, or a
// clean shutdown) can't clear its own alerts, so the hub clears its retained alerts/<name>/... then.
// Its agent raises them again on reconnecting if they still hold. Only registered devices: services
// such as StatusPanel report on something else and keep their alerts across their own restarts.
let deviceWatcher = null;
async function watchDevices() {
  if (deviceWatcher) return;
  const login = mqttLogin('admin');
  if (!login) return;
  const { default: mqtt } = await import('mqtt');
  const alerts = new Map();   // device -> Set(retained alert topics)
  deviceWatcher = mqtt.connect(mqttUrl, { username: login.username, password: login.password, clientId: 'hub-device-watcher', reconnectPeriod: 5000 });
  deviceWatcher.on('connect', () => deviceWatcher.subscribe(['alerts/+/+', 'status/+'], { qos: 1 }));
  deviceWatcher.on('error', () => {});
  deviceWatcher.on('message', (topic, payload) => {
    const [kind, name] = topic.split('/');
    if (kind === 'alerts') {
      const set = alerts.get(name) ?? new Set();
      if (payload.length) set.add(topic); else set.delete(topic);
      alerts.set(name, set);
    } else if (payload.toString() === 'offline' && loadDevices()[name]) {
      // Retained statuses arrive before or after the alerts: give the alerts a moment to arrive.
      setTimeout(() => {
        for (const t of alerts.get(name) ?? []) deviceWatcher.publish(t, '', { retain: true, qos: 1 });
      }, 2000);
    }
  });
}

// This PC's address for devices on the LAN to reach the broker: a private IPv4 that isn't a
// virtual adapter's (VirtualBox 192.168.56.x, WSL/Docker 172.16-31.x), the tailnet or link-local.
function lanAddress() {
  const all = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  return all.find(a => /^(192\.168\.|10\.)/.test(a) && !a.startsWith('192.168.56.')) ?? all[0] ?? '127.0.0.1';
}

function runNode(args, timeoutMs = 240000) {
  return new Promise(done => {
    let output = '';
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('exit', code => { clearTimeout(timer); done({ ok: code === 0, output: output.trim() }); });
  });
}

// Everything a removed device left retained on the broker.
const clearDeviceTopics = name => mqttAs('admin', async client => {
  const held = new Set();
  client.on('message', (topic, payload) => { if (payload.length) held.add(topic); });
  await client.subscribeAsync([`devices/${name}/#`, `alerts/${name}/#`, `status/${name}`]);
  await sleep(1500);
  for (const topic of held) await client.publishAsync(topic, '', { retain: true, qos: 1 });
  return [...held];
});

function mosquittoTool(name) {
  const exe = loadServices().find(s => s.name === 'mqtt').command[0];
  return dirname(exe) === '.' ? name : join(dirname(exe), `${name}${extname(exe)}`);
}

// A new random password for an MQTT login, in the broker's password file (hashed) and saved for
// local clients in .run/mqtt/users/<name>.json. The broker uses it after its next restart.
function setMqttPassword(name) {
  const dir = join(runtime, 'mqtt');
  mkdirSync(join(dir, 'users'), { recursive: true });
  const passwd = join(dir, 'passwd');
  const password = randomBytes(18).toString('base64url');
  const result = spawnSync(mosquittoTool('mosquitto_passwd'),
    [...(existsSync(passwd) ? [] : ['-c']), '-b', passwd, name, password], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`mosquitto_passwd failed: ${result.error?.message ?? result.stderr}`);
  writeFileSync(join(dir, 'users', `${name}.json`), JSON.stringify({ username: name, password }, null, 2), { mode: 0o600 });
  return password;
}

async function restartBroker() {
  const broker = services.get('mqtt');
  if (broker) await act(broker, 'restart');   // the broker reads its password file at start
}

async function deleteMqttUser(name) {
  spawnSync(mosquittoTool('mosquitto_passwd'), ['-D', join(runtime, 'mqtt', 'passwd'), name], { windowsHide: true });
  rmSync(join(runtime, 'mqtt', 'users', `${name}.json`), { force: true });
  await restartBroker();
}

async function devicesApi(request, path, query, json) {
  const devices = loadDevices();
  const broker = { host: lanAddress(), port: 1883 };
  if (path === '/api/devices' && request.method === 'GET') return json(200, { devices, job: deviceJob, broker });
  const [, name, action] = path.match(/^\/api\/devices\/([^/]+)(?:\/(deploy|login|identify))?$/) ?? [];
  const body = async () => readBody(request);

  // Identify: a one-off command (not retained, so a device that reconnects later doesn't replay it;
  // it also expires with the overlay) that the device's display shows full screen until tapped.
  if (request.method === 'POST' && action === 'identify') {
    if (!DEVICE_NAME.test(name)) return json(400, { error: 'Unknown device.' });
    const seconds = Math.min(Math.max(Number((await body()).seconds) || 30, 5), 300);
    const command = { seconds, text: name, subtitle: devices[name]?.subtitle ?? '', from: 'hub', at: Math.floor(Date.now() / 1000) };
    await mqttAs('hub', client => client.publishAsync(`cmd/${name}/identify`, JSON.stringify(command),
      { qos: 1, properties: { messageExpiryInterval: seconds } }));
    return json(200, { ok: true, message: `Showing "${name}" on its screen for ${seconds} s.` });
  }

  if (deviceJob && request.method !== 'PATCH') return json(409, { error: `Busy: ${deviceJob.action} ${deviceJob.name} is still running.` });
  const job = async (what, deviceName, work) => {
    deviceJob = { action: what, name: deviceName, startedAt: new Date().toISOString() };
    try { return await work(); } finally { deviceJob = null; }
  };
  const deploy = entry => job('installing', entry.name, () => runNode([join(root, 'agents', 'pi', 'deploy.mjs'), entry.sshHost, entry.name]));
  // A firmware device gets its login from here; the page shows it once, to paste into the sketch.
  const newLogin = entry => job('creating a login for', entry.name, async () => {
    const password = setMqttPassword(entry.name);
    await restartBroker();
    return { username: entry.name, password };
  });

  if (path === '/api/devices' && request.method === 'POST') {
    const b = await body();
    const kind = KINDS.includes(b.kind) ? b.kind : 'raspberry-pi';
    const entry = { name: String(b.name ?? '').trim(), kind, subtitle: String(b.subtitle ?? '').trim().slice(0, 80) };
    if (kind === 'raspberry-pi') entry.sshHost = String(b.sshHost || b.name || '').trim();
    if (kind === 'tablet') entry.deviceId = String(b.deviceId ?? '');
    if (b.alerts !== undefined) entry.alerts = b.alerts;
    if (!DEVICE_NAME.test(entry.name)) return json(400, { error: 'name: 1-32 letters, digits, - or _, starting with a letter or digit' });
    if (entry.sshHost !== undefined && !SSH_HOST.test(entry.sshHost)) return json(400, { error: 'sshHost: a host name or address, optionally user@host' });
    if (entry.deviceId !== undefined && !TABLET_ID.test(entry.deviceId)) return json(400, { error: 'deviceId: the tablet\'s id from TabletPanel' });
    if (entry.alerts !== undefined && !ALERT_SETTINGS.includes(entry.alerts)) return json(400, { error: 'alerts: null, all, warning, critical or off' });
    if (devices[entry.name]) return json(409, { error: `${entry.name} is already registered.` });
    entry.addedAt = new Date().toISOString();
    saveDevices({ ...devices, [entry.name]: entry });
    await publishDevice(entry.name, entry);
    if (b.install === false || kind === 'tablet') return json(200, { ok: true, entry, message: 'Added to the registry.' });
    if (kind === 'raspberry-pi') {
      const result = await deploy(entry);
      return json(result.ok ? 200 : 500, { ...result, entry, message: result.ok ? 'Added and installed.' : 'Added, but installing the agent failed.' });
    }
    if (mqttLogin(entry.name)) return json(200, { ok: true, entry, message: `Added. The MQTT login "${entry.name}" already exists; use New password to get one to flash.` });
    const login = await newLogin(entry);
    return json(200, { ok: true, entry, login, broker, message: 'Added, with a new MQTT login: flash these settings into the sketch.' });
  }

  const entry = devices[name];
  if (!entry) return json(404, { error: `${name} is not registered.` });
  if (request.method === 'PATCH' && !action) {
    const b = await body();
    if (b.subtitle !== undefined) entry.subtitle = String(b.subtitle).trim().slice(0, 80);
    if (b.sshHost !== undefined && entry.kind === 'raspberry-pi') {
      if (!SSH_HOST.test(String(b.sshHost))) return json(400, { error: 'sshHost: a host name or address, optionally user@host' });
      entry.sshHost = String(b.sshHost);
    }
    if (b.alerts !== undefined) {
      if (!ALERT_SETTINGS.includes(b.alerts)) return json(400, { error: 'alerts: null, all, warning, critical or off' });
      if (b.alerts === null) delete entry.alerts; else entry.alerts = b.alerts;
    }
    // Out of service: taken offline on purpose until further notice. The pages stop treating its
    // being offline as a problem, but keep it listed with a notice.
    if (b.outOfService !== undefined) {
      // Changing the note of a device already out of service keeps when it went out of service.
      const since = entry.outOfService?.since ?? new Date().toISOString();
      if (b.outOfService) entry.outOfService = { since, note: String(b.outOfService.note ?? '').trim().slice(0, 120) };
      else delete entry.outOfService;
    }
    saveDevices(devices);
    await publishDevice(name, entry);
    return json(200, { ok: true, entry, message: 'Saved.' });
  }
  if (request.method === 'POST' && action === 'deploy') {
    if (entry.kind !== 'raspberry-pi') return json(400, { error: 'Only a Raspberry Pi has an agent to install; flash a firmware device instead.' });
    const result = await deploy(entry);
    return json(result.ok ? 200 : 500, { ...result, message: result.ok ? 'Agent installed.' : 'Installing the agent failed.' });
  }
  if (request.method === 'POST' && action === 'login') {
    if (entry.kind === 'raspberry-pi') return json(400, { error: 'A Raspberry Pi gets its login from Update agent.' });
    const login = await newLogin(entry);
    return json(200, { ok: true, login, broker, message: 'New password set: flash it into the sketch. Until then the device is refused.' });
  }
  if (request.method === 'DELETE' && !action) {
    const uninstall = query.get('uninstall') === '1';
    const steps = [];
    let ok = true;
    if (uninstall && entry.kind !== 'tablet') {   // a tablet has no login or agent here: forgetting is all
      await job(entry.kind === 'raspberry-pi' ? 'uninstalling' : 'removing', name, async () => {
        if (entry.kind === 'raspberry-pi') {
          const removed = await runNode([join(root, 'agents', 'pi', 'deploy.mjs'), '--remove', entry.sshHost, name]);
          steps.push(removed.output);
          ok = removed.ok;
        }
        await deleteMqttUser(name);
        steps.push(`Removed the MQTT login "${name}".`);
        const cleared = await clearDeviceTopics(name);
        steps.push(`Cleared ${cleared.length} retained topic(s).`);
      });
    }
    delete devices[name];
    saveDevices(devices);
    await publishDevice(name, null);
    steps.push(`Removed ${name} from the registry.`);
    return json(ok ? 200 : 500, { ok, output: steps.join('\n'), message: ok ? 'Removed.' : 'Removed, but uninstalling over SSH failed: see the output.' });
  }
  return json(404, { error: 'Not found' });
}

async function servicesApi(request, response, path, query = new URLSearchParams()) {
  const json = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  const sameOrigin = request.headers['x-requested-with'] === 'fetch' && request.headers['sec-fetch-site'] !== 'cross-site';
  if (path === '/api/alerts' || path.startsWith('/api/alerts/')) {
    // Same guard as the service controls below: only this site's own pages can send alerts.
    if (!sameOrigin) return json(403, { error: 'Forbidden' });
    try { return await alertsApi(request, response, path, json); } catch (error) { return json(502, { error: `MQTT broker: ${error.message}` }); }
  }
  if (path === '/api/devices' || path.startsWith('/api/devices/')) {
    if (request.method !== 'GET' && !sameOrigin) return json(403, { error: 'Forbidden' });
    try { return await devicesApi(request, path, query, json); } catch (error) { return json(error instanceof SyntaxError ? 400 : 502, { error: error.message }); }
  }
  if (path === '/api/services' && request.method === 'GET') {
    return json(200, await Promise.all([...services.values()].map(describe)));
  }
  const match = path.match(/^\/api\/services\/([\w-]+)\/(start|stop|restart)$/);
  if (!match || request.method !== 'POST') return json(404, { error: 'Not found' });
  // Only same-origin scripts can send this header: other sites would need a CORS preflight, which is never granted.
  if (request.headers['x-requested-with'] !== 'fetch' || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Forbidden' });
  const entry = services.get(match[1]);
  if (!entry) return json(404, { error: 'Unknown service' });
  const title = entry.def.title ?? entry.def.name;
  if (busy.has(entry.def.name)) return json(409, { error: `${title} is already starting or stopping.` });
  busy.add(entry.def.name);
  try {
    const result = await act(entry, match[2]);
    json(result.ok ? 200 : 500, { ...(await describe(entry)), ...result });
  } finally {
    busy.delete(entry.def.name);
  }
}

async function run() {
  for (const port of ports) await checkPort(port);
  const result = spawnSync(executable, ['validate', ...caddyArgs], { cwd: front, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  mkdirSync(runtime, { recursive: true });
  killOrphans();
  let stopping = false;
  let controlServer;
  const child = spawn(executable, ['run', ...caddyArgs], { cwd: front, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  caddyPid = child.pid;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    stopServicesNow();
    deviceWatcher?.end(true);   // else it keeps reconnecting to the stopped broker, and this process never exits
    child.kill();
    controlServer?.close();
    // Only this run's files: a second copy that failed to start must not remove the running one's.
    if (readJson(statePath, {}).pid === process.pid) {
      rmSync(statePath, { force: true });
      rmSync(childrenPath, { force: true });
    }
    setTimeout(() => process.exit(), 5000).unref();   // whatever else is left open
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  child.once('error', error => { console.error(error); process.exitCode = 1; cleanup(); });
  child.once('exit', code => {
    if (!stopping) { console.error(`Caddy exited (${code}).`); process.exitCode = 1; cleanup(); }
  });
  await sleep(1000);
  if (stopping) return;
  startServices();
  recordChildren();
  publishRegistry();
  watchDevices().catch(() => {});
  const token = randomBytes(32).toString('hex');
  controlServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/api/')) { servicesApi(request, response, path, url.searchParams).catch(error => response.writeHead(500).end(error.message)); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    if (request.url === '/status' && request.method === 'GET') {
      Promise.all([...services.values()].map(describe)).then(list => response.end(
        ['The front Caddy server is running.', ...list.map(s => `  ${s.title}: ${s.state}${s.enabled ? '' : ' (disabled)'}${s.message ? ` - ${s.message}` : ''}`)].join('\n'),
      ));
      return;
    }
    if (request.url === '/stop' && request.method === 'POST') { response.end('Stopped.'); setImmediate(cleanup); return; }
    response.writeHead(404).end();
  });
  controlServer.once('error', error => { console.error(error); process.exitCode = 1; cleanup(); });
  await new Promise(resolve => controlServer.listen(controlPort, '127.0.0.1', resolve));
  writeFileSync(statePath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  console.log('Ready: http://localhost/');
}

// ---- MQTT users: `node serve.mjs mqtt-user <name>` sets a new random password for <name> in the
// broker's password file (.run/mqtt/passwd, hashed), saves it for local clients in
// .run/mqtt/users/<name>.json and restarts the broker. What it may publish or read is in mqtt/acl.conf.

async function mqttUser(name) {
  if (!/^[\w-]+$/.test(name ?? '')) throw new Error('Usage: node serve.mjs mqtt-user <name>   (letters, digits, - and _)');
  if (!loadServices().some(s => s.name === 'mqtt')) throw new Error('No "mqtt" service in services.json.');
  const password = setMqttPassword(name);
  console.log(`MQTT user "${name}" password: ${password}\nSaved to ${join(runtime, 'mqtt', 'users', `${name}.json`)}.`);
  // The broker reads the password file at start (its config-reload signal doesn't take effect on
  // Windows), so restart it through the supervisor; clients reconnect by themselves within seconds.
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort}/api/services/mqtt/restart`, {
      method: 'POST', headers: { 'X-Requested-With': 'fetch' }, signal: AbortSignal.timeout(30000),
    });
    console.log(res.ok ? 'Restarted the broker: the login works now.' : `Restart the MQTT broker (its tile) to use the login: ${(await res.json()).message}`);
  } catch {
    console.log('The stack is not running: the login takes effect when the broker starts.');
  }
}

// `stop` when the supervisor doesn't answer (hung, e.g. after the PC ran out of memory): end it and
// everything it started, once its command line shows it really is this folder's supervisor.
async function forceStop() {
  // Its pid from .run/state.json, else (the file is gone) the process running this folder's serve.mjs.
  const script = join(root, 'serve.mjs').toLowerCase();
  const lines = (process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`],
        { encoding: 'utf8', windowsHide: true }).stdout
    : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout) ?? '';
  const procs = lines.split(/\r?\n/).map(l => l.trim().match(/^(\d+) (.*)$/)).filter(Boolean).map(([, p, c]) => ({ pid: Number(p), cmd: c }));
  const isOurs = c => c.toLowerCase().includes(script) && / run\s*$/.test(c);
  const recorded = readJson(statePath, {}).pid;
  const found = procs.find(p => p.pid === recorded) ?? procs.find(p => isOurs(p.cmd) && p.pid !== process.pid);
  const pid = found?.pid, cmd = found?.cmd ?? '';
  const ours = isOurs(cmd);
  if (pid && cmd && !ours) throw new Error(`Process ${pid} isn't this folder's supervisor (${cmd}); not touching it.`);
  if (ours) killTree(Number(pid));
  // Windows can take a while to tear the tree down (longer when it's short of memory).
  for (let i = 0; ours && i < 60; i++) {
    try { process.kill(Number(pid), 0); } catch { break; }
    await sleep(500);
    if (i === 59) throw new Error(`Process ${pid} is still exiting; check again in a minute.`);
  }
  rmSync(statePath, { force: true });
  rmSync(childrenPath, { force: true });
  return ours ? `Ended the supervisor (process ${pid}) and everything it started.` : 'Not running.';
}

try {
  if (command === 'mqtt-user') await mqttUser(process.argv[3]);
  else if (command === 'run') await run();
  else if (command === 'status') console.log(await control(command));
  else if (command === 'stop') {
    try { console.log(await control('stop')); } catch (error) {
      console.log(`The supervisor didn't answer (${error.message}).`);
      console.log(await forceStop());
    }
  }
  else if (command === 'start') {
    try { console.log(await control('status')); process.exit(0); } catch {}
    for (const port of ports) await checkPort(port);
    mkdirSync(runtime, { recursive: true });
    const output = openSync(join(runtime, 'server.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], {
      cwd: root, detached: true, stdio: ['ignore', output, output], windowsHide: true,
    });
    child.unref();
    closeSync(output);
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {   // up to 30 s (slower when the PC is short of memory)
      await sleep(250);
      try { console.log(await control('status')); ready = true; break; } catch {}
    }
    if (!ready) throw new Error('Startup failed. Check .run/server.log.');
    console.log('http://localhost/\nhttp://localhost/statuspanel/\nhttp://localhost/tabletpanel/');
  } else throw new Error('Usage: node serve.mjs [start|stop|status|run|mqtt-user <name>]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
