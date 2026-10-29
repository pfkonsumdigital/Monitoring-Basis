#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BasisFehler } from './fehler.js';
import { ladeKonfiguration } from './konfiguration.js';
import { ladeModule } from './module.js';
import { fuehreAus } from './ausfuehrung.js';
import { Ergebnisspeicher } from './speicher.js';
import { Planer } from './planer.js';
import { Anmeldung, hashPasswort } from './anmeldung.js';
import { Zertifikatsverwaltung } from './zertifikat.js';
import { erstelleAnwendung, starteServer } from './webserver.js';

const APP_ORDNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HILFE = `Monitoring-Basis

node basis/main.js [--config <Datei>]            Basis starten
node basis/main.js --benutzer-anlegen <Name>     Benutzer anlegen oder Passwort ändern
node basis/main.js --zertifikat                  Let's-Encrypt-Zertifikat jetzt holen/erneuern
node basis/main.js --module-pruefen              Module auflisten und prüfen

Standard für --config: config.json im Programmordner.`;

function erstelleLog(datei) {
  return (text) => {
    const zeile = `${new Date().toISOString()} ${text}`;
    console.log(zeile);
    appendFile(datei, zeile + '\n').catch(() => {});
  };
}

// Stellt mehrere Fragen über eine einzige Eingabe; Antworten werden nicht angezeigt.
function verdeckteFragen(fragen) {
  return new Promise((resolve, reject) => {
    const ausgabe = new Writable({ write(_t, _e, fertig) { fertig(); } });
    const rl = readline.createInterface({ input: process.stdin, output: ausgabe, terminal: process.stdin.isTTY });
    const antworten = [];
    process.stdout.write(fragen[0]);
    rl.on('line', (zeile) => {
      antworten.push(zeile);
      process.stdout.write('\n');
      if (antworten.length === fragen.length) { rl.close(); return; }
      process.stdout.write(fragen[antworten.length]);
    });
    rl.once('close', () => (antworten.length === fragen.length ? resolve(antworten) : reject(new BasisFehler('Abgebrochen.'))));
  });
}

async function benutzerAnlegen(configDatei, name) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new BasisFehler('Benutzername: nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich (max. 64).');
  await ladeKonfiguration(configDatei);
  const roh = JSON.parse((await readFile(configDatei, 'utf8')).replace(/^﻿/, ''));
  const [passwort, wiederholung] = await verdeckteFragen([`Neues Passwort für ${name} (mind. 10 Zeichen): `, 'Passwort wiederholen: ']);
  if (passwort !== wiederholung) throw new BasisFehler('Die Passwörter stimmen nicht überein.');
  let hash;
  try { hash = await hashPasswort(passwort); } catch (f) { throw new BasisFehler(f.message); }
  roh.benutzer = { ...(roh.benutzer ?? {}), [name]: { hash } };
  await copyFile(configDatei, `${configDatei}.backup-${randomUUID()}.json`);
  const temp = `${configDatei}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(roh, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, configDatei);
  console.log(`Benutzer ${name} gespeichert. Eine laufende Basis übernimmt die Änderung nach einem Neustart.`);
}

async function starten(konfig, log) {
  const module = await ladeModule(konfig.moduleOrdner);
  for (const m of module) log(m.fehler ? `Modul ${m.name} fehlerhaft: ${m.fehler}` : `Modul ${m.id} (${m.typ}) geladen${m.aktiv ? '' : ', inaktiv'}.`);
  if (!Object.keys(konfig.benutzer).length) throw new BasisFehler('Es ist noch kein Benutzer angelegt. Zuerst: node basis/main.js --benutzer-anlegen <Name>');

  const speicher = new Ergebnisspeicher(konfig.datenOrdner, konfig.verlaufAnzahl);
  await speicher.laden(module.filter((m) => !m.fehler).map((m) => m.id));
  const planer = new Planer({ module, ausfuehren: (m) => fuehreAus(m), speichern: (id, e) => speicher.hinzufuegen(id, e), log });
  const anmeldung = new Anmeldung({ benutzer: konfig.benutzer, sitzungMs: konfig.sitzungMs });
  const zertifikate = new Zertifikatsverwaltung({ konfig, log });
  const tls = await zertifikate.laden();
  const anwendung = erstelleAnwendung({ module, planer, speicher, anmeldung, sitzungMs: konfig.sitzungMs, log });
  let server;
  try { server = await starteServer({ anwendung, tls, host: konfig.host, port: konfig.port }); }
  catch (fehler) {
    throw new BasisFehler(fehler.code === 'EADDRINUSE' ? `Port ${konfig.port} ist bereits belegt.` : fehler.code === 'EACCES' ? `Keine Berechtigung für Port ${konfig.port}.` : `Server konnte nicht starten (${fehler.code || fehler.message}).`);
  }
  zertifikate.automatischErneuern(server);
  planer.start();
  log(`Monitoring-Basis läuft: https://${konfig.hostname}:${konfig.port}/`);

  const beenden = () => {
    log('Monitoring-Basis wird beendet.');
    planer.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', beenden);
  process.once('SIGTERM', beenden);
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args, options: {
      config: { type: 'string' }, 'benutzer-anlegen': { type: 'string' },
      zertifikat: { type: 'boolean' }, 'module-pruefen': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log(HILFE); return 0; }
    const configDatei = path.resolve(values.config ?? path.join(APP_ORDNER, 'config.json'));
    if (values['benutzer-anlegen'] !== undefined) { await benutzerAnlegen(configDatei, values['benutzer-anlegen']); return 0; }

    const konfig = await ladeKonfiguration(configDatei);
    const logOrdner = path.join(path.dirname(configDatei), 'logs');
    await mkdir(logOrdner, { recursive: true });
    const log = erstelleLog(path.join(logOrdner, 'basis.log'));

    if (values['module-pruefen']) {
      const module = await ladeModule(konfig.moduleOrdner);
      if (!module.length) console.log(`Keine Module in ${konfig.moduleOrdner}.`);
      for (const m of module) console.log(m.fehler ? `FEHLER ${m.name}: ${m.fehler}` : `OK     ${m.id}: ${m.name} (${m.typ}, ${m.intervallMinuten ? `alle ${m.intervallMinuten} min` : 'nur manuell'}${m.aktiv ? '' : ', inaktiv'})`);
      return module.some((m) => m.fehler) ? 2 : 0;
    }
    if (values.zertifikat) {
      if (konfig.tls.modus !== 'letsencrypt') throw new BasisFehler('--zertifikat ist nur bei tls.modus "letsencrypt" nötig.');
      await new Zertifikatsverwaltung({ konfig, log }).erneuern();
      return 0;
    }
    await starten(konfig, log);
    return null;
  } catch (fehler) {
    console.error(fehler instanceof BasisFehler ? fehler.message : `Unerwarteter Fehler: ${fehler?.message || fehler}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await main();
  if (code !== null) process.exit(code);
}
