// CRT Proxy Watchdog
// Calistirir, oldugunde otomatik yeniden baslatir, asiri restart durumunda durur.
//
// Kullanim:
//   node proxy_watchdog.js                 -> default: node crt_ai_proxy_server.js
//   PROXY_CMD="node script.js" node proxy_watchdog.js
//
// Stop: Ctrl+C

const { spawn } = require('child_process');
const path = require('path');

const PROXY_SCRIPT = process.env.PROXY_SCRIPT || 'crt_ai_proxy_server.js';
const MAX_RESTARTS_PER_HOUR = Number(process.env.MAX_RESTARTS_PER_HOUR || 20);
const MIN_UPTIME_MS = Number(process.env.MIN_UPTIME_MS || 5000);
const BASE_DELAY_MS = Number(process.env.BASE_DELAY_MS || 2000);

const cwd = __dirname;
const restartTimestamps = [];
let stopRequested = false;
let currentProcess = null;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] [watchdog] ${msg}`);
}

function pruneOldRestarts() {
  const oneHourAgo = Date.now() - 3600000;
  while (restartTimestamps.length && restartTimestamps[0] < oneHourAgo) restartTimestamps.shift();
}

function spawnProxy() {
  if (stopRequested) return;
  const start = Date.now();
  log(`Starting proxy: node ${PROXY_SCRIPT}`);
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    cwd,
    env: process.env,
    stdio: 'inherit'
  });
  currentProcess = child;

  child.on('exit', (code, signal) => {
    currentProcess = null;
    const uptime = Date.now() - start;
    log(`Proxy exited code=${code} signal=${signal || '-'} uptime=${uptime}ms`);
    if (stopRequested) {
      log('Stop requested, not restarting.');
      return;
    }
    pruneOldRestarts();
    restartTimestamps.push(Date.now());
    if (restartTimestamps.length > MAX_RESTARTS_PER_HOUR) {
      log(`!!! ${restartTimestamps.length} restarts in last hour > ${MAX_RESTARTS_PER_HOUR}. Halting to prevent loop.`);
      process.exit(2);
    }
    const tooFast = uptime < MIN_UPTIME_MS;
    const restartIdx = restartTimestamps.length;
    const backoff = tooFast ? Math.min(60000, BASE_DELAY_MS * Math.pow(2, Math.min(5, restartIdx))) : BASE_DELAY_MS;
    log(`Restarting in ${backoff}ms (${restartIdx} restarts in last hour)...`);
    setTimeout(spawnProxy, backoff);
  });

  child.on('error', (err) => {
    log(`Spawn error: ${err.message}`);
  });
}

function gracefulStop(reason) {
  if (stopRequested) return;
  stopRequested = true;
  log(`Received ${reason}, stopping...`);
  if (currentProcess) {
    try { currentProcess.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (currentProcess) {
        try { currentProcess.kill('SIGKILL'); } catch (_) {}
      }
      process.exit(0);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulStop('SIGINT'));
process.on('SIGTERM', () => gracefulStop('SIGTERM'));
process.on('uncaughtException', (e) => log(`uncaught: ${e.message}`));

log(`CRT Proxy Watchdog starting (cwd=${cwd}, script=${PROXY_SCRIPT}, max_per_hour=${MAX_RESTARTS_PER_HOUR})`);
spawnProxy();
