import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BasisFehler } from './fehler.js';
import { istVerschluesselt } from './geheimnis.js';
import { melde } from './protokoll.js';
import { CloudflareDns, HetznerDns, warteAufTxt, Zertifikatsverwaltung } from './zertifikat.js';

// HTTPS & Domain in der Oberfläche (nur Admins aus dem Firmennetz/VPN):
// Domain, E-Mail, DNS-Anbieter und Token speichern (Token verschlüsselt), Zugang prüfen, Test- und echtes Zertifikat
// bei Let's Encrypt anfragen, auf HTTPS umschalten (Port 8443, mit Neustart) und notfalls zurück auf HTTP.

export const HTTPS_PORT = 8443;
export const HTTP_PORT = 8080;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[\x21-\x7e]{10,500}$/;
const ANBIETER = { hetzner: 'Hetzner', cloudflare: 'Cloudflare' };
const tokenFeld = (anbieter) => (anbieter === 'hetzner' ? 'hetzner_token' : 'cloudflare_token');

// Angaben zu einem Zertifikat für die Anzeige (oder null).
export function zertifikatInfo(pem, jetzt = Date.now()) {
  if (!pem) return null;
  try {
    const z = new X509Certificate(pem);
    const namen = (z.subjectAltName ?? '').split(',').map((t) => t.trim().replace(/^DNS:/, '')).filter(Boolean);
    const aussteller = /(?:^|\n)O=([^\n]+)/.exec(z.issuer)?.[1] ?? /(?:^|\n)CN=([^\n]+)/.exec(z.issuer)?.[1] ?? z.issuer;
    const bis = Date.parse(z.validTo);
    return {
      domain: namen[0] ?? /CN=([^\n]+)/.exec(z.subject)?.[1] ?? '', aussteller,
      gueltigAb: new Date(Date.parse(z.validFrom)).toISOString(), gueltigBis: new Date(bis).toISOString(),
      gueltig: bis > jetzt && Date.parse(z.validFrom) <= jetzt, test: /STAGING|Fake LE|\(STAGING\)/i.test(z.issuer),
    };
  } catch { return null; }
}

// Ist der Port auf diesem Rechner frei? (kurz öffnen und wieder schließen)
export function portFrei(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (f) => resolve(f.code === 'EADDRINUSE' ? 'belegt' : f.code === 'EACCES' ? 'keine Berechtigung' : f.code ?? f.message));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

const eigeneAdressen = () => Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address.replace(/^::ffff:/, ''));

export class Domainverwaltung {
  constructor({ configDatei, konfig, tresor = null, benutzerverwaltung, zertifikate = null, neustart = null, log = () => {},
    dnsFabrik = (anbieter, token) => (anbieter === 'hetzner' ? new HetznerDns(token) : new CloudflareDns(token)),
    warten = warteAufTxt, acmeImpl, aufloesen = (name) => lookup(name, { all: true }), adressen = eigeneAdressen,
    portPruefen = portFrei, jetzt = () => Date.now() }) {
    Object.assign(this, { configDatei, konfig, tresor, benutzerverwaltung, zertifikate, neustart, log, dnsFabrik, warten, acmeImpl, aufloesen, adressen, portPruefen, jetzt });
    this.vorgang = null;
    this.pruefung = null;
    this.server = null;
  }

  async roh() { return JSON.parse((await readFile(this.configDatei, 'utf8')).replace(/^﻿/, '')); }

  // Gespeicherte Einstellungen (Token bleibt verschlüsselt).
  async einstellungen() {
    const roh = await this.roh();
    const tls = roh.tls ?? {};
    const dnsAnbieter = tls.dns_anbieter ?? 'hetzner';
    return { hostname: roh.hostname ?? '', email: tls.email ?? '', dnsAnbieter, token: tls[tokenFeld(dnsAnbieter)] ?? '', roh };
  }

  async zertifikat(ordner) {
    const pem = await readFile(path.join(this.konfig.datenOrdner, ordner, 'zertifikat.pem'), 'utf8').catch(() => null);
    return zertifikatInfo(pem, this.jetzt());
  }

