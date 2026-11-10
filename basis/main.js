#!/usr/bin/env node
import { readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BasisFehler } from './fehler.js';
import { adminNetzPruefer, ladeKonfiguration } from './konfiguration.js';
import { ladeModule } from './module.js';
import { fuehreAus } from './ausfuehrung.js';
import { Ergebnisspeicher } from './speicher.js';
import { Planer } from './planer.js';
import { Modulverwaltung } from './modulverwaltung.js';
import { Freigaben } from './freigabe.js';
import { Benachrichtigung } from './benachrichtigung.js';
import { Modulupdates } from './modulupdates.js';
import { Anmeldung, hashPasswort } from './anmeldung.js';
import { Benutzerverwaltung, passwortRegelFehler } from './benutzerverwaltung.js';
import { Sicherheitsmeldungen } from './sicherheit.js';
import { konfigWerteOeffnen, Tresor } from './geheimnis.js';
import { geheimnisseUmstellen } from './umstellung.js';
import { Domainverwaltung } from './domain.js';
import { kontoPruefen } from './konto.js';
import { Zertifikatsverwaltung } from './zertifikat.js';
import { erstelleAnwendung, starteServer } from './webserver.js';
import { NEUSTART_CODE, Updateverwaltung, versionLesen } from './updates.js';
import { bereinige, melde, Protokoll } from './protokoll.js';
import { beendeLaufendeModule } from './ausfuehrung.js';

const APP_ORDNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HILFE = `Monitoring-Basis

node basis/main.js [--config <Datei>]            Basis starten
node start.js                                    Basis über den Starter (empfohlen, nötig für Updates)
node basis/main.js --benutzer-anlegen <Name> [--admin]
                                                 Benutzer anlegen oder Passwort ändern
node basis/main.js --zwei-faktor-zuruecksetzen <Name>
                                                 Zwei-Faktor-Anmeldung zurücksetzen (Notfall, z. B. Handy
                                                 des letzten Admins verloren); danach Basis neu starten
node basis/main.js --zertifikat                  Let's-Encrypt-Zertifikat jetzt holen/erneuern
node basis/main.js --module-pruefen              Module auflisten und prüfen
node basis/main.js --selbsttest                  Konfiguration, Module und Programmdateien prüfen

Standard für --config: config.json im Programmordner.`;


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

