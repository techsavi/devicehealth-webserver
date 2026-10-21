// Live view of the local MQTT broker for the pages (../index.html and ./index.html), over the
// anonymous, read-only WebSocket at /mqtt/ws (Caddy -> the broker's 9001 listener). Needs
// /vendor/mqtt.min.js loaded first.
//
//   alerts/<source>/<id>   retained JSON per active alert ({level, title, message, since, ...});
//                          an empty message clears it
//   status/<client>        "online" / "offline" (the broker's last will when a client drops)
//   $SYS/broker/...        broker statistics (Mosquitto updates them every 10 s)
//
// mqttBus(onChange, { sys }) calls onChange(state) whenever anything changes:
//   state = { connected, error, alerts: Map("source/id" -> alert), clients: Map(name -> {state, at}),
//             health: Map(device -> devices/<device>/health JSON, plus _received: when it arrived),
//             wifi: Map(device -> devices/<device>/wifi JSON {dbm, pct, ssid, bssid, channel, at?}, plus
//                   _received): a live signal reading, from sketches that publish one (nodemcu_nodisp),
//             registry: Map(name -> registry/devices/<name> JSON: the hub's {name, kind, subtitle, sshHost?, addedAt}),
//             sys: {topic: value}, topics, log }
// With sys: true (the details page) it subscribes to everything this read-only login may read
// (# and $SYS/#) and also keeps every $SYS/broker/# value, every topic seen in topics
// (Map(topic -> {text, retained, count, at})) and the last 100 non-$SYS messages in log.

window.MQTT_RANK = { info: 0, warning: 1, critical: 2 };

