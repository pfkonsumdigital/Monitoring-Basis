import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BasisFehler } from './fehler.js';

// Geheimnisse (Tokens, Mail-Schlüssel, Modul-Passwörter, Schlüssel der Authenticator-Apps) werden mit der
// Windows-Datenschutz-API (DPAPI) verschlüsselt, gebunden an diesen Rechner (Bereich LocalMachine).
// Gespeichert wird „dpapi:v1:<Base64>“ (Werte der Basis) bzw. „dpapi:m1:<Base64>“ (Passwörter von Modulen).
//
// - dpapi:v1: Zusätzlich zum Rechner an die Schlüsseldatei data\geheimnis.schluessel gebunden. config.json bleibt so
//   für Start.exe lesbar; ohne die Schlüsseldatei (Ordner data, nur SYSTEM/Administratoren) nützen die Werte nichts.
// - dpapi:m1: Für Module (sie kennen den Datenordner der Basis nicht). Geschützt über die Dateirechte des Ordners
//   modules. Die Zusatzentropie ist fest und steht so auch im Modul.
//
// Auf einem anderen Rechner lassen sich die Werte nicht entschlüsseln. Ein Administrator auf diesem Rechner kann es.
// Werte ohne Präfix gelten als Klartext (ältere Versionen) und werden beim Start verschlüsselt.

export const PRAEFIX_BASIS = 'dpapi:v1:';
export const PRAEFIX_MODUL = 'dpapi:m1:';
export const MODUL_ENTROPIE = Buffer.from('Monitoring-Modul/v1', 'utf8');
export const SCHLUESSEL_DATEI = 'geheimnis.schluessel';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const istVerschluesselt = (wert) => typeof wert === 'string' && (wert.startsWith(PRAEFIX_BASIS) || wert.startsWith(PRAEFIX_MODUL));
export const istKlartext = (wert) => typeof wert === 'string' && wert !== '' && !istVerschluesselt(wert);