  // Für die Oberfläche: nie den Token, nur ob einer gesetzt ist.
  async status() {
    const e = await this.einstellungen();
    const zertifikat = await this.zertifikat('zertifikat');
    const testzertifikat = await this.zertifikat('zertifikat-test');
    const modus = this.konfig.tls.modus;
    let grund = null;
    if (!e.hostname || !e.email || !e.token) grund = 'Zuerst Domain, E-Mail und Token speichern.';
    else if (!zertifikat || zertifikat.test) grund = 'Zuerst das echte Zertifikat anfragen.';
    else if (!zertifikat.gueltig) grund = 'Das Zertifikat ist abgelaufen – bitte neu anfragen.';
    else if (zertifikat.domain.toLowerCase() !== e.hostname.toLowerCase()) grund = `Das Zertifikat gilt für ${zertifikat.domain}, nicht für ${e.hostname} – bitte neu anfragen.`;
    else if (modus === 'letsencrypt' && this.konfig.port === HTTPS_PORT && this.konfig.hostname === e.hostname) grund = 'HTTPS ist bereits aktiv.';
    return {
      modus, port: this.konfig.port, httpsPort: HTTPS_PORT, httpPort: HTTP_PORT,
      hostname: e.hostname, email: e.email, dnsAnbieter: e.dnsAnbieter, tokenGesetzt: Boolean(e.token),
      zertifikat, testzertifikat, vorgang: this.vorgang, pruefung: this.pruefung,
      umschaltenMoeglich: !grund, umschaltenGrund: grund, neustartMoeglich: Boolean(this.neustart),
      adresse: e.hostname ? `https://${e.hostname}${HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`}/` : null,
    };
  }

  // Speichert Domain, E-Mail, DNS-Anbieter und (falls angegeben) den Token. Liefert { status } oder { feldfehler }.
  async speichern(eingabe, benutzer) {
    const hostname = String(eingabe?.hostname ?? '').trim().toLowerCase();
    const email = String(eingabe?.email ?? '').trim();
    const dnsAnbieter = eingabe?.dns_anbieter;
    const token = String(eingabe?.token ?? '').trim();
    const bisher = await this.einstellungen();
    const feldfehler = {};
    if (!DOMAIN.test(hostname)) feldfehler.hostname = 'Bitte einen vollständigen Namen wie monitoring.firma.de eintragen.';
    if (!EMAIL.test(email) || email.length > 200) feldfehler.email = 'Bitte eine E-Mail-Adresse eintragen (Let\'s Encrypt meldet sich dort vor Ablauf).';
    if (!ANBIETER[dnsAnbieter]) feldfehler.dns_anbieter = 'Hetzner oder Cloudflare wählen.';
    if (token && !TOKEN.test(token)) feldfehler.token = 'Das sieht nicht wie ein API-Token aus.';
    const tokenVorhanden = typeof bisher.roh.tls?.[tokenFeld(dnsAnbieter)] === 'string' && bisher.roh.tls[tokenFeld(dnsAnbieter)] !== '';
    if (!token && !tokenVorhanden && ANBIETER[dnsAnbieter]) feldfehler.token = `Bitte den API-Token von ${ANBIETER[dnsAnbieter]} eintragen.`;
    if (Object.keys(feldfehler).length) return { feldfehler };

    const gespeichert = token && this.tresor?.verfuegbar ? (await this.tresor.schuetzen([token], 'basis'))[0] : token;
    const geaendert = await this.benutzerverwaltung.konfigAendern((roh) => {
      const vorher = JSON.stringify({ h: roh.hostname, t: roh.tls });
      roh.hostname = hostname;
      roh.tls = { ...(roh.tls ?? { modus: 'aus' }), email, dns_anbieter: dnsAnbieter };
      if (gespeichert) roh.tls[tokenFeld(dnsAnbieter)] = gespeichert;
      return JSON.stringify({ h: roh.hostname, t: roh.tls }) !== vorher;
    });
    if (geaendert) {
      this.log(`HTTPS-Einstellungen geändert durch ${benutzer}: Domain ${hostname}, DNS-Anbieter ${ANBIETER[dnsAnbieter]}${token ? ', neuer Token' : ''}.`);
      this.pruefung = null;
      // Läuft schon HTTPS, nutzt die automatische Erneuerung die neuen Angaben sofort.
      if (this.zertifikate && this.konfig.tls.modus === 'letsencrypt') {
        const t = await this.tokenOeffnen();
        this.zertifikate.einstellungenUebernehmen({ hostname, tls: { email, dnsAnbieter, ...(dnsAnbieter === 'hetzner' ? { hetznerToken: t } : { cloudflareToken: t }) } });
      }
    }
    return { status: await this.status(), geaendert };
  }

  async tokenOeffnen() {
    const { token } = await this.einstellungen();
    if (!token) throw new BasisFehler('Es ist noch kein API-Token gespeichert.');
    if (istVerschluesselt(token) && !this.tresor) throw new BasisFehler('Der Token ist verschlüsselt und kann hier nicht geöffnet werden.');
    return this.tresor ? this.tresor.einzeln(token) : token;
  }

  // Zugang zum DNS-Anbieter und Namensauflösung prüfen. Fehler stehen im Ergebnis, nicht als Ausnahme.
  async pruefen() {
    const e = await this.einstellungen();
    if (!e.hostname || !e.token) throw new BasisFehler('Zuerst Domain, E-Mail und Token speichern.');
    const ergebnis = { zeit: new Date(this.jetzt()).toISOString(), hostname: e.hostname, anbieter: ANBIETER[e.dnsAnbieter] };
    try {
      const { zone } = await this.dnsFabrik(e.dnsAnbieter, await this.tokenOeffnen()).zoneFinden(e.hostname);
      ergebnis.zone = { ok: true, text: `Zone ${zone} bei ${ergebnis.anbieter} gefunden – der Token funktioniert.` };
    } catch (fehler) {
      ergebnis.zone = { ok: false, text: fehler.message };
    }
    try {
      const gefunden = [...new Set((await this.aufloesen(e.hostname)).map((a) => a.address))];
      const eigene = new Set(this.adressen());
      const hier = gefunden.filter((a) => eigene.has(a));
      ergebnis.aufloesung = hier.length
        ? { ok: true, adressen: gefunden, text: `${e.hostname} zeigt auf ${gefunden.join(', ')} – das ist dieser Rechner.` }
        : { ok: false, adressen: gefunden, text: `${e.hostname} zeigt auf ${gefunden.join(', ')} – das ist nicht dieser Rechner (${[...eigene].filter((a) => !a.includes(':') && a !== '127.0.0.1').join(', ') || 'unbekannt'}). Für den Zugriff im Firmennetz einen DNS-Eintrag (A-Record) auf die interne Adresse des Workers anlegen. Für das Zertifikat ist das nicht nötig.` };
    } catch {
      ergebnis.aufloesung = { ok: false, adressen: [], text: `${e.hostname} lässt sich von hier aus nicht auflösen. Für den Zugriff einen DNS-Eintrag (A-Record) auf die Adresse des Workers anlegen – intern im Firmen-DNS bzw. der Securepoint. Für das Zertifikat ist das nicht nötig.` };
    }
    this.pruefung = ergebnis;
    return ergebnis;
  }

  // Startet die Anfrage im Hintergrund (Fortschritt über status().vorgang). test=true: Testumgebung von Let's Encrypt.
  async anfragen(test, benutzer) {
    if (this.vorgang?.laeuft) throw new BasisFehler('Es läuft bereits eine Anfrage.');
    const e = await this.einstellungen();
    if (!e.hostname || !e.email || !e.token) throw new BasisFehler('Zuerst Domain, E-Mail und Token speichern.');
    const token = await this.tokenOeffnen();
    const v = { art: test ? 'test' : 'echt', laeuft: true, beginn: new Date(this.jetzt()).toISOString(), schritt: 'Anfrage bei Let\'s Encrypt wird vorbereitet …', ok: null, fehler: null, ende: null };
    this.vorgang = v;
    this.log(`${test ? 'Testzertifikat' : 'Zertifikat'} für ${e.hostname} angefragt durch ${benutzer}.`);
    const dns = this.dnsFabrik(e.dnsAnbieter, token);
    // Fortschritt aus den Schritten der DNS-Prüfung ableiten.
    const dnsMitSchritten = {
      txtAnlegen: async (name, inhalt) => { v.schritt = `TXT-Eintrag bei ${ANBIETER[e.dnsAnbieter]} wird angelegt …`; return dns.txtAnlegen(name, inhalt); },
      txtLoeschen: (eintrag) => dns.txtLoeschen(eintrag),
    };
    const warten = async (...args) => { v.schritt = 'Warte, bis der TXT-Eintrag im öffentlichen DNS sichtbar ist (bis etwa 2 Minuten) …'; await this.warten(...args); v.schritt = 'Let\'s Encrypt prüft die Domain und stellt das Zertifikat aus …'; };
    const verwaltung = new Zertifikatsverwaltung({
      konfig: { hostname: e.hostname, datenOrdner: this.konfig.datenOrdner, tls: { modus: 'letsencrypt', email: e.email, dnsAnbieter: e.dnsAnbieter, staging: test } },
      ordnerName: test ? 'zertifikat-test' : 'zertifikat', dns: dnsMitSchritten, warten, log: this.log, ...(this.acmeImpl ? { acmeImpl: this.acmeImpl } : {}),
    });
    this.laufend = verwaltung.erneuern().then((ergebnis) => {
      Object.assign(v, { laeuft: false, ok: true, schritt: null, ende: new Date(this.jetzt()).toISOString() });
      // Läuft schon HTTPS mit dieser Domain: neues Zertifikat sofort verwenden, ohne Neustart.
      if (!test && this.server && this.konfig.tls.modus === 'letsencrypt' && this.konfig.hostname === e.hostname) {
        this.server.setSecureContext(ergebnis);
        this.log('Neues Zertifikat ist aktiv.');
      }
    }, (fehler) => {
      Object.assign(v, { laeuft: false, ok: false, schritt: null, fehler: fehler.message, ende: new Date(this.jetzt()).toISOString() });
      melde(this.log, 'fehler', 'Zertifikat', `${test ? 'Testzertifikat' : 'Zertifikat'} für ${e.hostname} nicht erhalten: ${fehler.message}`);
    });
    return this.status();
  }

  // Auf HTTPS (Port 8443) umschalten und neu starten – nur mit gültigem echtem Zertifikat für die Domain.
  async umschalten(benutzer) {
    const st = await this.status();
    if (!st.umschaltenMoeglich) throw new BasisFehler(st.umschaltenGrund);
    if (this.konfig.port !== HTTPS_PORT) {
      const frei = await this.portPruefen(HTTPS_PORT, this.konfig.host);
      if (frei !== true) throw new BasisFehler(`Port ${HTTPS_PORT} ist auf diesem Rechner nicht verfügbar (${frei}). Bitte das Programm beenden, das ihn belegt.`);
    }
    await this.benutzerverwaltung.konfigAendern((roh) => {
      roh.tls = { ...roh.tls, modus: 'letsencrypt' };
      delete roh.tls.staging;
      roh.port = HTTPS_PORT;
    });
    this.log(`Umschalten auf HTTPS (${st.adresse}) durch ${benutzer}.`);
    return this.neuStarten(st.adresse);
  }

  // Notausgang: zurück auf HTTP im internen Netz (Port 8080). Domain, Token und Zertifikat bleiben gespeichert.
  async aufHttp(benutzer) {
    if (this.konfig.tls.modus === 'aus') throw new BasisFehler('Die Basis läuft bereits per HTTP.');
    if (this.konfig.port !== HTTP_PORT) {
      const frei = await this.portPruefen(HTTP_PORT, this.konfig.host);
      if (frei !== true) throw new BasisFehler(`Port ${HTTP_PORT} ist auf diesem Rechner nicht verfügbar (${frei}).`);
    }
    await this.benutzerverwaltung.konfigAendern((roh) => {
      roh.tls = { ...roh.tls, modus: 'aus' };
      roh.port = HTTP_PORT;
    });
    this.log(`Zurück auf HTTP (Port ${HTTP_PORT}) durch ${benutzer}.`);
    return this.neuStarten(`http://<Adresse des Workers>:${HTTP_PORT}/`);
  }

  neuStarten(adresse) {
    if (!this.neustart) return { neustart: false, adresse, hinweis: 'Gespeichert. Bitte die Basis neu starten (Start.exe --neustart), damit die Änderung gilt.' };
    setTimeout(() => this.neustart(), 500).unref?.();
    return { neustart: true, adresse };
  }
}