window.mqttBus = function mqttBus(onChange, { sys = false } = {}) {
  const state = { connected: false, error: null, alerts: new Map(), clients: new Map(), health: new Map(), wifi: new Map(), registry: new Map(), sys: {}, topics: new Map(), log: [] };
  if (!window.mqtt) {
    state.error = 'MQTT library not loaded (run npm install in the webserver folder)';
    onChange(state);
    return state;
  }
  let timer = null;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => onChange(state), 100); };
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mqtt/ws`;
  const client = window.mqtt.connect(url, { reconnectPeriod: 5000, clientId: `page-${Math.random().toString(16).slice(2, 10)}` });
  client.on('connect', () => {
    Object.assign(state, { connected: true, error: null });
    state.alerts.clear();
    state.clients.clear();
    state.health.clear();
    state.wifi.clear();
    state.registry.clear();
    state.topics.clear();
    // '#' doesn't match $SYS topics, so the details page subscribes to both. (One subscription per
    // message keeps the broker from delivering overlapping matches twice.)
    client.subscribe(sys ? ['#', '$SYS/#'] : ['alerts/+/+', 'status/+', 'devices/+/health', 'devices/+/wifi', 'registry/devices/+', '$SYS/broker/clients/connected']);
    changed();
  });
  client.on('close', () => { if (state.connected) { state.connected = false; changed(); } });
  client.on('error', (e) => { state.error = e.message; changed(); });
  client.on('message', (topic, payload, packet) => {
    const text = payload.toString();
    if (sys) {
      const seen = state.topics.get(topic);
      if (!text && packet.retain) state.topics.delete(topic);   // a cleared retained topic
      else state.topics.set(topic, { text, retained: packet.retain, count: (seen?.count ?? 0) + 1, at: Date.now() });
    }
    const parts = topic.split('/');
    if (parts[0] === 'alerts' && parts.length === 3) {
      const [, source, id] = parts;
      if (!text) state.alerts.delete(`${source}/${id}`);
      else try { state.alerts.set(`${source}/${id}`, { source, id, ...JSON.parse(text) }); } catch { /* not JSON: ignore */ }
    } else if (parts[0] === 'status' && parts.length === 2) {
      state.clients.set(parts[1], { state: text, at: Date.now() });
    } else if (parts[0] === 'devices' && parts[2] === 'health' && parts.length === 3) {
      if (!text) state.health.delete(parts[1]);
      else try { state.health.set(parts[1], { ...JSON.parse(text), _received: Date.now() / 1000 }); } catch { /* not JSON: ignore */ }
    } else if (parts[0] === 'devices' && parts[2] === 'wifi' && parts.length === 3) {
      if (!text) state.wifi.delete(parts[1]);
      else try { state.wifi.set(parts[1], { ...JSON.parse(text), _received: Date.now() / 1000 }); } catch { /* not JSON: ignore */ }
    } else if (parts[0] === 'registry' && parts[1] === 'devices' && parts.length === 3) {
      if (!text) state.registry.delete(parts[2]);
      else try { state.registry.set(parts[2], JSON.parse(text)); } catch { /* not JSON: ignore */ }
    } else if (topic.startsWith('$SYS/broker/')) {
      state.sys[topic.slice('$SYS/broker/'.length)] = text;
      return changed();
    }
    if (sys && !topic.startsWith('$SYS/')) {
      state.log.unshift({ at: Date.now(), topic, text, retained: packet.retain });
      state.log.length = Math.min(state.log.length, 100);
    }
    changed();
  });
  return state;
};

// Who an alert is from, for display: the topic's source, or where that source got it from
// (TabletPanel relays NWS weather alerts with sentBy "nws").
window.mqttSource = (a) => ({ nws: 'NWS' })[a.sentBy] ?? a.source;

// The IoT devices (Raspberry Pis, NodeMCUs...): every registered one and every one that reports
// health with a "kind", by name, with { name, kind, entry (registry or null), health (or null),
// online, status, last }. The kind is the registry's, else the device's own. A device is online
// when its status/<name> says so and its last report is under 2 minutes old (a NodeMCU's report
// has no time until NTP has set its clock: then when it arrived counts).
window.DEVICE_KINDS = {
  'raspberry-pi': { title: 'Raspberry Pis', one: 'Raspberry Pi' },
  nodemcu: { title: 'NodeMCU devices', one: 'NodeMCU (ESP8266)' },
  other: { title: 'Other devices', one: 'Other' },
};
// A device's "Show alerts" setting (its registry entry's "alerts"; absent = its own default).
window.ALERT_SETTINGS = [
  ['', 'Default'], ['all', 'All alerts'], ['warning', 'Warnings and up'], ['critical', 'Critical only'], ['off', 'Off'],
];
// Tablets (registry kind "tablet") don't report over MQTT: the devices page lists them from TabletPanel.
window.mqttDevices = (state) => {
  const names = new Set([...[...state.registry].filter(([, e]) => e.kind !== 'tablet').map(([n]) => n),
    ...[...state.health].filter(([, h]) => h.kind).map(([n]) => n)]);
  const now = Date.now() / 1000;
  return [...names].sort().map((name) => {
    const health = state.health.get(name) ?? null, entry = state.registry.get(name) ?? null;
    const kind = DEVICE_KINDS[entry?.kind] ? entry.kind : DEVICE_KINDS[health?.kind] ? health.kind : 'other';
    const last = health ? (health.at ?? health._received) : null;
    const online = state.clients.get(name)?.state === 'online' && !!health && now - last < 120;
    // Out of service (taken offline on purpose, its registry entry's "outOfService"): its being
    // offline isn't a problem, so the pages leave it out of the "N of M online" counts.
    const outOfService = !!entry?.outOfService && !online;
    const status = outOfService ? 'out of service' : !health ? 'never reported' : online ? 'online' : 'offline';
    return { name, kind, entry, health, online, outOfService, status, last };
  });
};

// "N of M online" over the devices that should be up (out-of-service ones are left out), e.g.
// { online: 3, of: 3, away: 1, text: '3 of 3 online · 1 out of service', cls: 'on' }.
window.onlineSummary = (list) => {
  const active = list.filter((d) => !d.outOfService), online = active.filter((d) => d.online).length, away = list.length - active.length;
  return {
    online, of: active.length, away,
    text: `${online} of ${active.length} online${away ? ` · ${away} out of service` : ''}`,
    cls: online === active.length ? 'on' : online ? 'warn' : 'off',
  };
};

// An alert's "help" as HTML: its first line says what is wrong, each further line is a numbered step,
// and `backticks` mark a command. Its "link" (only a path or an http(s) URL) goes to the details.
window.mqttHelpHtml = (a, esc) => {
  if (!a.help) return '';
  const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const [why, ...steps] = String(a.help ?? '').split('\n').filter(Boolean);
  const link = typeof a.link === 'string' && /^(\/|https?:\/\/)/.test(a.link) && a.link !== location.pathname ? a.link : null;   // not to this page
  return `${why ? `<p>${code(why)}</p>` : ''}${steps.length ? `<ol>${steps.map((s) => `<li>${code(s)}</li>`).join('')}</ol>` : ''}`
    + (link ? `<p><a href="${esc(link)}">More details →</a></p>` : '');
};

// Active alerts at or above a level, most severe and then oldest first.
window.mqttAlerts = (state, min = 'info') => [...state.alerts.values()]
  .filter((a) => (MQTT_RANK[a.level] ?? 0) >= MQTT_RANK[min])
  .sort((a, b) => (MQTT_RANK[b.level] ?? 0) - (MQTT_RANK[a.level] ?? 0) || (a.since ?? 0) - (b.since ?? 0));
