/* =============================================================
   SEMS — Smart Energy Management System
   app.js  |  Firebase + HiveMQ MQTT + Dashboard Logic
   =============================================================
   STEP-BY-STEP CONFIGURATION:
   1. Replace firebaseConfig values with your Firebase project
   2. Replace HIVEMQ_* values with your HiveMQ Cloud credentials
   3. Replace GRAFANA_URL with your Grafana dashboard URL
   4. Adjust RATE_PER_KWH for your local electricity rate
   ============================================================= */

/* ── 1. Firebase Configuration ─────────────────────────────
   Get these from: Firebase Console → Project Settings → General
   ──────────────────────────────────────────────────────────── */
const firebaseConfig = {
  apiKey: "AIzaSyBvS4GjR18QZSoDmBu4In3l22MWcXig2ag",
  authDomain: "sems-1df8e.firebaseapp.com",
  databaseURL: "https://sems-1df8e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sems-1df8e",
  storageBucket: "sems-1df8e.firebasestorage.app",
  messagingSenderId: "983096538953",
  appId: "1:983096538953:web:8fab546947232ec7ad4c98"
};


/* ── 2. HiveMQ MQTT Configuration ─────────────────────────
   Get from: HiveMQ Cloud Console → Your Cluster → Details
   Uses WebSocket over TLS (port 8884) for browser connectivity
   ──────────────────────────────────────────────────────────── */
const HIVEMQ_HOST     = "8612c31e6a2f45bea015b73e9478c6b5.s1.eu.hivemq.cloud";
const HIVEMQ_PORT     = 8884;          // WebSocket TLS port
const HIVEMQ_USER     = "Dratflix";
const HIVEMQ_PASS     = "Sathish2005";
const HIVEMQ_CLIENT   = "SEMS-Dashboard-" + Math.random().toString(16).slice(2, 8);

/* ── 3. MQTT Topics ─────────────────────────────────────── */
const TOPIC_SENSORS = "sems/sensors/pzem";   // ESP32 publishes here
const TOPIC_CONTROL = "sems/control/relay";  // Dashboard publishes here
const TOPIC_ALERTS  = "sems/alerts";         // Alert messages
const TOPIC_STATUS  = "sems/status/esp32";   // ESP32 heartbeat

/* ── 4. Grafana URL ─────────────────────────────────────── */
const GRAFANA_URL = "https://hugepike1982.grafana.net/d/rj4x7hc/sems"; // Update with your URL

/* ── 5. Billing Rate ────────────────────────────────────── */
let RATE_PER_KWH = 0.571; // RM per kWh (Malaysia TNB default)

/* ── 6. Alert Thresholds ────────────────────────────────── */
let thresholds = {
  warnCurrent:  8.0,
  critCurrent:  10.0,
  warnPower:    1800,
  critPower:    2300
};

/* ── Global State ────────────────────────────────────────── */
let mqttClient     = null;
let charts         = {};
let alertLog       = [];
let historyData    = { power: [], voltage: [], current: [], cost: [] };
let energyStart    = 0;  // kWh reading at session start (for today's calc)
let lastSensorData = { voltage: 0, current: 0, power: 0, energy: 0, frequency: 0, pf: 0 };

/* ============================================================
   FIREBASE INIT
   ============================================================ */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.database();

/* ============================================================
   AUTH: LOGIN
   ============================================================ */
function login() {
  const email    = document.getElementById('email')?.value.trim();
  const password = document.getElementById('password')?.value;
  const loader   = document.getElementById('loader');

  if (!email || !password) { showToast('Please enter email and password', 'error'); return; }

  if (loader) loader.classList.add('active');

  auth.signInWithEmailAndPassword(email, password)
    .then(cred => {
      db.ref(`sems/users/${cred.user.uid}/role`).once('value').then(snap => {
        localStorage.setItem('semsUserRole', snap.val() || 'viewer');
        showToast('Login successful!', 'success');
        setTimeout(() => location.href = 'dashboard.html', 800);
      });
    })
    .catch(err => {
      if (loader) loader.classList.remove('active');
      showToast(err.message, 'error');
    });
}