// PowerShell-Skript: liest {aktion, eintraege:[{d, e}]} (Base64) von der Standardeingabe, schreibt ein JSON-Array.
const SKRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$eingabe = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bereich = [System.Security.Cryptography.DataProtectionScope]::LocalMachine
$aus = New-Object System.Collections.Generic.List[string]
foreach ($x in $eingabe.eintraege) {
  $d = [Convert]::FromBase64String($x.d)
  $e = [Convert]::FromBase64String($x.e)
  if ($eingabe.aktion -eq 'schuetzen') { $r = [System.Security.Cryptography.ProtectedData]::Protect($d, $e, $bereich) }
  else { $r = [System.Security.Cryptography.ProtectedData]::Unprotect($d, $e, $bereich) }
  $aus.Add([Convert]::ToBase64String($r))
}
[Console]::Out.Write((ConvertTo-Json -InputObject $aus.ToArray() -Compress))`;

export function powershellPfad(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Führt die DPAPI-Aufrufe aus (ein PowerShell-Prozess für viele Werte). Liefert Base64-Strings.
export function dpapiPowershell({ spawnImpl = spawn, env = process.env, zeitlimitMs = 60_000 } = {}) {
  return (aktion, eintraege) => new Promise((resolve, reject) => {
    const kind = spawnImpl(powershellPfad(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(SKRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let aus = '';
    let err = '';
    const timer = setTimeout(() => { kind.kill(); reject(new BasisFehler('Windows-Verschlüsselung (DPAPI) antwortet nicht.')); }, zeitlimitMs);
    kind.stdout.setEncoding('utf8').on('data', (t) => { aus += t; });
    kind.stderr.setEncoding('utf8').on('data', (t) => { err += t; });
    kind.once('error', (f) => { clearTimeout(timer); reject(new BasisFehler(`PowerShell konnte nicht gestartet werden: ${f.message}`)); });
    kind.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Keine Werte im Fehlertext: PowerShell gibt nur die Ausnahme aus.
        const grund = /CryptographicException|Schlüssel|key|Daten sind ungültig|data is invalid/i.test(err) ? 'Wert passt nicht zu diesem Rechner oder zur Schlüsseldatei' : err.trim().split(/\r?\n/)[0].slice(0, 200);
        reject(new BasisFehler(`Windows-Verschlüsselung (DPAPI) fehlgeschlagen: ${grund}`));
        return;
      }
      try {
        const liste = JSON.parse(aus.replace(/^\uFEFF/, '').trim() || '[]');
        const werte = Array.isArray(liste) ? liste : [liste];
        if (werte.length !== eintraege.length || werte.some((w) => typeof w !== 'string' || !BASE64.test(w))) throw new Error('unerwartete Antwort');
        resolve(werte);
      } catch (f) { reject(new BasisFehler(`Windows-Verschlüsselung (DPAPI): ${f.message}`)); }
    });
    kind.stdin.end(JSON.stringify({ aktion, eintraege }));
  });
}

// Tresor: ver- und entschlüsselt Werte, merkt sich Paare im Speicher (keine wiederholten PowerShell-Aufrufe).
// verfuegbar=false (nicht Windows): Klartext bleibt Klartext; verschlüsselte Werte lassen sich nicht öffnen.
export class Tresor {
  constructor({ datenOrdner = null, plattform = process.platform, dpapi = null } = {}) {
    this.verfuegbar = plattform === 'win32' || Boolean(dpapi);
    this.dpapi = dpapi ?? (plattform === 'win32' ? dpapiPowershell() : null);
    this.schluesselDatei = datenOrdner ? path.join(datenOrdner, SCHLUESSEL_DATEI) : null;
    this.schluessel = null;
    this.offen = new Map(); // verschlüsselt → Klartext
    this.zu = new Map(); // Präfix + Klartext → verschlüsselt
  }

  // Schlüsseldatei lesen; anlegen nur, wenn sie zum Verschlüsseln gebraucht wird.
  async #schluessel(anlegen) {
    if (this.schluessel) return this.schluessel;
    if (!this.schluesselDatei) throw new BasisFehler('Kein Datenordner für die Schlüsseldatei.');
    try {
      const inhalt = (await readFile(this.schluesselDatei, 'utf8')).trim();
      const s = Buffer.from(inhalt, 'base64');
      if (s.length !== 32) throw new BasisFehler(`${this.schluesselDatei} ist beschädigt.`);
      this.schluessel = s;
    } catch (fehler) {
      if (fehler.code !== 'ENOENT') throw fehler instanceof BasisFehler ? fehler : new BasisFehler(`${this.schluesselDatei} kann nicht gelesen werden: ${fehler.message}`);
      if (!anlegen) throw new BasisFehler(`Die Schlüsseldatei ${this.schluesselDatei} fehlt.`);
      const s = randomBytes(32);
      await mkdir(path.dirname(this.schluesselDatei), { recursive: true });
      const temp = `${this.schluesselDatei}.${process.pid}.tmp`;
      // wx: nie eine vorhandene Datei überschreiben.
      await writeFile(temp, s.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
      try { await rename(temp, this.schluesselDatei); } finally { await unlink(temp).catch(() => {}); }
      this.schluessel = s;
    }
    return this.schluessel;
  }

  // Klartexte verschlüsseln. bereich: 'basis' (dpapi:v1, mit Schlüsseldatei) oder 'modul' (dpapi:m1).
  // Schon verschlüsselte Werte und Leerwerte bleiben, wie sie sind.
  async schuetzen(werte, bereich = 'basis') {
    if (!this.verfuegbar) throw new BasisFehler('Verschlüsselung gibt es nur unter Windows.');
    const praefix = bereich === 'modul' ? PRAEFIX_MODUL : PRAEFIX_BASIS;
    const ergebnis = [...werte];
    const offen = [];
    werte.forEach((w, i) => {
      if (!istKlartext(w)) return;
      const bekannt = this.zu.get(praefix + w);
      if (bekannt) ergebnis[i] = bekannt; else offen.push(i);
    });
    if (offen.length) {
      const entropie = bereich === 'modul' ? MODUL_ENTROPIE : await this.#schluessel(true);
      const roh = await this.dpapi('schuetzen', offen.map((i) => ({ d: Buffer.from(werte[i], 'utf8').toString('base64'), e: entropie.toString('base64') })));
      offen.forEach((i, k) => {
        const geheim = praefix + roh[k];
        ergebnis[i] = geheim;
        this.zu.set(praefix + werte[i], geheim);
        this.offen.set(geheim, werte[i]);
      });
    }
    return ergebnis;
  }

  // Verschlüsselte Werte öffnen; alles andere kommt unverändert zurück.
  async oeffnen(werte) {
    const ergebnis = [...werte];
    const offen = [];
    werte.forEach((w, i) => {
      if (!istVerschluesselt(w)) return;
      if (this.offen.has(w)) ergebnis[i] = this.offen.get(w); else offen.push(i);
    });
    if (!offen.length) return ergebnis;
    if (!this.verfuegbar) throw new BasisFehler('Verschlüsselte Werte lassen sich nur unter Windows auf dem ursprünglichen Rechner öffnen.');
    const eintraege = [];
    for (const i of offen) {
      const w = werte[i];
      const modul = w.startsWith(PRAEFIX_MODUL);
      const daten = w.slice((modul ? PRAEFIX_MODUL : PRAEFIX_BASIS).length);
      if (!BASE64.test(daten)) throw new BasisFehler('Ein verschlüsselter Wert ist beschädigt.');
      eintraege.push({ d: daten, e: (modul ? MODUL_ENTROPIE : await this.#schluessel(false)).toString('base64') });
    }
    const roh = await this.dpapi('oeffnen', eintraege);
    offen.forEach((i, k) => {
      const klar = Buffer.from(roh[k], 'base64').toString('utf8');
      ergebnis[i] = klar;
      this.offen.set(werte[i], klar);
      this.zu.set((werte[i].startsWith(PRAEFIX_MODUL) ? PRAEFIX_MODUL : PRAEFIX_BASIS) + klar, werte[i]);
    });
    return ergebnis;
  }

  async einzeln(wert) { return (await this.oeffnen([wert]))[0]; }
}

// ---- Felder in config.json ----
// Pfade der Geheimnisse; '*' = jeder Benutzer.
const KONFIG_FELDER = [['tls', 'cloudflare_token'], ['tls', 'hetzner_token'], ['updates', 'github_token'], ['benutzer', '*', 'zwei_faktor', 'geheimnis']];

function stellen(roh) {
  const gefunden = [];
  for (const pfad of KONFIG_FELDER) {
    const gehe = (obj, rest) => {
      if (!obj || typeof obj !== 'object') return;
      const [kopf, ...weiter] = rest;
      if (kopf === '*') { for (const k of Object.keys(obj)) gehe(obj[k], weiter); return; }
      if (!weiter.length) { if (typeof obj[kopf] === 'string' && obj[kopf] !== '') gefunden.push({ obj, schluessel: kopf }); return; }
      gehe(obj[kopf], weiter);
    };
    gehe(roh, pfad);
  }
  return gefunden;
}

// Ersetzt verschlüsselte Geheimnisse in einem config.json-Objekt durch Klartext (Kopie).
export async function konfigOeffnen(roh, tresor) {
  const kopie = structuredClone(roh);
  const s = stellen(kopie).filter(({ obj, schluessel }) => istVerschluesselt(obj[schluessel]));
  if (!s.length) return kopie;
  if (!tresor) throw new BasisFehler('config.json enthält verschlüsselte Werte.');
  const klar = await tresor.oeffnen(s.map(({ obj, schluessel }) => obj[schluessel]));
  s.forEach(({ obj, schluessel }, i) => { obj[schluessel] = klar[i]; });
  return kopie;
}

// Verschlüsselt alle Klartext-Geheimnisse in einem config.json-Objekt (Kopie). Liefert { roh, anzahl }.
export async function konfigSchuetzen(roh, tresor) {
  const kopie = structuredClone(roh);
  const s = stellen(kopie).filter(({ obj, schluessel }) => istKlartext(obj[schluessel]));
  if (!s.length) return { roh: kopie, anzahl: 0 };
  const geheim = await tresor.schuetzen(s.map(({ obj, schluessel }) => obj[schluessel]), 'basis');
  s.forEach(({ obj, schluessel }, i) => { obj[schluessel] = geheim[i]; });
  return { roh: kopie, anzahl: s.length };
}

export const konfigKlartextAnzahl = (roh) => stellen(roh).filter(({ obj, schluessel }) => istKlartext(obj[schluessel])).length;

// ---- Dateirechte (Windows) ----
// Ordner nur für SYSTEM, Administratoren und das Konto, unter dem die Basis läuft (über SIDs, unabhängig von der Sprache).
export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATOREN = 'S-1-5-32-544';

export function befehlAusfuehren(spawnImpl = spawn) {
  return (programm, args) => new Promise((resolve) => {
    const kind = spawnImpl(programm, args, { windowsHide: true });
    let aus = '';
    kind.stdout?.setEncoding('utf8').on('data', (t) => { aus += t; });
    kind.stderr?.setEncoding('utf8').on('data', (t) => { aus += t; });
    kind.once('error', (f) => resolve({ code: -1, ausgabe: f.message }));
    kind.once('close', (code) => resolve({ code, ausgabe: aus }));
  });
}

export async function eigeneSid(ausfuehren) {
  const r = await ausfuehren('whoami', ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-[0-9-]+)"/.exec(r.ausgabe ?? '')?.[1];
  return r.code === 0 && sid ? sid : null;
}

// Liefert { ok: [Ordner], fehler: [Text] }.
export async function rechteSetzen(ordner, { ausfuehren, sid }) {
  const konten = [SID_SYSTEM, SID_ADMINISTRATOREN, ...(sid && ![SID_SYSTEM, SID_ADMINISTRATOREN].includes(sid) ? [sid] : [])];
  const ok = [];
  const fehler = [];
  for (const o of ordner) {
    const r1 = await ausfuehren('icacls', [o, '/inheritance:r', '/grant:r', ...konten.map((k) => `*${k}:(OI)(CI)F`), '/Q']);
    // Unterordner und Dateien übernehmen die Rechte des Ordners (alte, eigene Rechte werden zurückgesetzt).
    const r2 = r1.code === 0 ? await ausfuehren('icacls', [path.win32.join(o, '*'), '/reset', '/T', '/C', '/Q']) : null;
    // Ein leerer Ordner (nichts zum Zurücksetzen) ist kein Fehler.
    const leer = r2 && /nicht finden|nicht gefunden|cannot find|not find/i.test(r2.ausgabe);
    if (r1.code === 0 && (r2.code === 0 || leer)) ok.push(o);
    else fehler.push(`${o}: ${(r1.code !== 0 ? r1 : r2).ausgabe.trim().split(/\r?\n/)[0]?.slice(0, 200) || 'icacls fehlgeschlagen'}`);
  }
  return { ok, fehler, konten };
}

// Öffnet die Geheimnisse einer geprüften Konfiguration (Ergebnis von ladeKonfiguration) für den Betrieb (Kopie).
export async function konfigWerteOeffnen(konfig, tresor) {
  const ergebnis = {
    ...konfig,
    tls: { ...konfig.tls },
    updates: konfig.updates ? { ...konfig.updates } : konfig.updates,
    benutzer: Object.fromEntries(Object.entries(konfig.benutzer ?? {}).map(([n, e]) => [n, e.zwei_faktor ? { ...e, zwei_faktor: { ...e.zwei_faktor } } : e])),
  };
  const stellen = [[ergebnis.tls, 'cloudflareToken'], [ergebnis.tls, 'hetznerToken'], [ergebnis.updates, 'githubToken'],
    ...Object.entries(ergebnis.benutzer).filter(([, e]) => e.zwei_faktor).map(([n, e]) => [e.zwei_faktor, 'geheimnis', n])]
    .filter(([obj, k]) => obj && typeof obj[k] === 'string');
  const offen = stellen.filter(([obj, k]) => istVerschluesselt(obj[k]));
  if (offen.length) {
    let klar;
    try { klar = await tresor.oeffnen(offen.map(([obj, k]) => obj[k])); }
    catch (fehler) {
      throw new BasisFehler(`Verschlüsselte Werte in config.json lassen sich nicht öffnen: ${fehler.message}\nAbhilfe: Tokens (tls, updates) neu im Klartext in config.json eintragen – die Basis verschlüsselt sie beim Start wieder – und die Zwei-Faktor-Anmeldungen mit --zwei-faktor-zuruecksetzen <Name> zurücksetzen.`);
    }
    offen.forEach(([obj, k], i) => { obj[k] = klar[i]; });
  }
  for (const [obj, k, name] of stellen) {
    if (name && !/^[A-Z2-7]{16,128}$/.test(obj[k])) throw new BasisFehler(`benutzer.${name}.zwei_faktor ist beschädigt. Zurücksetzen mit: node basis/main.js --zwei-faktor-zuruecksetzen ${name}`);
  }
  return ergebnis;
}

// Konto eines Windows-Dienstes (sc qc). null bei SYSTEM oder wenn unbekannt.
export async function dienstKonto(dienst, ausfuehren) {
  const r = await ausfuehren('sc.exe', ['qc', dienst]);
  const konto = /SERVICE_START_NAME\s*:\s*(.+)/.exec(r.ausgabe ?? '')?.[1]?.trim();
  if (r.code !== 0 || !konto || /^(LocalSystem|NT AUTHORITY\\SYSTEM|NT-AUTORITÄT\\SYSTEM|\.\\LocalSystem)$/i.test(konto)) return null;
  return konto;
}

// Läuft der Dienst eines Moduls unter einem eigenen Konto, bekommt dieses Konto Ändern-Rechte auf seinen Modulordner.
export async function dienstRechte(module, ausfuehren) {
  const ok = [];
  const fehler = [];
  for (const m of module) {
    const konto = await dienstKonto(m.dienst, ausfuehren);
    if (!konto) continue;
    const r = await ausfuehren('icacls', [m.ordner, '/grant', `${konto}:(OI)(CI)M`, '/T', '/C', '/Q']);
    if (r.code === 0) ok.push(`${m.id} (${konto})`);
    else fehler.push(`${m.id} (${konto}): ${r.ausgabe.trim().split(/\r?\n/)[0]?.slice(0, 200) || 'icacls fehlgeschlagen'}`);
  }
  return { ok, fehler };
}
