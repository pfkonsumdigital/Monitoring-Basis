import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BasisFehler } from './fehler.js';

const istText = (wert) => typeof wert === 'string' && wert.trim() !== '' && !/[\r\n\0]/.test(wert);

export function pruefeKonfiguration(roh, basisOrdner) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new BasisFehler('config.json muss ein JSON-Objekt sein.');
  const port = roh.port ?? 8443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BasisFehler('Ungültiger Port in config.json.');
  const verlauf = roh.verlauf_anzahl ?? 1000;
  if (!Number.isInteger(verlauf) || verlauf < 1 || verlauf > 10000) throw new BasisFehler('verlauf_anzahl muss zwischen 1 und 10000 liegen.');
  const stunden = roh.sitzung_stunden ?? 12;
  if (typeof stunden !== 'number' || !(stunden > 0) || stunden > 720) throw new BasisFehler('sitzung_stunden muss zwischen 0 und 720 liegen.');

  const tls = roh.tls;
  if (!tls || !['letsencrypt', 'dateien', 'aus'].includes(tls.modus)) throw new BasisFehler('tls.modus muss "letsencrypt", "dateien" oder "aus" sein.');
  // Ohne Verschlüsselung (nur internes Netz) wird kein Hostname gebraucht; Zugriff dann per IP und Port.
  if (tls.modus !== 'aus' && !istText(roh.hostname)) throw new BasisFehler('hostname fehlt in config.json (z. B. monitoring.firma.de).');
  if (roh.hostname !== undefined && !istText(roh.hostname)) throw new BasisFehler('hostname muss ein Text sein.');
  const ordner = (wert) => path.resolve(basisOrdner, wert);
  let tlsGeprueft;
  if (tls.modus === 'aus') {
    tlsGeprueft = { modus: 'aus' };
  } else if (tls.modus === 'dateien') {
    if (!istText(tls.zertifikat) || !istText(tls.schluessel)) throw new BasisFehler('Für tls.modus "dateien" werden tls.zertifikat und tls.schluessel benötigt.');
    tlsGeprueft = { modus: 'dateien', zertifikat: ordner(tls.zertifikat), schluessel: ordner(tls.schluessel) };
  } else {
    if (!istText(tls.email) || !/^[^\s@]+@[^\s@]+$/.test(tls.email)) throw new BasisFehler('tls.email muss eine E-Mail-Adresse für Let\'s Encrypt sein.');
    if (!istText(tls.cloudflare_token)) throw new BasisFehler('tls.cloudflare_token fehlt (Cloudflare-API-Token mit Recht „Zone: DNS: Bearbeiten“).');
    if (tls.staging !== undefined && typeof tls.staging !== 'boolean') throw new BasisFehler('tls.staging muss true oder false sein.');
    tlsGeprueft = { modus: 'letsencrypt', email: tls.email, cloudflareToken: tls.cloudflare_token, staging: tls.staging === true };
  }

  const benutzer = roh.benutzer ?? {};
  if (typeof benutzer !== 'object' || Array.isArray(benutzer)) throw new BasisFehler('benutzer muss ein Objekt sein.');
  for (const [name, eintrag] of Object.entries(benutzer)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !istText(eintrag?.hash)) throw new BasisFehler(`Ungültiger Benutzereintrag: ${name}.`);
    if (eintrag.admin !== undefined && typeof eintrag.admin !== 'boolean') throw new BasisFehler(`benutzer.${name}.admin muss true oder false sein.`);
  }

  // Optional: Updates aus einem privaten GitHub-Repo. Ohne Angabe ist die Update-Funktion aus.
  let updates = null;
  if (roh.updates !== undefined) {
    const u = roh.updates;
    if (!u || typeof u !== 'object') throw new BasisFehler('updates muss ein Objekt sein.');
    const repo = u.repo ?? 'pfkonsumdigital/Monitoring-Basis';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new BasisFehler('updates.repo muss die Form "besitzer/repo" haben.');
    if (!istText(u.github_token)) throw new BasisFehler('updates.github_token fehlt (Fine-grained Token, nur Lesezugriff „Contents“ auf das Repo).');
    updates = { repo, githubToken: u.github_token };
  }

  return {
    host: istText(roh.host) ? roh.host : '0.0.0.0',
    port,
    hostname: roh.hostname ?? null,
    moduleOrdner: ordner(roh.module_ordner ?? 'modules'),
    datenOrdner: ordner(roh.daten_ordner ?? 'data'),
    verlaufAnzahl: verlauf,
    sitzungMs: stunden * 3_600_000,
    tls: tlsGeprueft,
    benutzer,
    updates,
  };
}

export async function ladeKonfiguration(datei) {
  let text;
  try { text = await readFile(datei, 'utf8'); }
  catch (fehler) {
    if (fehler.code === 'ENOENT') throw new BasisFehler(`Konfiguration nicht gefunden: ${datei}. config.example.json kopieren und anpassen.`);
    throw fehler;
  }
  let roh;
  try { roh = JSON.parse(text.replace(/^﻿/, '')); }
  catch { throw new BasisFehler('config.json ist kein gültiges JSON.'); }
  return pruefeKonfiguration(roh, path.dirname(path.resolve(datei)));
}