/* Enter key support on login */
document.addEventListener('DOMContentLoaded', () => {
  const pw = document.getElementById('password');
  if (pw) pw.addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
  if (localStorage.getItem('theme') === 'light') document.body.classList.add('light-theme');
});

/* ============================================================
   AUTH: LOGOUT
   ============================================================ */
function logout() {
  showToast('Logging out…', 'success');
  setTimeout(() => {
    if (mqttClient) mqttClient.end(true);
    auth.signOut().then(() => {
      localStorage.removeItem('semsUserRole');
      location.href = 'index.html';
    });
  }, 600);
}

/* ============================================================
   AUTH GUARD — Dashboard only
   ============================================================ */
auth.onAuthStateChanged(user => {
  if (!location.pathname.includes('dashboard')) return;
  if (!user) { location.href = 'index.html'; return; }

  const role = localStorage.getItem('semsUserRole') || 'viewer';
  setText('userRole', role === 'admin' ? 'Admin' : 'Viewer');

  initDashboard();
});

/* ============================================================
   DASHBOARD INIT
   ============================================================ */
function initDashboard() {
  initCharts();
  loadThresholds();
  loadBillingRate();
  connectMQTT();
  startFirebaseListeners();
  setInterval(updateDateTime, 1000);
  updateDateTime();
}

/* ============================================================
   FIREBASE REALTIME LISTENERS
   ============================================================ */
function startFirebaseListeners() {

  /* ── Live sensor data ── */
  db.ref('sems/sensors').on('value', snap => {
    const d = snap.val();
    if (!d) return;

    const v    = parseFloat(d.voltage   || 0);
    const i    = parseFloat(d.current   || 0);
    const p    = parseFloat(d.power     || 0);
    const e    = parseFloat(d.energy    || 0);
    const hz   = parseFloat(d.frequency || 0);
    const pf   = parseFloat(d.pf        || 0);
    const tier = parseInt(d.alert_tier  || 1);

    // Cache
    lastSensorData = { voltage: v, current: i, power: p, energy: e, frequency: hz, pf };

    // Animate numbers
    animateNum('voltage',     v,  1);
    animateNum('current',     i,  2);
    animateNum('power',       p,  1);
    animateNum('energyToday', e,  3);
    animateNum('energyTotal', e,  3);
    animateNum('frequency',   hz, 1);
    animateNum('powerFactor', pf, 2);

    // Gauges (max values: 260V, 100A, 3000W, 1.0PF, 60Hz, 20kWh, 9999kWh)
    setGauge('voltageGauge',     v,   260);
    setGauge('currentGauge',     i,   100);
    setGauge('powerGauge',       p,   3000);
    setGauge('pfGauge',          pf,  1);
    setGauge('freqGauge',        hz,  60);
    setGauge('energyTodayGauge', e,   20);
    setGauge('energyTotalGauge', e,   9999);

    // Chart update
    addChartData('power',   p);
    addChartData('voltage', v);
    addChartData('current', i);
    setText('chartPowerValue',   p.toFixed(1)  + ' W');
    setText('chartVoltageValue', v.toFixed(1)  + ' V');
    setText('chartCurrentValue', i.toFixed(2)  + ' A');

    // Billing
    const todayCost  = e * RATE_PER_KWH;
    const monthCost  = todayCost * 30;
    animateNum('costToday', todayCost, 2);
    animateNum('costMonth', monthCost, 2);
    animateNum('costTotal', todayCost, 2); // cumulative handled separately
    addChartData('cost', todayCost);
    setText('chartCostValue', 'RM ' + todayCost.toFixed(3));
    setText('unitRate', RATE_PER_KWH.toFixed(3));

    // Highlight cards based on alert tier
    evaluateAlertTier(v, i, p, hz, pf, tier);
  });

  /* ── Control state ── */
  db.ref('sems/control').on('value', snap => {
    const d = snap.val();
    if (!d) return;
    const r1 = document.getElementById('relay1Toggle');
    if (r1) {
      r1.checked = d.relay === true || d.relay === 1;
      setText('relay1State', r1.checked ? 'ON' : 'OFF');
      setText('relay1Note', r1.checked ? 'Load is ACTIVE' : 'Load is OFF');
    }
    const ac = document.getElementById('autoCutoffToggle');
    if (ac) {
      ac.checked = d.auto_cutoff === true || d.auto_cutoff === 1;
      setText('autoCutoffState', ac.checked ? 'ON' : 'OFF');
    }
  });

  /* ── ESP32 status ── */
  db.ref('sems/status/esp32').on('value', snap => {
    const d = snap.val();
    if (!d) return;
    const online = d.status === 'online';
    setDot('esp32StatusDot', online ? 'online' : 'offline');
    setDot('pzemStatusDot',  online ? 'online' : 'offline');
    setText('esp32IP', d.ip || '---');
    setText('pzemStatus', online ? 'Reading' : 'Offline');
    setDot('firebaseDot', 'online');
  });

  /* ── Alert log from Firebase ── */
  db.ref('sems/alerts').limitToLast(50).on('value', snap => {
    if (!snap.val()) return;
    // Only push new ones we haven't seen
    const entries = Object.values(snap.val());
    entries.forEach(entry => {
      const exists = alertLog.some(a => a.ts === entry.ts);
      if (!exists && entry.tier > 1) alertLog.push(entry);
    });
    renderAlertLog();
  });

  /* ── Settings ── */
  db.ref('sems/settings').once('value').then(snap => {
    const s = snap.val();
    if (!s) return;
    if (s.unit_rate)    { RATE_PER_KWH = s.unit_rate; document.getElementById('rateInput').value = s.unit_rate; }
    if (s.thresh_warn_current)  document.getElementById('threshWarnCurrent').value = s.thresh_warn_current;
    if (s.thresh_crit_current)  document.getElementById('threshCritCurrent').value = s.thresh_crit_current;
    if (s.thresh_warn_power)    document.getElementById('threshWarnPower').value   = s.thresh_warn_power;
    if (s.thresh_crit_power)    document.getElementById('threshCritPower').value   = s.thresh_crit_power;
  });
}

