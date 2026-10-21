#!/usr/bin/env node
/*
 * Install or update the health agent on a Raspberry Pi:
 *
 *   node agents/pi/deploy.mjs <ssh host> [mqtt name]      e.g.  node agents/pi/deploy.mjs pi3b-1
 *   node agents/pi/deploy.mjs --remove <ssh host> [name]  stop and delete the agent on the Pi
 *
 * The Raspberry Pis page (/pis/) runs these through serve.mjs; --remove leaves deleting the MQTT
 * login and the retained topics to it.
 *
 * Uses the ssh/scp client and your SSH login to the Pi (no sudo needed). The MQTT name defaults
 * to the ssh host; its broker login is created with `serve.mjs mqtt-user` if it doesn't exist
 * yet. The agent goes to ~/pi-health on the Pi, its settings (broker address = this PC as the Pi
 * sees it, login, interval) to ~/.config/pi-health/config.json, and it runs as the systemd user
 * service pi-health. Run it again after changing pi_health.py.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const remove = args[0] === '--remove';
const [host, name = host] = remove ? args.slice(1) : args;
if (!host || host.startsWith('-') || !/^[\w-]+$/.test(name)) {
  console.error('Usage: node agents/pi/deploy.mjs [--remove] <ssh host> [mqtt name: letters, digits, - and _]');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  return r.stdout;
};
const ssh = (script, input) => run('ssh', ['-o', 'BatchMode=yes', host, script], { input });

if (remove) {
  try {
    console.log(ssh([
      'systemctl --user disable --now pi-health.service 2>/dev/null',
      'rm -rf ~/pi-health ~/.config/pi-health ~/.config/systemd/user/pi-health.service',
      'systemctl --user daemon-reload',
      'echo "Removed the health agent from $(hostname)."',
    ].join('; ')).trim());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  process.exit();
}

try {
  const loginFile = join(root, '.run', 'mqtt', 'users', `${name}.json`);
  if (!existsSync(loginFile)) {
    console.log(`Creating the MQTT login "${name}" (restarts the broker)...`);
    run(process.execPath, [join(root, 'serve.mjs'), 'mqtt-user', name], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const login = JSON.parse(readFileSync(loginFile, 'utf8'));

  // This PC's address as the Pi sees it: the far end of the SSH connection.
  const brokerHost = ssh('echo $SSH_CONNECTION').trim().split(/\s+/)[0];
  console.log(`Broker for ${host}: ${brokerHost}:1883 as "${name}"`);

  ssh('mkdir -p ~/pi-health ~/.config/pi-health ~/.config/systemd/user');
  run('scp', ['-q', '-o', 'BatchMode=yes', join(here, 'pi_health.py'), `${host}:pi-health/pi_health.py`]);
  run('scp', ['-q', '-o', 'BatchMode=yes', join(here, 'pi-health.service'), `${host}:.config/systemd/user/pi-health.service`]);
  const config = JSON.stringify({ host: brokerHost, port: 1883, username: name, password: login.password, interval: 30 }, null, 2);
  ssh('umask 077 && cat > ~/.config/pi-health/config.json', config);

  console.log(ssh([
    'systemctl --user daemon-reload',
    'systemctl --user enable pi-health.service >/dev/null 2>&1',
    'systemctl --user restart pi-health.service',
    'sleep 3',
    'systemctl --user is-active pi-health.service',
    // Without linger, user services stop when the Pi's user logs out (and start at its login).
    'loginctl enable-linger 2>/dev/null; loginctl show-user "$(whoami)" -p Linger',
  ].join('; ')).trim());
  const linger = ssh('loginctl show-user "$(whoami)" -p Linger').trim();
  if (linger !== 'Linger=yes') {
    console.log(`\nTo keep the agent running when nobody is logged in on ${host}, run there once:\n  sudo loginctl enable-linger $USER`);
  }
  console.log(`\nDone. ${host} reports on devices/${name}/health; see the Raspberry Pis tile on http://localhost/.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
