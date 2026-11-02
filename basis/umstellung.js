import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { befehlAusfuehren, dienstRechte, eigeneSid, rechteSetzen } from './geheimnis.js';
import { melde } from './protokoll.js';

// Läuft erst, wenn die Basis vollständig gestartet ist (nach „bereit“ an den Starter). Schlägt ein Update vorher fehl,
// schaltet der Starter auf die alte Version zurück – deren Dateien sind dann noch im Klartext und lesbar.
//
// 1. Klartext-Geheimnisse verschlüsseln: config.json, data\github.json, data\benachrichtigung.json, Modul-Passwörter.
// 2. Wurde in config.json etwas verschlüsselt: alte Sicherungskopien der config.json löschen (sie enthalten den Klartext).
// 3. Dateirechte: Ordner data und modules nur für SYSTEM, Administratoren und das Konto der Basis; Module, deren
//    Windows-Dienst unter einem eigenen Konto läuft, geben diesem Konto Zugriff auf ihren eigenen Ordner.
//
// Fehler in einem Schritt stoppen die anderen nicht; alles steht im Protokoll (ohne Werte).

// Sicherungskopien, die Basis und --benutzer-anlegen neben config.json anlegen.
const ALTE_KOPIE = /^(backup-[0-9a-f-]{36}|vor-benutzeraenderung)\.json$/;

export async function alteKopienLoeschen(configDatei) {
  const ordner = path.dirname(configDatei);
  const name = path.basename(configDatei);
  const geloescht = [];
  for (const datei of await readdir(ordner).catch(() => [])) {
    if (!datei.startsWith(`${name}.`) || !ALTE_KOPIE.test(datei.slice(name.length + 1))) continue;
    await rm(path.join(ordner, datei), { force: true });
    geloescht.push(datei);
  }
  return geloescht;
}

export async function geheimnisseUmstellen({ tresor, configDatei, konfig, benutzerverwaltung, updates, benachrichtigung, module, log, ausfuehren = befehlAusfuehren() }) {
  if (!tresor?.verfuegbar) {
    melde(log, 'warnung', 'Sicherheit', 'Geheimnisse werden nur unter Windows verschlüsselt gespeichert (DPAPI). Auf diesem System bleiben sie im Klartext.');
    return { verschluesselt: 0 };
  }
  const ergebnis = { verschluesselt: 0, kopien: [], rechte: null, fehler: [] };
  const schritt = async (name, arbeit) => {
    try { return await arbeit(); }
    catch (fehler) { ergebnis.fehler.push(name); melde(log, 'fehler', 'Sicherheit', `${name}: ${fehler.message}`); return 0; }
  };

  const inKonfig = await schritt('Verschlüsseln config.json', () => benutzerverwaltung.konfigVerschluesseln());
  if (inKonfig) {
    log(`config.json: ${inKonfig} Geheimnis${inKonfig === 1 ? '' : 'se'} verschlüsselt.`);
    ergebnis.kopien = await schritt('Alte Sicherungskopien löschen', () => alteKopienLoeschen(configDatei)) || [];
    if (ergebnis.kopien.length) log(`Alte Sicherungskopien mit Klartext gelöscht: ${ergebnis.kopien.join(', ')}.`);
  }
  const github = await schritt('Verschlüsseln data\\github.json', () => updates.tokenVerschluesseln());
  if (github) log('GitHub-Token (Oberfläche) verschlüsselt gespeichert.');
  const mail = await schritt('Verschlüsseln data\\benachrichtigung.json', () => benachrichtigung.verschluesseln());
  if (mail) log('Geheimer Schlüssel für den Mailversand verschlüsselt gespeichert.');
  const mod = await schritt('Verschlüsseln Modul-Passwörter', () => module.geheimnisseVerschluesseln()) || { verschluesselt: 0, klartext: [] };
  if (mod.klartext?.length) melde(log, 'warnung', 'Sicherheit', `Diese Module können noch keine verschlüsselten Passwörter lesen, ihre Passwörter bleiben im Klartext: ${mod.klartext.join(', ')}. Ein Modul-Update behebt das, sobald es verfügbar ist.`);
  ergebnis.verschluesselt = (inKonfig || 0) + (github || 0) + (mail || 0) + (mod.verschluesselt || 0);

  await schritt('Dateirechte', async () => {
    const sid = await eigeneSid(ausfuehren);
    const r = await rechteSetzen([konfig.datenOrdner, konfig.moduleOrdner], { ausfuehren, sid });
    ergebnis.rechte = r;
    if (r.ok.length) log(`Dateirechte gesetzt (nur SYSTEM, Administratoren${sid && !['S-1-5-18', 'S-1-5-32-544'].includes(sid) ? ' und das Konto der Basis' : ''}): ${r.ok.join(', ')}.`);
    for (const f of r.fehler) melde(log, 'warnung', 'Sicherheit', `Dateirechte konnten nicht gesetzt werden – ${f}`);
    // Module, deren Windows-Dienst unter einem eigenen Konto läuft (z. B. FTPModul.exe --installieren --konto).
    const d = await dienstRechte((module.module ?? []).filter((m) => !m.fehler && m.dienst), ausfuehren);
    ergebnis.dienste = d;
    if (d.ok.length) log(`Dienstkonten haben Zugriff auf ihren Modulordner: ${d.ok.join(', ')}.`);
    for (const f of d.fehler) melde(log, 'warnung', 'Sicherheit', `Rechte für das Dienstkonto konnten nicht gesetzt werden – ${f}`);
  });
  return ergebnis;
}