/* ============================================================
   ALERT TIER EVALUATION (3-Tier SEMS Logic)
   ============================================================ */
function evaluateAlertTier(v, i, p, hz, pf, tier) {
  // Use tier from ESP32 if available, else compute locally
  if (!tier || tier < 1) {
    if (i >= thresholds.critCurrent || p >= thresholds.critPower) tier = 3;
    else if (i >= thresholds.warnCurrent || p >= thresholds.warnPower) tier = 2;
    else tier = 1;
  }

  const card  = document.getElementById('alertStatusCard');
  const icon  = document.getElementById('alertIconBig');
  const disp  = document.getElementById('alertTierDisplay');
  const sub   = document.getElementById('alertTierSub');

  // Remove all tier classes
  card.classList.remove('tier1-state', 'tier2-state', 'tier3-state');

  // Clear all alert banners
  ['alertTier1','alertTier2','alertTier3'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });

  if (tier === 1) {
    card.classList.add('tier1-state');
    icon.textContent  = '🟢';
    disp.textContent  = 'TIER 1';
    sub.textContent   = 'Normal — No action needed';
    showAlertBanner('alertTier1', `V:${v.toFixed(1)}V  I:${i.toFixed(2)}A  P:${p.toFixed(1)}W — All within normal range`);
  } else if (tier === 2) {
    card.classList.add('tier2-state');
    icon.textContent  = '🟡';
    disp.textContent  = 'TIER 2';
    sub.textContent   = 'Warning — Take precautionary action';
    showAlertBanner('alertTier2', `Current ${i.toFixed(2)}A / Power ${p.toFixed(1)}W approaching threshold`);
    pushAlertLog(2, i, p, 'Approaching threshold');
  } else if (tier === 3) {
    card.classList.add('tier3-state');
    icon.textContent  = '🔴';
    disp.textContent  = 'TIER 3';
    sub.textContent   = 'CRITICAL — Overcurrent! Relay may trip';
    showAlertBanner('alertTier3', `OVERCURRENT: I=${i.toFixed(2)}A  P=${p.toFixed(1)}W — Auto cut-off triggered`);
    pushAlertLog(3, i, p, 'Overcurrent — relay tripped');
    // Flash voltage card red
    document.getElementById('currentCard')?.style.setProperty('border-color', 'var(--red)');
  } else {
    document.getElementById('currentCard')?.style.removeProperty('border-color');
  }
}

