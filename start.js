#!/usr/bin/env node
// Fester Starter der Monitoring-Basis. Er wird durch Online-Updates NICHT ersetzt und ist
// deshalb bewusst klein und ohne Abhängigkeiten. Er startet die in aktiv.json eingetragene
// Version, startet nach einem Update neu und schaltet automatisch auf die vorherige Version
// zurück, wenn eine frisch installierte Version nicht hochkommt.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NEUSTART_CODE = 3;

function leseAktiv(installOrdner) {
  try {
    const wert = JSON.parse(readFileSync(path.join(installOrdner, 'aktiv.json'), 'utf8'));
    return { aktiv: wert.aktiv ?? '.', vorher: wert.vorher ?? null, probe: wert.probe === true };
  } catch {
    return { aktiv: '.', vorher: null, probe: false };
  }
}

function schreibeAktiv(installOrdner, wert) {
  const datei = path.join(installOrdner, 'aktiv.json');
  writeFileSync(`${datei}.tmp`, JSON.stringify(wert, null, 2) + '\n');
  renameSync(`${datei}.tmp`, datei);
}

export async function starter({
  installOrdner, configDatei = path.join(installOrdner, 'config.json'), log, bereitMs = 60_000, pauseMs = 10_000,
  spawnImpl = spawn, signale = process,
}) {
  let beenden = false, kind = null;
  const stopp = () => { beenden = true; kind?.kill('SIGTERM'); };
  signale.once?.('SIGINT', stopp);
  signale.once?.('SIGTERM', stopp);

  while (!beenden) {
    const stand = leseAktiv(installOrdner);
    const programm = path.resolve(installOrdner, stand.aktiv, 'basis', 'main.js');
    log(`Starte ${stand.aktiv === '.' ? 'Grundinstallation' : stand.aktiv}${stand.probe ? ' (neue Version, wird geprüft)' : ''}.`);

    let bereit = false;
    const code = await new Promise((resolve) => {
      if (!existsSync(programm)) { log(`Programm fehlt: ${programm}`); resolve(-1); return; }
      kind = spawnImpl(process.execPath, [programm, '--config', configDatei], {
        cwd: installOrdner, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
        env: { ...process.env, MONITOR_STARTER: '1', MONITOR_INSTALL_ORDNER: installOrdner },
      });
      const timer = stand.probe ? setTimeout(() => { if (!bereit) { log(`Neue Version meldet sich nicht innerhalb von ${bereitMs / 1000} s.`); kind.kill('SIGKILL'); } }, bereitMs) : null;
      kind.on('message', (nachricht) => {
        if (nachricht?.typ !== 'bereit' || bereit) return;
        bereit = true;
        clearTimeout(timer);
        if (stand.probe) {
          schreibeAktiv(installOrdner, { ...stand, probe: false });
          log(`Neue Version läuft (${nachricht.version ?? stand.aktiv}).`);
        }
      });
      kind.once('error', (fehler) => { clearTimeout(timer); log(`Start fehlgeschlagen: ${fehler.message}`); resolve(-1); });
      kind.once('exit', (exitcode) => { clearTimeout(timer); resolve(exitcode ?? -1); });
    });
    kind = null;
    if (beenden) break;
    if (code === NEUSTART_CODE) continue;

    if (stand.probe && !bereit) {
      if (stand.vorher) {
        schreibeAktiv(installOrdner, { aktiv: stand.vorher, vorher: null, probe: false });
        log(`Neue Version ${stand.aktiv} ist fehlgeschlagen (Code ${code}). Automatisch zurück auf ${stand.vorher}.`);
        continue;
      }
      schreibeAktiv(installOrdner, { ...stand, probe: false });
    }
    if (code === 0) break;
    log(`Basis beendet mit Code ${code}. Neuer Start in ${pauseMs / 1000} s.`);
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  signale.off?.('SIGINT', stopp);
  signale.off?.('SIGTERM', stopp);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const installOrdner = path.dirname(fileURLToPath(import.meta.url));
  const configIndex = process.argv.indexOf('--config');
  const configDatei = configIndex > 0 ? path.resolve(process.argv[configIndex + 1]) : path.join(installOrdner, 'config.json');
  const logOrdner = path.join(path.dirname(configDatei), 'logs');
  mkdirSync(logOrdner, { recursive: true });
  const log = (text) => {
    const zeile = `${new Date().toISOString()} [Starter] ${text}`;
    console.log(zeile);
    try { appendFileSync(path.join(logOrdner, 'basis.log'), zeile + '\n'); } catch { /* Protokoll ist ergänzend */ }
  };
  process.exitCode = await starter({ installOrdner, configDatei, log });
}