async function configSchreiben(configDatei, roh) {
  await copyFile(configDatei, `${configDatei}.backup-${randomUUID()}.json`);
  const temp = `${configDatei}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(roh, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, configDatei);
}

// Notfall auf dem Server: Zwei-Faktor-Anmeldung eines Benutzers entfernen. Bei der nächsten Anmeldung (Firmennetz/VPN)
// richtet er sie neu ein. Bewusst ohne Prüfung der Konfiguration – auch eine beschädigte Angabe lässt sich so entfernen.
async function zweiFaktorZuruecksetzen(configDatei, name) {
  let roh;
  try { roh = JSON.parse((await readFile(configDatei, 'utf8')).replace(/^﻿/, '')); }
  catch (f) { throw new BasisFehler(f.code === 'ENOENT' ? `Konfiguration nicht gefunden: ${configDatei}.` : 'config.json ist kein gültiges JSON.'); }
  if (!roh?.benutzer || !Object.hasOwn(roh.benutzer, name)) throw new BasisFehler(`Den Benutzer „${name}“ gibt es nicht.`);
  if (!roh.benutzer[name].zwei_faktor) { console.log(`${name} hat keine Zwei-Faktor-Anmeldung eingerichtet.`); return; }
  delete roh.benutzer[name].zwei_faktor;
  await configSchreiben(configDatei, roh);
  console.log(`Zwei-Faktor-Anmeldung von ${name} zurückgesetzt. Bitte die Basis neu starten; bei der nächsten Anmeldung (im Firmennetz oder über VPN) wird sie neu eingerichtet.`);
}

async function benutzerAnlegen(configDatei, name, admin) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new BasisFehler('Benutzername: nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich (max. 64).');
  await ladeKonfiguration(configDatei);
  const roh = JSON.parse((await readFile(configDatei, 'utf8')).replace(/^﻿/, ''));
  const [passwort, wiederholung] = await verdeckteFragen([`Neues Passwort für ${name} (mind. 12 Zeichen): `, 'Passwort wiederholen: ']);
  if (passwort !== wiederholung) throw new BasisFehler('Die Passwörter stimmen nicht überein.');
  const regel = passwortRegelFehler(name, passwort);
  if (regel) throw new BasisFehler(regel);
  let hash;
  try { hash = await hashPasswort(passwort); } catch (f) { throw new BasisFehler(f.message); }
  // Ohne --admin bleibt ein bestehendes Admin-Recht erhalten (z. B. beim Passwortwechsel).
  const istAdmin = admin || roh.benutzer?.[name]?.admin === true;
  // Eine eingerichtete Zwei-Faktor-Anmeldung bleibt beim Passwortwechsel erhalten.
  const zf = roh.benutzer?.[name]?.zwei_faktor;
  roh.benutzer = { ...(roh.benutzer ?? {}), [name]: { hash, ...(istAdmin ? { admin: true } : {}), ...(zf ? { zwei_faktor: zf } : {}) } };
  await configSchreiben(configDatei, roh);
  console.log(`Benutzer ${name}${istAdmin ? ' (Admin)' : ''} gespeichert. Eine laufende Basis übernimmt die Änderung nach einem Neustart oder bei der nächsten Änderung in der Oberfläche (Benutzer).`);
}

async function starten(konfig, configDatei, protokoll, tresor) {
  const log = protokoll.alsFunktion();
  if (!Object.keys(konfig.benutzer).length) throw new BasisFehler('Es ist noch kein Benutzer angelegt. Zuerst: node basis/main.js --benutzer-anlegen <Name>');
  // Unter welchem Konto läuft die Basis, und darf es überall schreiben, wo es muss?
  const installOrdner = process.env.MONITOR_INSTALL_ORDNER || path.dirname(configDatei);
  const konto = await kontoPruefen({
    ordner: [installOrdner, konfig.datenOrdner, konfig.moduleOrdner, path.join(path.dirname(configDatei), 'logs'), path.join(installOrdner, 'versionen')],
    datei: configDatei, log,
  });

  const speicher = new Ergebnisspeicher(konfig.datenOrdner, konfig.verlaufAnzahl);
  const uebernehmen = async (id, roh) => {
    // Geheimnisse der Basis (Tokens, Hashes, Modul-Passwörter) nie in gespeicherten oder angezeigten Ergebnissen.
    const e = { ...roh, zusammenfassung: bereinige(roh.zusammenfassung, protokoll.geheimnisse), details: (roh.details ?? []).map((d) => bereinige(d, protokoll.geheimnisse)), ...(roh.fehlerausgabe ? { fehlerausgabe: bereinige(roh.fehlerausgabe, protokoll.geheimnisse) } : {}) };
    await speicher.hinzufuegen(id, e);
    // Auffällige Ergebnisse zusätzlich ins Fehlerprotokoll, mit Fehlerausgabe des Moduls als Details.
    if (e.status !== 'ok') melde(log, e.status === 'fehler' ? 'fehler' : 'warnung', `Modul ${id}`, e.zusammenfassung, [...(e.details ?? []), e.fehlerausgabe].filter(Boolean).join('\n'));
  };
  // Vor jedem Start prüft die Modulverwaltung, ob der Stand des Moduls freigegeben ist (sonst kein Start).
  const planer = new Planer({ ausfuehren: async (m) => (await module.vorStart(m)) ?? fuehreAus(m), speichern: uebernehmen, log });
  const benachrichtigung = new Benachrichtigung({ datenOrdner: konfig.datenOrdner, geheimnisse: protokoll.geheimnisse, tresor, log });
  await benachrichtigung.laden();
  const freigaben = new Freigaben({ datenOrdner: konfig.datenOrdner, log });
  await freigaben.laden();
  const module = new Modulverwaltung({
    moduleOrdner: konfig.moduleOrdner, datenOrdner: konfig.datenOrdner, speicher, planer, uebernehmen,
    nachTakt: (ansichten) => benachrichtigung.pruefen(ansichten),
    geheimnisse: protokoll.geheimnisse, tresor, freigaben, log,
  });
  await module.start();
  const adminNetz = adminNetzPruefer(konfig.adminNetze);
  const sicherheit = new Sicherheitsmeldungen({ datenOrdner: konfig.datenOrdner, benachrichtigung, log });
  await sicherheit.laden();
  const anmeldung = new Anmeldung({
    benutzer: konfig.benutzer, sitzungMs: konfig.sitzungMs, leerlaufMs: konfig.leerlaufMs,
    melden: (e) => sicherheit.ereignis(e),
    hashErneuern: (name, passwort) => benutzerverwaltung.hashErneuern(name, passwort),
    // Zwei-Faktor-Anmeldung ist für alle Pflicht; eingerichtet wird sie nur aus dem Firmennetz/VPN (admin_netze).
    zweiFaktor: true,
    einrichtenErlaubt: (adresse) => adminNetz(adresse),
    zweiFaktorSpeichern: (name, geheimnis, codes) => { protokoll.geheimnisse.push(geheimnis); return benutzerverwaltung.zweiFaktorSpeichern(name, geheimnis, codes); },
    codeVerbraucht: (name, hash) => benutzerverwaltung.codeVerbrauchen(name, hash),
  });
  const benutzerverwaltung = new Benutzerverwaltung({ configDatei, anmeldung, tresor, log });
  await benachrichtigung.abosBereinigen(Object.keys(anmeldung.benutzer));
  const zertifikate = new Zertifikatsverwaltung({ konfig, log });
  const tls = await zertifikate.laden();
  let server;
  const updates = new Updateverwaltung({
    installOrdner, programmOrdner: APP_ORDNER, configDatei,
    updates: konfig.updates, installiert: await versionLesen(APP_ORDNER), log,
    datenOrdner: konfig.datenOrdner, geheimnisse: protokoll.geheimnisse, tresor,
    viaStarter: typeof process.send === 'function' && process.env.MONITOR_STARTER === '1',
    neustart: () => neustarten(),
  });
  // Neustart der Basis samt aller Module: Zeitplan anhalten, laufende Prüfungen beenden, Starter startet neu.
  const neustarten = () => {
    log('Neustart der Basis und aller Module.');
    planer.stop();
    module.stop();
    beendeLaufendeModule();
    server?.close();
    setTimeout(() => process.exit(NEUSTART_CODE), 300);
  };
  await updates.starten();
  const gestartet = Date.now();
  benachrichtigung.basisInfo = () => {
    const st = updates.status();
    return { version: updates.installiert, seit: gestartet, update: st.updateMoeglich ? st.verfuegbar?.version : null };
  };
  const domain = new Domainverwaltung({ configDatei, konfig, tresor, benutzerverwaltung, zertifikate, neustart: updates.viaStarter ? neustarten : null, log });
  const modulupdates = new Modulupdates({ verwaltung: module, updates, datenOrdner: konfig.datenOrdner, log });
  const intern = konfig.tls.modus === 'aus';
  const anwendung = erstelleAnwendung({ module, modulupdates, benachrichtigung, benutzerverwaltung, domain, anmeldung, updates, protokoll, neustart: updates.viaStarter ? neustarten : null, beenden: (wunsch) => beenden(wunsch), sitzungMs: konfig.sitzungMs, verschluesselt: !intern, nurIntern: intern, adminNetz, hostname: konfig.hostname, weitereHosts: konfig.weitereHostnamen, konto, log });
  try { server = await starteServer({ anwendung, tls, host: konfig.host, port: konfig.port }); }
  catch (fehler) {
    throw new BasisFehler(fehler.code === 'EADDRINUSE' ? `Port ${konfig.port} ist bereits belegt.` : fehler.code === 'EACCES' ? `Keine Berechtigung für Port ${konfig.port}.` : `Server konnte nicht starten (${fehler.code || fehler.message}).`);
  }
  domain.server = server;
  zertifikate.automatischErneuern(server);
  planer.start();
  updates.taeglichPruefen();
  modulupdates.taeglichPruefen();
  process.send?.({ typ: 'bereit', version: updates.installiert });
  // Erst nach erfolgreichem Start verschlüsseln: Scheitert die neue Version vorher, kann die alte die Dateien noch lesen.
  geheimnisseUmstellen({ tresor, configDatei, konfig, benutzerverwaltung, updates, benachrichtigung, module, log })
    .catch((fehler) => melde(log, 'fehler', 'Sicherheit', `Umstellung auf verschlüsselte Geheimnisse: ${fehler.message}`));
  if (intern) {
    log(`Monitoring-Basis ${updates.installiert} läuft: http://<IP-Adresse dieses Rechners>:${konfig.port}/`);
    melde(log, 'warnung', 'Basis', 'Unverschlüsselt (HTTP, tls.modus "aus") – nur im internen Netz verwenden. Zugriffe von außerhalb privater Netze werden abgewiesen.');
  } else {
    log(`Monitoring-Basis ${updates.installiert} läuft: https://${konfig.hostname}:${konfig.port}/`);
  }

  // Beendet die Basis mit Code 0 – der Starter startet sie dann nicht neu, der Aufgabenplaner auch nicht.
  // Über die Oberfläche (benutzer gesetzt) auf Wunsch samt eigenständiger Module und mit Mail.
  let wirdBeendet = false;
  async function beenden({ benutzer = null, mitModulen = false } = {}) {
    if (wirdBeendet) return;
    wirdBeendet = true;
    log(benutzer ? `Monitoring-Basis wird beendet durch ${benutzer}${mitModulen ? ' (mit allen Modulen)' : ''}.` : 'Monitoring-Basis wird beendet.');
    planer.stop();
    module.stop();
    beendeLaufendeModule();
    if (benutzer) {
      const fehler = mitModulen ? await module.alleBeenden(benutzer).catch((f) => [f.message]) : [];
      for (const f of fehler) melde(log, 'fehler', 'Basis', `Beim Beenden nicht beendet: ${f}`);
      await Promise.race([benachrichtigung.basisBeendet(benutzer, mitModulen, fehler).catch(() => {}), new Promise((r) => setTimeout(r, 25_000))]);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.once('SIGINT', () => beenden());
  process.once('SIGTERM', () => beenden());
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args, options: {
      config: { type: 'string' }, 'benutzer-anlegen': { type: 'string' }, 'zwei-faktor-zuruecksetzen': { type: 'string' },
      zertifikat: { type: 'boolean' }, 'module-pruefen': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      admin: { type: 'boolean' }, selbsttest: { type: 'boolean' },
    } });
    if (values.help) { console.log(HILFE); return 0; }
    const configDatei = path.resolve(values.config ?? path.join(APP_ORDNER, 'config.json'));
    if (values['zwei-faktor-zuruecksetzen'] !== undefined) { await zweiFaktorZuruecksetzen(configDatei, values['zwei-faktor-zuruecksetzen']); return 0; }
    if (values['benutzer-anlegen'] !== undefined) { await benutzerAnlegen(configDatei, values['benutzer-anlegen'], values.admin === true); return 0; }

    const konfig = await ladeKonfiguration(configDatei);
    if (values.selbsttest) {
      // Wird vor dem Umschalten auf eine neue Version ausgeführt: Lädt sie Konfiguration, Module und Oberfläche?
      await ladeModule(konfig.moduleOrdner);
      await readFile(path.join(APP_ORDNER, 'oberflaeche', 'index.html'));
      console.log(`Selbsttest bestanden (Version ${await versionLesen(APP_ORDNER)}).`);
      return 0;
    }
    const protokoll = new Protokoll({
      ordner: path.join(path.dirname(configDatei), 'logs'),
      geheimnisse: [konfig.tls.cloudflareToken, konfig.tls.hetznerToken, konfig.updates?.githubToken, ...Object.values(konfig.benutzer).flatMap((b) => [b.hash, b.zwei_faktor?.geheimnis])],
    });
    const log = protokoll.alsFunktion();
    // Unerwartete Fehler festhalten. Bei einer nicht abgefangenen Ausnahme beendet sich die Basis;
    // der Starter startet sie nach kurzer Pause neu.
    process.on('unhandledRejection', (grund) => protokoll.fehler('Basis', `Unbehandelter Fehler: ${grund?.message ?? grund}`, grund));
    process.on('uncaughtException', (fehler) => {
      protokoll.fehler('Basis', `Absturz: ${fehler?.message ?? fehler}`, fehler);
      process.exit(1);
    });

    if (values['module-pruefen']) {
      const module = await ladeModule(konfig.moduleOrdner);
      if (!module.length) console.log(`Keine Module in ${konfig.moduleOrdner}.`);
      for (const m of module) console.log(m.fehler ? `FEHLER ${m.name}: ${m.fehler}` : `OK     ${m.id}: ${m.name} (${m.typ}, ${m.typ === 'eigenstaendig' ? `meldet sich selbst${m.intervallMinuten ? `, erwartet alle ${m.intervallMinuten} min` : ''}` : m.intervallMinuten ? `alle ${m.intervallMinuten} min` : 'nur manuell'}${m.aktiv ? '' : ', inaktiv'})`);
      return module.some((m) => m.fehler) ? 2 : 0;
    }
    if (values.zertifikat) {
      if (konfig.tls.modus !== 'letsencrypt') throw new BasisFehler('--zertifikat ist nur bei tls.modus "letsencrypt" nötig.');
      try { await new Zertifikatsverwaltung({ konfig: await konfigWerteOeffnen(konfig, new Tresor({ datenOrdner: konfig.datenOrdner })), log }).erneuern(); }
      catch (fehler) { protokoll.fehler('Zertifikat', fehler.message, fehler instanceof BasisFehler ? undefined : fehler); throw fehler; }
      return 0;
    }
    const tresor = new Tresor({ datenOrdner: konfig.datenOrdner });
    let offen;
    try { offen = await konfigWerteOeffnen(konfig, tresor); }
    catch (fehler) { protokoll.fehler('Basis', fehler.message); throw fehler; }
    for (const g of [offen.tls.cloudflareToken, offen.tls.hetznerToken, offen.updates?.githubToken, ...Object.values(offen.benutzer).map((b) => b.zwei_faktor?.geheimnis)]) if (g && !protokoll.geheimnisse.includes(g)) protokoll.geheimnisse.push(g);
    try { await starten(offen, configDatei, protokoll, tresor); }
    catch (fehler) { protokoll.fehler('Basis', `Start fehlgeschlagen: ${fehler.message}`, fehler instanceof BasisFehler ? undefined : fehler); throw fehler; }
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