function showAlertBanner(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  const msgEl = el.querySelector('span:last-of-type');
  if (msgEl) msgEl.textContent = msg;
  el.classList.add('active');
}

function dismissAlert(id) {
  document.getElementById(id)?.classList.remove('active');
}

/* ============================================================
   ALERT LOG
   ============================================================ */
function pushAlertLog(tier, current, power, message) {
  const entry = {
    ts:      new Date().toISOString(),
    tier,
    metric:  tier === 2 ? 'Current/Power' : 'OVERCURRENT',
    value:   `${current.toFixed(2)}A / ${power.toFixed(0)}W`,
    message
  };
  alertLog.unshift(entry);
  if (alertLog.length > 100) alertLog.pop();

  // Write to Firebase
  db.ref('sems/alerts').push(entry);
  renderAlertLog();
}

function renderAlertLog() {
  const body = document.getElementById('alertLogBody');
  if (!body) return;
  if (alertLog.length === 0) {
    body.innerHTML = '<div class="alert-log-empty">No alerts recorded yet.</div>';
    return;
  }
  body.innerHTML = alertLog.slice(0, 30).map(a => `
    <div class="alert-log-row tier-${a.tier}">
      <span>${new Date(a.ts).toLocaleString()}</span>
      <span>TIER ${a.tier}</span>
      <span>${a.metric || '—'}</span>
      <span>${a.value  || '—'}</span>
      <span>${a.message}</span>
    </div>
  `).join('');
}

function clearAlertLog() {
  alertLog = [];
  renderAlertLog();
  showToast('Alert log cleared', 'success');
}

/* ============================================================
   RELAY CONTROL
   ============================================================ */
function setRelay(channel, state) {
  // Write to Firebase (ESP32 polls this)
  db.ref('sems/control/relay').set(state ? 1 : 0);

  // Publish via MQTT
  const msg = JSON.stringify({ relay: state ? 1 : 0, channel, ts: Date.now() });
  if (mqttClient && mqttClient.isConnected()) {
    mqttClient.send(TOPIC_CONTROL, msg, 0, false);
    setText('mqttPubState', 'SENT');
    setTimeout(() => setText('mqttPubState', 'IDLE'), 2000);
  }

  showToast(`Relay ${channel} ${state ? 'ON' : 'OFF'}`, state ? 'success' : 'warn');
  setText('relay1State', state ? 'ON' : 'OFF');
  setText('relay1Note', state ? 'Load is ACTIVE' : 'Load is OFF');
}

function setAutoCutoff(state) {
  db.ref('sems/control/auto_cutoff').set(state ? 1 : 0);
  setText('autoCutoffState', state ? 'ON' : 'OFF');
  showToast(`Auto cut-off ${state ? 'enabled' : 'disabled'}`, 'success');
}

/* ============================================================
   BILLING
   ============================================================ */
function saveUnitRate() {
  const val = parseFloat(document.getElementById('rateInput').value);
  if (isNaN(val) || val <= 0) { showToast('Invalid rate', 'error'); return; }
  RATE_PER_KWH = val;
  db.ref('sems/settings/unit_rate').set(val);
  showToast(`Rate saved: RM ${val.toFixed(3)}/kWh`, 'success');
  setText('unitRate', val.toFixed(3));
}

function loadBillingRate() {
  const stored = localStorage.getItem('semsUnitRate');
  if (stored) {
    RATE_PER_KWH = parseFloat(stored);
    const ri = document.getElementById('rateInput');
    if (ri) ri.value = RATE_PER_KWH;
  }
}

/* ============================================================
   THRESHOLDS
   ============================================================ */
function saveThresholds() {
  thresholds.warnCurrent = parseFloat(document.getElementById('threshWarnCurrent').value) || 8;
  thresholds.critCurrent = parseFloat(document.getElementById('threshCritCurrent').value) || 10;
  thresholds.warnPower   = parseFloat(document.getElementById('threshWarnPower').value)   || 1800;
  thresholds.critPower   = parseFloat(document.getElementById('threshCritPower').value)   || 2300;

  db.ref('sems/settings').update({
    thresh_warn_current: thresholds.warnCurrent,
    thresh_crit_current: thresholds.critCurrent,
    thresh_warn_power:   thresholds.warnPower,
    thresh_crit_power:   thresholds.critPower
  });
  showToast('Thresholds saved', 'success');
}

