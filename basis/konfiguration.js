import { readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { BasisFehler } from './fehler.js';
import { rechteFehler } from './rechte.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const istText = (wert) => typeof wert === 'string' && wert.trim() !== '' && !/[\r\n\0]/.test(wert);

// Netze, aus denen Admin-Funktionen erlaubt sind (Firmennetz und VPN). Standard: alle privaten und lokalen Adressen.
// ["*"] erlaubt Admin-Funktionen von überall.
export const STANDARD_ADMIN_NETZE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'];
export function adminNetzePruefen(wert = STANDARD_ADMIN_NETZE) {
  if (!Array.isArray(wert) || !wert.length || wert.some((n) => typeof n !== 'string')) throw new BasisFehler('admin_netze muss eine Liste wie ["192.168.0.0/16", "10.8.0.0/24"] sein.');
  if (wert.length === 1 && wert[0] === '*') return ['*'];
  for (const netz of wert) {
    const [adresse, laenge, rest] = netz.trim().split('/');
    const art = isIP(adresse ?? '');
    const bits = Number(laenge);
    if (!art || rest !== undefined || !/^\d+$/.test(laenge ?? '') || bits > (art === 4 ? 32 : 128)) throw new BasisFehler(`admin_netze: „${netz}“ ist kein gültiges Netz (Form „192.168.10.0/24“).`);
  }
  return wert.map((n) => n.trim());
}

// Prüffunktion: Ist die Adresse in einem der Admin-Netze? (IPv4 auch als ::ffff:a.b.c.d)
export function adminNetzPruefer(netze) {
  if (netze.length === 1 && netze[0] === '*') return () => true;
  const liste = new BlockList();
  for (const n of netze) { const [a, l] = n.split('/'); liste.addSubnet(a, Number(l), isIP(a) === 4 ? 'ipv4' : 'ipv6'); }
  return (adresse) => {
    const a = String(adresse ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    const art = isIP(a);
    return Boolean(art) && liste.check(a, art === 4 ? 'ipv4' : 'ipv6');
  };
}

const HOSTNAME = /^(?=.{1,254}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;

export function pruefeKonfiguration(roh, basisOrdner) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new BasisFehler('config.json muss ein JSON-Objekt sein.');
  const port = roh.port ?? 8443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BasisFehler('Ungültiger Port in config.json.');
  const verlauf = roh.verlauf_anzahl ?? 1000;
  if (!Number.isInteger(verlauf) || verlauf < 1 || verlauf > 10000) throw new BasisFehler('verlauf_anzahl muss zwischen 1 und 10000 liegen.');
  const stunden = roh.sitzung_stunden ?? 8;
  if (typeof stunden !== 'number' || !(stunden > 0) || stunden > 720) throw new BasisFehler('sitzung_stunden muss zwischen 0 und 720 liegen.');
  const leerlauf = roh.sitzung_leerlauf_minuten ?? 30;
  if (typeof leerlauf !== 'number' || !(leerlauf >= 5) || leerlauf > 1440) throw new BasisFehler('sitzung_leerlauf_minuten muss zwischen 5 und 1440 liegen.');
  const adminNetze = adminNetzePruefen(roh.admin_netze);

  const tls = roh.tls;
  if (!tls || !['letsencrypt', 'dateien', 'aus'].includes(tls.modus)) throw new BasisFehler('tls.modus muss "letsencrypt", "dateien" oder "aus" sein.');
  // Ohne Verschlüsselung (nur internes Netz) wird kein Hostname gebraucht; Zugriff dann per IP und Port.
  if (tls.modus !== 'aus' && !istText(roh.hostname)) throw new BasisFehler('hostname fehlt in config.json (z. B. monitoring.firma.de).');
  if (roh.hostname !== undefined && !istText(roh.hostname)) throw new BasisFehler('hostname muss ein Text sein.');
  // Weitere Namen, unter denen die Oberfläche erreichbar sein soll (z. B. der vollständige Rechnername im Firmen-DNS).
  // Anfragen an andere Namen weist der Webserver ab (Schutz vor DNS-Rebinding).
  const weitere = roh.weitere_hostnamen ?? [];
  if (!Array.isArray(weitere) || weitere.length > 20 || weitere.some((h) => typeof h !== 'string' || !(HOSTNAME.test(h) || /^[0-9a-f:.]{2,45}$/i.test(h)))) {
    throw new BasisFehler('weitere_hostnamen muss eine Liste von höchstens 20 Namen oder IP-Adressen sein, z. B. ["we-vmworker-22.firma.local"].');
  }
  const ordner = (wert) => path.resolve(basisOrdner, wert);
  let tlsGeprueft;
  if (tls.modus === 'aus') {
    tlsGeprueft = { modus: 'aus' };
  } else if (tls.modus === 'dateien') {
    if (!istText(tls.zertifikat) || !istText(tls.schluessel)) throw new BasisFehler('Für tls.modus "dateien" werden tls.zertifikat und tls.schluessel benötigt.');
    tlsGeprueft = { modus: 'dateien', zertifikat: ordner(tls.zertifikat), schluessel: ordner(tls.schluessel) };
  } else {
    if (!istText(tls.email) || !/^[^\s@]+@[^\s@]+$/.test(tls.email)) throw new BasisFehler('tls.email muss eine E-Mail-Adresse für Let\'s Encrypt sein.');
    // DNS-Anbieter für die DNS-Prüfung: Cloudflare (Standard) oder Hetzner (DNS in der Hetzner Console).
    const anbieter = tls.dns_anbieter ?? 'cloudflare';
    if (!['cloudflare', 'hetzner'].includes(anbieter)) throw new BasisFehler('tls.dns_anbieter muss "cloudflare" oder "hetzner" sein.');
    if (anbieter === 'cloudflare' && !istText(tls.cloudflare_token)) throw new BasisFehler('tls.cloudflare_token fehlt (Cloudflare-API-Token mit Recht „Zone: DNS: Bearbeiten“).');
    if (anbieter === 'hetzner' && !istText(tls.hetzner_token)) throw new BasisFehler('tls.hetzner_token fehlt (API-Token aus der Hetzner Console, Projekt mit der Zone, Rechte „Lesen & Schreiben“).');
    if (tls.staging !== undefined && typeof tls.staging !== 'boolean') throw new BasisFehler('tls.staging muss true oder false sein.');
    tlsGeprueft = { modus: 'letsencrypt', dnsAnbieter: anbieter, email: tls.email, staging: tls.staging === true,
      ...(anbieter === 'hetzner' ? { hetznerToken: tls.hetzner_token } : { cloudflareToken: tls.cloudflare_token }) };
  }

  const benutzer = roh.benutzer ?? {};
  if (typeof benutzer !== 'object' || Array.isArray(benutzer)) throw new BasisFehler('benutzer muss ein Objekt sein.');
  for (const [name, eintrag] of Object.entries(benutzer)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !istText(eintrag?.hash)) throw new BasisFehler(`Ungültiger Benutzereintrag: ${name}.`);
    if (eintrag.admin !== undefined && typeof eintrag.admin !== 'boolean') throw new BasisFehler(`benutzer.${name}.admin muss true oder false sein.`);
    const rf = rechteFehler(eintrag.rechte);
    if (rf) throw new BasisFehler(`benutzer.${name}.rechte: ${rf}.`);
    const ms = eintrag.microsoft;
    if (ms !== undefined && (!ms || typeof ms !== 'object' || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(ms.adresse ?? '')
      || (ms.oid !== undefined && !GUID.test(ms.oid)) || (ms.tid !== undefined && !GUID.test(ms.tid)))) {
      throw new BasisFehler(`benutzer.${name}.microsoft ist ungültig (adresse, oid, tid).`);
    }
    const zf = eintrag.zwei_faktor;
    if (zf !== undefined && (!zf || typeof zf !== 'object' || !/^(?:[A-Z2-7]{16,128}|dpapi:v1:[A-Za-z0-9+/]+={0,2})$/.test(zf.geheimnis ?? '') || !Array.isArray(zf.codes) || zf.codes.some((c) => !/^[0-9a-f]{64}$/.test(c)))) {
      throw new BasisFehler(`benutzer.${name}.zwei_faktor ist beschädigt. Zurücksetzen mit: node basis/main.js --zwei-faktor-zuruecksetzen ${name}`);
    }
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
    weitereHostnamen: weitere.map((h) => h.toLowerCase().replace(/\.$/, '')),
    moduleOrdner: ordner(roh.module_ordner ?? 'modules'),
    datenOrdner: ordner(roh.daten_ordner ?? 'data'),
    verlaufAnzahl: verlauf,
    sitzungMs: stunden * 3_600_000,
    leerlaufMs: leerlauf * 60_000,
    adminNetze,
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