function loadThresholds() {
  const wc = document.getElementById('threshWarnCurrent');
  const cc = document.getElementById('threshCritCurrent');
  const wp = document.getElementById('threshWarnPower');
  const cp = document.getElementById('threshCritPower');
  if (wc) wc.value = thresholds.warnCurrent;
  if (cc) cc.value = thresholds.critCurrent;
  if (wp) wp.value = thresholds.warnPower;
  if (cp) cp.value = thresholds.critPower;
}

/* ============================================================
   HiveMQ MQTT (WebSocket over TLS)
   ============================================================ */
function connectMQTT() {
  // Load the Paho MQTT library dynamically
  const script = document.createElement('script');
  script.src   = 'https://cdnjs.cloudflare.com/ajax/libs/paho-mqtt/1.0.1/mqttws31.min.js';
  script.onload = () => initPahoMQTT();
  document.head.appendChild(script);
}

function initPahoMQTT() {
  if (typeof Paho === 'undefined') { console.warn('Paho MQTT not loaded'); return; }

  mqttClient = new Paho.MQTT.Client(HIVEMQ_HOST, HIVEMQ_PORT, '/mqtt', HIVEMQ_CLIENT);

  mqttClient.onConnectionLost = resp => {
    setDot('mqttDot', 'offline');
    setText('mqttStatusText', 'MQTT ✗');
    setText('mqttPubState', 'DISCONNECTED');
    if (resp.errorCode !== 0) {
      console.warn('MQTT lost:', resp.errorMessage);
      setTimeout(initPahoMQTT, 5000); // Reconnect
    }
  };

  mqttClient.onMessageArrived = msg => {
    try {
      const data = JSON.parse(msg.payloadString);
      if (msg.destinationName === TOPIC_SENSORS) {
        handleMQTTSensorData(data);
      } else if (msg.destinationName === TOPIC_ALERTS) {
        handleMQTTAlert(data);
      } else if (msg.destinationName === TOPIC_STATUS) {
        handleMQTTStatus(data);
      }
    } catch(e) { /* ignore malformed */ }
  };

  const opts = {
    useSSL:   true,
    userName: HIVEMQ_USER,
    password: HIVEMQ_PASS,
    onSuccess: () => {
      setDot('mqttDot', 'online');
      setText('mqttStatusText', 'MQTT ✓');
      mqttClient.subscribe(TOPIC_SENSORS);
      mqttClient.subscribe(TOPIC_ALERTS);
      mqttClient.subscribe(TOPIC_STATUS);
      showToast('HiveMQ MQTT connected', 'success');
    },
    onFailure: err => {
      setDot('mqttDot', 'offline');
      setText('mqttStatusText', 'MQTT ✗');
      console.warn('MQTT connect failed:', err.errorMessage);
      setTimeout(initPahoMQTT, 8000); // Retry
    }
  };

  mqttClient.connect(opts);
}

function handleMQTTSensorData(d) {
  // MQTT data shadows Firebase — update charts in real time
  if (d.p  !== undefined) addChartData('power',   d.p);
  if (d.v  !== undefined) addChartData('voltage', d.v);
  if (d.i  !== undefined) addChartData('current', d.i);
}

function handleMQTTAlert(d) {
  if (d.tier >= 2) pushAlertLog(d.tier, d.current || 0, d.power || 0, 'Alert from ESP32 via MQTT');
}

function handleMQTTStatus(d) {
  const online = d.status === 'online';
  setDot('esp32StatusDot', online ? 'online' : 'offline');
}

function publishTestMQTT() {
  if (!mqttClient || !mqttClient.isConnected()) {
    showToast('MQTT not connected', 'error'); return;
  }
  const msg = new Paho.MQTT.Message(JSON.stringify({ test: true, ts: Date.now(), from: 'dashboard' }));
  msg.destinationName = TOPIC_CONTROL;
  mqttClient.send(msg);
  setText('mqttPubState', 'SENT ✓');
  setTimeout(() => setText('mqttPubState', 'IDLE'), 2000);
  showToast('Test message published to HiveMQ', 'success');
}

/* ============================================================
   GRAFANA
   ============================================================ */
function openGrafana() {
  if (GRAFANA_URL && !GRAFANA_URL.includes('localhost')) {
    window.open(GRAFANA_URL, '_blank');
  } else {
    showToast('Update GRAFANA_URL in app.js', 'warn');
  }
  return false;
}

/* ============================================================
   CHARTS (Chart.js)
   ============================================================ */
function initCharts() {
  Chart.defaults.color = 'rgba(255,255,255,0.4)';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

  const mkConfig = (color, label) => ({
    type: 'line',
    data: {
      labels: [],
      datasets: [{ label, data: [], borderColor: color, borderWidth: 2,
        backgroundColor: color + '18', fill: true, tension: 0.4,
        pointRadius: 2, pointHoverRadius: 5 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxTicksLimit: 6, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 10 } } }
      },
      animation: { duration: 400, easing: 'easeOutQuart' }
    }
  });

  const get = id => { const el = document.getElementById(id); return el ? el.getContext('2d') : null; };

  if (get('powerChart'))   charts.power   = new Chart(get('powerChart'),   mkConfig('#ffd600',   'Power W'));
  if (get('voltageChart')) charts.voltage = new Chart(get('voltageChart'), mkConfig('#00d4ff',   'Voltage V'));
  if (get('currentChart')) charts.current = new Chart(get('currentChart'), mkConfig('#7c3aed',   'Current A'));
  if (get('costChart'))    charts.cost    = new Chart(get('costChart'),    mkConfig('#00ff9c',   'Cost RM'));
}

function addChartData(key, value) {
  if (!historyData[key]) historyData[key] = [];
  const label = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  historyData[key].push({ label, value });
  if (historyData[key].length > 20) historyData[key].shift();

  if (charts[key]) {
    charts[key].data.labels                  = historyData[key].map(d => d.label);
    charts[key].data.datasets[0].data        = historyData[key].map(d => d.value);
    charts[key].update('none');
  }
}

/* ============================================================
   FIRMWARE COPY
   ============================================================ */
function copyFirmware() {
  const code = document.getElementById('firmwareCode')?.textContent || '';
  navigator.clipboard.writeText(code).then(() => showToast('Firmware code copied!', 'success'));
}

/* ============================================================
   DATE / TIME
   ============================================================ */
function updateDateTime() {
  const now = new Date();
  setText('time', now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  setText('date', now.toLocaleDateString('en-MY', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }));
  const h = now.getHours();
  setText('greeting',
    h < 5  ? 'Good Night! 🌙' :
    h < 12 ? 'Good Morning! ☀️' :
    h < 18 ? 'Good Afternoon! 🌤️' :
    h < 21 ? 'Good Evening! 🌇' : 'Good Night! 🌙');
}
setInterval(updateDateTime, 1000);
updateDateTime();

/* ============================================================
   THEME
   ============================================================ */
function toggleTheme() {
  document.body.classList.toggle('light-theme');
  localStorage.setItem('theme', document.body.classList.contains('light-theme') ? 'light' : 'dark');
  showToast(document.body.classList.contains('light-theme') ? '☀️ Light mode' : '🌙 Dark mode', 'success');
}
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('theme') === 'light') document.body.classList.add('light-theme');
});

/* ============================================================
   HELPERS
   ============================================================ */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setDot(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-dot ' + state;
}

function setGauge(id, val, max) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.min((val / max) * 100, 100) + '%';
}

function animateNum(id, newVal, dec) {
  const el = document.getElementById(id);
  if (!el) return;
  const cur  = parseFloat(el.textContent) || 0;
  const diff = newVal - cur;
  const steps = 15;
  let   step  = 0;
  const anim = setInterval(() => {
    step++;
    el.textContent = (cur + diff * (step / steps)).toFixed(dec);
    if (step >= steps) { clearInterval(anim); el.textContent = newVal.toFixed(dec); }
  }, 25);
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = `toast ${type}`;
  void t.offsetWidth;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

console.log('%c SEMS v1.0 — Smart Energy Management System ', 'background:linear-gradient(135deg,#00d4ff,#7c3aed);color:white;padding:10px 20px;border-radius:8px;font-weight:bold;font-size:14px;');
