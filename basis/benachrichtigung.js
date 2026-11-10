import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { melde } from './protokoll.js';
import { istKlartext, istVerschluesselt } from './geheimnis.js';

// Zentrale Benachrichtigung per Mail über Microsoft 365 (Graph, App-Registrierung mit
// Client-Secret, Anwendungsberechtigung Mail.Send – per RBAC for Applications auf das
// Absenderpostfach beschränkt). Läuft ohne angemeldeten Benutzer, auch unter SYSTEM.

const STUNDE = 3_600_000;
const WIEDERHOLEN_MS = 5 * 60_000;
const MAX_VERLAUF = 20;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
// modul_empfaenger: { <Modul-id>: [Adressen] } – bekommen die Mails dieses Moduls zusätzlich zu den allgemeinen Empfängern.
// bericht: regelmäßiger Statusbericht ('aus' | 'taeglich' | 'werktags' | 'woechentlich') zur bericht_uhrzeit (Ortszeit),
// wöchentlich am bericht_wochentag (1 = Montag … 7 = Sonntag).
// erlaubte_domains: nur Adressen dieser Domänen dürfen Benutzer unter „Meine Benachrichtigungen“ eintragen.
const STANDARD = { aktiv: false, tenant_id: '', client_id: '', client_secret: '', absender: '', empfaenger: [], erinnerung_stunden: 4, melden_nach_laeufen: 1, link: '', modul_empfaenger: {},
  bericht: 'aus', bericht_uhrzeit: '07:30', bericht_wochentag: 1, erlaubte_domains: ['konsum-weimar.de'] };
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BERICHT_ARTEN = ['aus', 'taeglich', 'werktags', 'woechentlich'];
const UHRZEIT = /^([01]\d|2[0-3]):[0-5]\d$/;
const NACHHOLEN_MS = 12 * STUNDE;
const ZEITZONE = 'Europe/Berlin';

export class MailFehler extends Error {}

// Versand über Microsoft Graph. Das Zugriffstoken wird bis kurz vor Ablauf wiederverwendet.
export class GraphMail {
  constructor({ tenantId, clientId, clientSecret, absender, fetchImpl = fetch, jetzt = () => Date.now() }) {
    Object.assign(this, { tenantId, clientId, clientSecret, absender, fetchImpl, jetzt });
    this.zugang = null;
  }

  async anfrage(url, optionen) {
    try { return await this.fetchImpl(url, { ...optionen, signal: AbortSignal.timeout(20_000) }); }
    catch (fehler) { throw new MailFehler(`Microsoft 365 nicht erreichbar (${fehler.cause?.code ?? fehler.name ?? fehler.message}). Ausgehende Verbindung zu login.microsoftonline.com und graph.microsoft.com prüfen.`); }
  }

  async token() {
    if (this.zugang && this.zugang.bis > this.jetzt()) return this.zugang.token;
    const antwort = await this.anfrage(`https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok || !daten.access_token) {
      const code = String(daten.error_description ?? '').match(/AADSTS\d+/)?.[0];
      throw new MailFehler(`Anmeldung bei Microsoft fehlgeschlagen (${code ?? daten.error ?? `HTTP ${antwort.status}`}). Mandanten-ID, Anwendungs-ID und geheimen Schlüssel prüfen; abgelaufene Schlüssel in Entra erneuern.`);
    }
    this.zugang = { token: daten.access_token, bis: this.jetzt() + Math.max(60, (daten.expires_in ?? 3600) - 300) * 1000 };
    return this.zugang.token;
  }

  async senden({ an, bcc = [], betreff, text }) {
    const token = await this.token();
    const antwort = await this.anfrage(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.absender)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { subject: betreff, body: { contentType: 'Text', content: text }, toRecipients: an.map((address) => ({ emailAddress: { address } })),
          ...(bcc.length ? { bccRecipients: bcc.map((address) => ({ emailAddress: { address } })) } : {}) },
        saveToSentItems: false,
      }),
    });
    if (antwort.status === 202) return;
    if (antwort.status === 401) this.zugang = null;
    const fehler = (await antwort.json().catch(() => ({})))?.error ?? {};
    const hinweis = {
      403: `Die App darf nicht als ${this.absender} senden. Berechtigung „Application Mail.Send“ für dieses Postfach in Exchange (RBAC for Applications) prüfen – Änderungen wirken erst nach bis zu 2 Stunden.`,
      404: `Absenderpostfach ${this.absender} nicht gefunden.`,
      401: 'Zugriff abgelehnt (Token ungültig).',
    }[antwort.status] ?? `Versand fehlgeschlagen (HTTP ${antwort.status}${fehler.code ? `, ${fehler.code}` : ''}).`;
    throw new MailFehler(hinweis);
  }
}

// Adressliste aus Text („a@b.de, c@d.de; e@f.de“) oder Array.
const adressenLesen = (wert) => (Array.isArray(wert) ? wert.map((x) => String(x).trim()).filter(Boolean)
  : typeof wert === 'string' ? wert.split(/[\s,;]+/).filter(Boolean) : null);
// Doppelte Adressen (ohne Groß-/Kleinschreibung) entfernen, die erste Schreibweise bleibt.
const ohneDoppelte = (liste) => liste.filter((m, i) => liste.findIndex((x) => x.toLowerCase() === m.toLowerCase()) === i);
function adressenFehler(liste) {
  if (liste.length > 20) return 'höchstens 20 Empfänger';
  const falsch = liste.filter((m) => !MAIL.test(m));
  return falsch.length ? `ungültig: ${falsch.join(', ')}` : null;
}

// Prüft die Eingabe aus dem Formular. Liefert { werte } oder { feldfehler }.
export function pruefeEinstellungen(eingabe, bisher) {
  const feldfehler = {};
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const text = (k) => (typeof e[k] === 'string' ? e[k].trim() : e[k] === undefined ? bisher[k] : '');
  const werte = {
    aktiv: e.aktiv === undefined ? bisher.aktiv : e.aktiv === true,
    tenant_id: text('tenant_id'),
    client_id: text('client_id'),
    // Leeres Feld = bisherigen Schlüssel behalten (er wird nie angezeigt).
    client_secret: typeof e.client_secret === 'string' && e.client_secret !== '' ? e.client_secret : bisher.client_secret,
    absender: text('absender'),
    empfaenger: adressenLesen(e.empfaenger) ?? bisher.empfaenger,
    erinnerung_stunden: e.erinnerung_stunden === undefined ? bisher.erinnerung_stunden : Number(String(e.erinnerung_stunden).replace(',', '.')),
    melden_nach_laeufen: e.melden_nach_laeufen === undefined ? bisher.melden_nach_laeufen : Number(e.melden_nach_laeufen),
    link: text('link'),
    bericht: e.bericht === undefined ? bisher.bericht ?? STANDARD.bericht : e.bericht,
    bericht_uhrzeit: e.bericht_uhrzeit === undefined ? bisher.bericht_uhrzeit ?? STANDARD.bericht_uhrzeit : String(e.bericht_uhrzeit).trim(),
    bericht_wochentag: e.bericht_wochentag === undefined ? bisher.bericht_wochentag ?? STANDARD.bericht_wochentag : Number(e.bericht_wochentag),
    erlaubte_domains: e.erlaubte_domains === undefined ? bisher.erlaubte_domains ?? STANDARD.erlaubte_domains
      : (adressenLesen(e.erlaubte_domains) ?? []).map((d) => d.toLowerCase().replace(/^@/, '')).filter((d, i, l) => l.indexOf(d) === i),
    // Wird separat je Modul gepflegt (modulEmpfaengerSpeichern) und hier nur übernommen.
    modul_empfaenger: bisher.modul_empfaenger ?? {},
  };
  if (werte.tenant_id && !GUID.test(werte.tenant_id) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(werte.tenant_id)) feldfehler.tenant_id = 'GUID oder Domain (z. B. firma.onmicrosoft.com)';
  if (werte.client_id && !GUID.test(werte.client_id)) feldfehler.client_id = 'muss eine GUID sein';
  if (werte.absender && !MAIL.test(werte.absender)) feldfehler.absender = 'keine gültige Mailadresse';
  const empfaengerFehler = adressenFehler(werte.empfaenger);
  if (empfaengerFehler) feldfehler.empfaenger = empfaengerFehler;
  if (!Number.isFinite(werte.erinnerung_stunden) || werte.erinnerung_stunden < 0 || werte.erinnerung_stunden > 168) feldfehler.erinnerung_stunden = '0 (aus) bis 168';
  if (!Number.isInteger(werte.melden_nach_laeufen) || werte.melden_nach_laeufen < 1 || werte.melden_nach_laeufen > 20) feldfehler.melden_nach_laeufen = 'ganze Zahl von 1 bis 20';
  if (werte.link && !/^https?:\/\/[^\s]+$/.test(werte.link)) feldfehler.link = 'muss mit http:// oder https:// beginnen';
  if (typeof werte.client_secret !== 'string' || werte.client_secret.length > 500) feldfehler.client_secret = 'ungültig';
  if (!BERICHT_ARTEN.includes(werte.bericht)) feldfehler.bericht = 'aus, täglich, werktags oder wöchentlich';
  if (!UHRZEIT.test(werte.bericht_uhrzeit)) feldfehler.bericht_uhrzeit = 'Uhrzeit wie 07:30';
  if (!Number.isInteger(werte.bericht_wochentag) || werte.bericht_wochentag < 1 || werte.bericht_wochentag > 7) feldfehler.bericht_wochentag = 'Wochentag 1 (Montag) bis 7 (Sonntag)';
  const falscheDomains = werte.erlaubte_domains.filter((d) => !DOMAIN.test(d));
  if (falscheDomains.length) feldfehler.erlaubte_domains = `ungültig: ${falscheDomains.join(', ')}`;
  else if (werte.erlaubte_domains.length > 10) feldfehler.erlaubte_domains = 'höchstens 10 Domänen';
  if (werte.aktiv) {
    for (const k of ['tenant_id', 'client_id', 'client_secret', 'absender']) if (!werte[k] && !feldfehler[k]) feldfehler[k] = 'Pflichtfeld, wenn die Benachrichtigung aktiv ist';
    if (!werte.empfaenger.length && !feldfehler.empfaenger) feldfehler.empfaenger = 'mindestens ein Empfänger';
  }
  return Object.keys(feldfehler).length ? { feldfehler } : { werte };
}

const TITEL = { fehler: 'FEHLER', warnung: 'WARNUNG', 'keine-meldung': 'KEINE MELDUNG', 'dienst-gestoppt': 'DIENST GESTOPPT', 'wieder-ok': 'WIEDER OK', erinnerung: 'ERINNERUNG', freigabe: 'FREIGABE NÖTIG' };
const STATUSTEXT = { fehler: 'Fehler', warnung: 'Warnung', 'keine-meldung': 'Keine Meldung', 'dienst-gestoppt': 'Dienst gestoppt', ok: 'OK', freigabe: 'Freigabe nötig' };
const zeitText = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
function dauerText(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 120 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} Tagen`;
}

// ---- Statusbericht: Termine in Ortszeit (Europa/Berlin, auch über die Zeitumstellung) ----
const teileFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZEITZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function ortszeit(ms) {
  const t = Object.fromEntries(teileFormat.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { jahr: t.year, monat: t.month, tag: t.day, stunde: t.hour, minute: t.minute, sekunde: t.second };
}
// Zeitpunkt (ms) einer Ortszeit; Abstand zu UTC an diesem Tag aus der Zeitzone ermittelt.
function ortszeitMs(jahr, monat, tag, stunde, minute) {
  const gewuenscht = Date.UTC(jahr, monat - 1, tag, stunde, minute);
  let ms = gewuenscht;
  for (let i = 0; i < 2; i++) {
    const o = ortszeit(ms);
    ms += gewuenscht - Date.UTC(o.jahr, o.monat - 1, o.tag, o.stunde, o.minute, o.sekunde);
  }
  return ms;
}
const WOCHENTAG_NAME = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const RHYTHMUS_TEXT = { taeglich: 'täglich', werktags: 'werktags', woechentlich: 'wöchentlich' };

// Termine des Statusberichts um einen Zeitpunkt herum: der letzte fällige (≤ jetzt) und der nächste (> jetzt), sonst null.
export function berichtTermine(werte, jetzt) {
  if (!BERICHT_ARTEN.includes(werte.bericht) || werte.bericht === 'aus' || !UHRZEIT.test(werte.bericht_uhrzeit ?? '')) return { letzter: null, naechster: null };
  const [stunde, minute] = werte.bericht_uhrzeit.split(':').map(Number);
  const heute = ortszeit(jetzt);
  let letzter = null, naechster = null;
  for (let d = -8; d <= 8; d++) {
    // Kalendertag rechnen (über UTC, damit Monats- und Jahreswechsel stimmen).
    const tagUtc = new Date(Date.UTC(heute.jahr, heute.monat - 1, heute.tag + d));
    const wochentag = tagUtc.getUTCDay() || 7; // 1 = Montag … 7 = Sonntag
    if (werte.bericht === 'werktags' && wochentag > 5) continue;
    if (werte.bericht === 'woechentlich' && wochentag !== werte.bericht_wochentag) continue;
    const ms = ortszeitMs(tagUtc.getUTCFullYear(), tagUtc.getUTCMonth() + 1, tagUtc.getUTCDate(), stunde, minute);
    if (ms <= jetzt) letzter = ms;
    else if (naechster === null) naechster = ms;
  }
  return { letzter, naechster };
}
export function berichtText(werte) {
  if (werte.bericht === 'aus') return null;
  return `${RHYTHMUS_TEXT[werte.bericht]}${werte.bericht === 'woechentlich' ? ` ${WOCHENTAG_NAME[werte.bericht_wochentag]}` : ''} ${werte.bericht_uhrzeit}`;
}

// Anzeige im Statusbericht; Probleme zuerst.
const BERICHT_STATUS = { ok: 'OK', warnung: 'Warnung', fehler: 'Fehler', modulfehler: 'Modul fehlerhaft', freigabe: 'Freigabe nötig', 'keine-meldung': 'Keine Meldung', 'dienst-gestoppt': 'Dienst gestoppt', inaktiv: 'Pausiert', beendet: 'Beendet', unbekannt: 'Noch keine Meldung', laeuft: 'Prüfung läuft' };
const BERICHT_RANG = { fehler: 0, modulfehler: 0, 'dienst-gestoppt': 0, freigabe: 1, 'keine-meldung': 1, warnung: 2 };
const istProblem = (m) => m.anzeige in BERICHT_RANG;

// Welche Kategorie zählt für die Benachrichtigung? null = nichts melden/ändern.
function kategorie(m, meldenNach) {
  if (m.anzeige === 'modulfehler') return 'fehler';
  if (m.anzeige === 'freigabe') return 'freigabe';
  if (m.anzeige === 'keine-meldung') return 'keine-meldung';
  if (m.anzeige === 'dienst-gestoppt') return 'dienst-gestoppt';
  if (m.anzeige === 'ok') return 'ok';
  if (m.anzeige === 'fehler' || m.anzeige === 'warnung') return m.problemLaeufe >= meldenNach ? m.anzeige : null;
  return null; // inaktiv, beendet, unbekannt, läuft
}

// ---- Meine Benachrichtigungen: Abos der Benutzer ----
// Stufe je Modul: „fehler“ = Fehler, Modul fehlerhaft, Keine Meldung, Dienst gestoppt; „alle“ = zusätzlich Warnungen.
// „Freigabe nötig“, Sicherheitsmeldungen und „Basis beendet“ gehen nur an die allgemeinen Empfänger.
const STUFEN = ['fehler', 'alle'];
const STUFE_UMFASST = { fehler: ['fehler', 'keine-meldung', 'dienst-gestoppt'], alle: ['fehler', 'keine-meldung', 'dienst-gestoppt', 'warnung'] };
const CODE_GUELTIG_MS = 15 * 60_000;
const CODE_VERSUCHE = 5;
const CODE_ABSTAND_MS = 60_000;
const CODE_JE_STUNDE = 5;
const domainVon = (adresse) => String(adresse).slice(String(adresse).lastIndexOf('@') + 1).toLowerCase();
const codeHash = (name, code) => createHash('sha256').update(`${name}\n${code}`).digest();

// Prüft die Abo-Einstellungen eines Benutzers. modulIds: vorhandene Module (unbekannte werden verworfen).
export function pruefeAbo(eingabe, bisher, modulIds) {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const feldfehler = {};
  const module = {};
  const roh = e.module && typeof e.module === 'object' && !Array.isArray(e.module) ? e.module : bisher.module ?? {};
  for (const [id, stufe] of Object.entries(roh)) {
    if (!modulIds.includes(id) || stufe === 'aus' || stufe === null) continue;
    if (STUFEN.includes(stufe)) module[id] = stufe; else feldfehler[`modul:${id}`] = 'aus, nur Fehler oder Fehler und Warnungen';
  }
  const werte = {
    module,
    entwarnung: e.entwarnung === undefined ? bisher.entwarnung === true : e.entwarnung === true,
    bericht: e.bericht === undefined ? bisher.bericht ?? 'aus' : e.bericht,
    bericht_uhrzeit: e.bericht_uhrzeit === undefined ? bisher.bericht_uhrzeit ?? STANDARD.bericht_uhrzeit : String(e.bericht_uhrzeit).trim(),
    bericht_wochentag: e.bericht_wochentag === undefined ? bisher.bericht_wochentag ?? STANDARD.bericht_wochentag : Number(e.bericht_wochentag),
  };
  if (!BERICHT_ARTEN.includes(werte.bericht)) feldfehler.bericht = 'aus, täglich, werktags oder wöchentlich';
  if (!UHRZEIT.test(werte.bericht_uhrzeit)) feldfehler.bericht_uhrzeit = 'Uhrzeit wie 07:30';
  if (!Number.isInteger(werte.bericht_wochentag) || werte.bericht_wochentag < 1 || werte.bericht_wochentag > 7) feldfehler.bericht_wochentag = 'Wochentag 1 (Montag) bis 7 (Sonntag)';
  return Object.keys(feldfehler).length ? { feldfehler } : { werte };
}

export class Benachrichtigung {
  constructor({ datenOrdner, log = () => {}, geheimnisse = [], fetchImpl = fetch, jetzt = () => Date.now(), tresor = null }) {
    Object.assign(this, { log, geheimnisse, fetchImpl, jetzt, tresor });
    // Für den Statusbericht: { version, seit (ms), update (Version oder null) } – setzt main.js.
    this.basisInfo = () => ({});
    // Rechte je Modul (setzt main.js): darf der Benutzer das Modul sehen? Ohne Recht keine Mails und kein Eintrag im Bericht.
    this.darfSehen = () => true;
    this.datei = path.join(datenOrdner, 'benachrichtigung.json');
    this.zustandDatei = path.join(datenOrdner, 'benachrichtigung-zustand.json');
    this.aboDatei = path.join(datenOrdner, 'benachrichtigung-abos.json');
    this.werte = { ...STANDARD };
    this.zustand = { module: {}, verlauf: [] };
    // abos: { <Benutzer>: { adresse, module: { <Modul-id>: 'fehler'|'alle' }, entwarnung, bericht, bericht_uhrzeit, bericht_wochentag } }
    this.abos = {};
    // Ausstehende Bestätigungscodes und Versandzeiten je Benutzer – nur im Speicher.
    this.codes = new Map();
    this.codeVersand = new Map();
  }

  async laden() {
    try { this.werte = { ...STANDARD, ...JSON.parse(await readFile(this.datei, 'utf8')) }; } catch { /* noch nicht eingerichtet */ }
    // Der geheime Schlüssel liegt verschlüsselt in der Datei (siehe geheimnis.js), im Speicher als Klartext.
    if (istVerschluesselt(this.werte.client_secret)) {
      try { this.werte.client_secret = await this.tresor.einzeln(this.werte.client_secret); }
      catch (fehler) {
        this.werte.client_secret = '';
        melde(this.log, 'fehler', 'Benachrichtigung', `Der geheime Schlüssel für den Mailversand lässt sich nicht entschlüsseln (${fehler.message}). Bitte unter „Benachrichtigung“ neu eintragen.`);
      }
    }
    try { this.zustand = { module: {}, verlauf: [], ...JSON.parse(await readFile(this.zustandDatei, 'utf8')) }; } catch { /* erster Start */ }
    try {
      const abos = JSON.parse(await readFile(this.aboDatei, 'utf8'))?.benutzer;
      this.abos = abos && typeof abos === 'object' && !Array.isArray(abos) ? abos : {};
    } catch { /* noch keine Abos */ }
    this.geheimnisMerken();
    this.mail = null;
  }

  // Schreibt die Einstellungen; der geheime Schlüssel wird unter Windows verschlüsselt gespeichert.
  async schreiben(werte) {
    const datei = this.tresor?.verfuegbar && istKlartext(werte.client_secret) ? { ...werte, client_secret: (await this.tresor.schuetzen([werte.client_secret], 'basis'))[0] } : werte;
    await schreibeAtomar(this.datei, datei);
  }

  // Umstellung älterer Installationen: Klartext in der Datei verschlüsseln. Liefert die Anzahl.
  async verschluesseln() {
    let roh;
    try { roh = JSON.parse(await readFile(this.datei, 'utf8')); } catch { return 0; }
    if (!istKlartext(roh?.client_secret)) return 0;
    await this.schreiben({ ...roh, client_secret: roh.client_secret });
    return 1;
  }

  geheimnisMerken() {
    if (this.werte.client_secret && !this.geheimnisse.includes(this.werte.client_secret)) this.geheimnisse.push(this.werte.client_secret);
  }

  eingerichtet() {
    const w = this.werte;
    return Boolean(w.tenant_id && w.client_id && w.client_secret && w.absender && w.empfaenger.length);
  }

  postfach() {
    this.mail ??= new GraphMail({ tenantId: this.werte.tenant_id, clientId: this.werte.client_id, clientSecret: this.werte.client_secret, absender: this.werte.absender, fetchImpl: this.fetchImpl, jetzt: this.jetzt });
    return this.mail;
  }

  // Für die Oberfläche: der Schlüssel wird nie herausgegeben.
  ansicht() {
    const { client_secret: schluessel, ...rest } = this.werte;
    const { naechster } = berichtTermine(this.werte, this.jetzt());
    return { werte: { ...rest, client_secret: { gesetzt: Boolean(schluessel) } }, eingerichtet: this.eingerichtet(), verlauf: this.zustand.verlauf,
      bericht: { text: berichtText(this.werte), naechster: naechster ? new Date(naechster).toISOString() : null } };
  }

  async speichern(eingabe, benutzer) {
    const { werte, feldfehler } = pruefeEinstellungen(eingabe, this.werte);
    if (feldfehler) return { feldfehler };
    const vorher = this.werte;
    this.werte = werte;
    this.mail = null;
    await this.schreiben(werte);
    this.geheimnisMerken();
    const geaendert = Object.keys(werte).filter((k) => JSON.stringify(werte[k]) !== JSON.stringify(vorher[k]));
    // Neuer Zeitplan gilt ab jetzt: ein heute schon vergangener Termin wird nicht „nachgeholt“.
    if (geaendert.some((k) => k.startsWith('bericht'))) {
      this.zustand.bericht = { termin: berichtTermine(werte, this.jetzt()).letzter ?? 0 };
      await this.zustandSpeichern();
    }
    if (geaendert.length) this.log(`Benachrichtigung geändert durch ${benutzer}: ${geaendert.map((k) => (k === 'client_secret' ? 'geheimer Schlüssel' : k)).join(', ')}.`);
    return { geaendert };
  }

  // Zusätzliche Empfänger eines Moduls (leer = nur die allgemeinen Empfänger).
  modulEmpfaenger(id) { return [...(this.werte.modul_empfaenger?.[id] ?? [])]; }

  async modulEmpfaengerSpeichern(id, eingabe, benutzer) {
    const liste = ohneDoppelte(adressenLesen(eingabe) ?? []);
    const fehler = adressenFehler(liste);
    if (fehler) return { fehler: `Empfänger: ${fehler}` };
    const vorher = this.modulEmpfaenger(id);
    const alle = { ...(this.werte.modul_empfaenger ?? {}) };
    if (liste.length) alle[id] = liste; else delete alle[id];
    this.werte = { ...this.werte, modul_empfaenger: alle };
    await this.schreiben(this.werte);
    if (JSON.stringify(vorher) !== JSON.stringify(liste)) this.log(`Empfänger für Modul ${id} geändert durch ${benutzer}: ${liste.length ? liste.join(', ') : 'keine zusätzlichen'}.`);
    return { empfaenger: liste };
  }

  // ---- Meine Benachrichtigungen ----
  verfuegbar() { return this.werte.aktiv === true && this.eingerichtet(); }
  domainErlaubt(adresse) { return (this.werte.erlaubte_domains ?? []).includes(domainVon(adresse)); }
  // Bestätigte Adresse eines Benutzers, an die gerade gesendet werden darf (Domäne noch erlaubt), sonst null.
  aboAdresse(name) {
    const a = this.abos[name]?.adresse;
    return a && this.domainErlaubt(a) ? a : null;
  }
  // Benutzer, deren Abo für dieses Modul die Kategorie umfasst.
  abonnenten(modulId, k) {
    return Object.keys(this.abos).filter((n) => STUFE_UMFASST[this.abos[n].module?.[modulId]]?.includes(k) && this.aboAdresse(n) && this.darfSehen(n, modulId));
  }

  async abosSpeichern() { await schreibeAtomar(this.aboDatei, { benutzer: this.abos }); }

  // Für die Oberfläche (nur der eigene Benutzer).
  meineAnsicht(name) {
    const abo = this.abos[name] ?? {};
    const offen = this.codes.get(name);
    const jetzt = this.jetzt();
    const bericht = { bericht: abo.bericht ?? 'aus', bericht_uhrzeit: abo.bericht_uhrzeit ?? STANDARD.bericht_uhrzeit, bericht_wochentag: abo.bericht_wochentag ?? STANDARD.bericht_wochentag };
    const { naechster } = berichtTermine(bericht, jetzt);
    return {
      verfuegbar: this.verfuegbar(),
      erlaubteDomains: [...(this.werte.erlaubte_domains ?? [])],
      adresse: abo.adresse ?? null,
      adresseRuht: Boolean(abo.adresse && !this.domainErlaubt(abo.adresse)),
      ausstehend: offen && offen.bis > jetzt && offen.versuche < CODE_VERSUCHE ? { adresse: offen.adresse, bis: new Date(offen.bis).toISOString() } : null,
      module: { ...(abo.module ?? {}) },
      entwarnung: abo.entwarnung === true,
      ...bericht,
      naechsterBericht: abo.adresse && naechster ? new Date(naechster).toISOString() : null,
    };
  }

  async meineSpeichern(name, eingabe, modulIds) {
    const bisher = this.abos[name] ?? {};
    const { werte, feldfehler } = pruefeAbo(eingabe, bisher, modulIds);
    if (feldfehler) return { feldfehler };
    // Module, die es nicht mehr gibt, fallen beim Speichern weg.
    this.abos[name] = { ...bisher, ...werte };
    if (['bericht', 'bericht_uhrzeit', 'bericht_wochentag'].some((k) => werte[k] !== bisher[k])) {
      // Neuer Zeitplan gilt ab jetzt: ein heute schon vergangener Termin wird nicht nachgeholt.
      this.zustand.berichte = { ...(this.zustand.berichte ?? {}), [name]: { termin: berichtTermine(werte, this.jetzt()).letzter ?? 0 } };
      await this.zustandSpeichern();
    }
    await this.abosSpeichern();
    const anzahl = Object.keys(werte.module).length;
    this.log(`Meine Benachrichtigungen geändert von ${name}: ${anzahl} Modul-Abo(s), Entwarnung ${werte.entwarnung ? 'ja' : 'nein'}, Statusbericht ${berichtText(werte) ?? 'aus'}.`);
    return { ansicht: this.meineAnsicht(name) };
  }

  // Schickt einen Bestätigungscode an eine neue Adresse. Liefert { ok, ansicht } oder { fehler, status, wartenS? }.
  async codeAnfordern(name, eingabe) {
    if (!this.verfuegbar()) return { fehler: 'Die Benachrichtigung ist nicht eingerichtet. Bitte einen Admin fragen.', status: 409 };
    const adresse = typeof eingabe === 'string' ? eingabe.trim() : '';
    if (!MAIL.test(adresse) || adresse.length > 254) return { fehler: 'Bitte eine gültige Mail-Adresse eingeben.', status: 400 };
    if (!this.domainErlaubt(adresse)) {
      const d = this.werte.erlaubte_domains ?? [];
      return { fehler: d.length ? `Erlaubt sind nur Adressen mit ${d.map((x) => `@${x}`).join(', ')}.` : 'Ein Admin hat keine Domänen für eigene Adressen freigegeben.', status: 400 };
    }
    if (this.abos[name]?.adresse?.toLowerCase() === adresse.toLowerCase()) return { fehler: 'Diese Adresse ist bereits bestätigt.', status: 400 };
    const jetzt = this.jetzt();
    const gesendet = (this.codeVersand.get(name) ?? []).filter((t) => jetzt - t < STUNDE);
    const warten = gesendet.length ? CODE_ABSTAND_MS - (jetzt - gesendet[gesendet.length - 1]) : 0;
    if (warten > 0) return { fehler: `Bitte ${Math.ceil(warten / 1000)} Sekunden warten, bevor ein neuer Code verschickt wird.`, status: 429, wartenS: Math.ceil(warten / 1000) };
    if (gesendet.length >= CODE_JE_STUNDE) return { fehler: 'Zu viele Codes in der letzten Stunde. Bitte später erneut versuchen.', status: 429, wartenS: Math.ceil((gesendet[0] + STUNDE - jetzt) / 1000) };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codeVersand.set(name, [...gesendet, jetzt]);
    const eintrag = await this.versenden('code', `[Monitoring] Bestätigungscode für ${name}`, this.text([
      `Bestätigungscode: ${code}`,
      '',
      `Der Benutzer ${name} möchte diese Adresse in der Monitoring-Basis für eigene Benachrichtigungen eintragen.`,
      'Der Code gilt 15 Minuten. Wenn du das nicht warst, kannst du diese Mail ignorieren.',
      this.werte.link ? `\nOberfläche: ${this.werte.link}` : null,
    ]), null, { an: [adresse], benutzer: name });
    await this.zustandSpeichern();
    if (!eintrag.ok) return { fehler: `Der Code konnte nicht verschickt werden: ${eintrag.fehler}`, status: 502 };
    this.codes.set(name, { adresse, hash: codeHash(name, code), bis: jetzt + CODE_GUELTIG_MS, versuche: 0 });
    this.log(`Bestätigungscode an ${adresse} verschickt (Benutzer ${name}).`);
    return { ok: true, ansicht: this.meineAnsicht(name) };
  }

  async codeBestaetigen(name, eingabe) {
    const offen = this.codes.get(name);
    const jetzt = this.jetzt();
    if (!offen || offen.bis <= jetzt || offen.versuche >= CODE_VERSUCHE) {
      this.codes.delete(name);
      return { fehler: 'Kein gültiger Code offen. Bitte einen neuen Code anfordern.', status: 400 };
    }
    const code = typeof eingabe === 'string' ? eingabe.replace(/\s/g, '') : '';
    if (!/^\d{6}$/.test(code) || !timingSafeEqual(codeHash(name, code), offen.hash)) {
      offen.versuche += 1;
      const rest = CODE_VERSUCHE - offen.versuche;
      if (!rest) this.codes.delete(name);
      return { fehler: rest ? `Der Code stimmt nicht (noch ${rest} Versuch${rest === 1 ? '' : 'e'}).` : 'Der Code stimmt nicht. Bitte einen neuen Code anfordern.', status: 400 };
    }
    this.codes.delete(name);
    const vorher = this.abos[name]?.adresse;
    this.abos[name] = { module: {}, entwarnung: false, bericht: 'aus', bericht_uhrzeit: STANDARD.bericht_uhrzeit, bericht_wochentag: STANDARD.bericht_wochentag, ...this.abos[name], adresse: offen.adresse };
    await this.abosSpeichern();
    this.log(`Adresse für Benachrichtigungen von ${name} bestätigt: ${offen.adresse}${vorher ? ` (vorher ${vorher})` : ''}.`);
    return { ok: true, ansicht: this.meineAnsicht(name) };
  }

  // Abos und Adresse eines Benutzers löschen (durch ihn selbst, einen Admin oder beim Löschen des Benutzers).
  async aboLoeschen(name, durch) {
    this.codes.delete(name);
    if (!Object.hasOwn(this.abos, name)) return false;
    delete this.abos[name];
    if (this.zustand.berichte?.[name]) { delete this.zustand.berichte[name]; await this.zustandSpeichern(); }
    await this.abosSpeichern();
    this.log(`Benachrichtigungen von ${name} gelöscht${durch && durch !== name ? ` durch ${durch}` : ''}.`);
    return true;
  }

  // Beim Start: Abos von Benutzern entfernen, die es nicht mehr gibt (z. B. per Kommandozeile gelöscht).
  async abosBereinigen(namen) {
    for (const n of Object.keys(this.abos)) if (!namen.includes(n)) await this.aboLoeschen(n, 'Basis (Benutzer gibt es nicht mehr)');
  }

  // Für die Benutzerverwaltung (Admins): Adresse und Zahl der Abos je Benutzer.
  aboUebersicht() {
    return Object.fromEntries(Object.entries(this.abos).map(([n, a]) => [n, {
      adresse: a.adresse ?? null, ruht: Boolean(a.adresse && !this.domainErlaubt(a.adresse)),
      module: Object.keys(a.module ?? {}).length, bericht: berichtText({ ...STANDARD, ...a }) }]));
  }

  // Eigener Statusbericht sofort (Knopf „Bericht jetzt an mich senden“).
  async meinBerichtSenden(name, ansichten) {
    if (!this.verfuegbar()) return { fehler: 'Die Benachrichtigung ist nicht eingerichtet. Bitte einen Admin fragen.', status: 409 };
    const adresse = this.aboAdresse(name);
    if (!adresse) return { fehler: 'Bitte zuerst eine Adresse bestätigen.', status: 400 };
    const { betreff, text } = this.berichtMail(ansichten, this.jetzt(), null, name);
    const eintrag = await this.versenden('bericht', betreff, text, null, { an: [adresse], benutzer: name });
    await this.zustandSpeichern();
    return eintrag.ok ? { ok: true } : { fehler: `Nicht gesendet: ${eintrag.fehler}`, status: 502 };
  }

  text(zeilen) { return zeilen.filter((z) => z !== null && z !== undefined).join('\n'); }

  // an: abweichende Empfänger (Mails an einen einzelnen Benutzer); bcc: Adressen der Abonnenten.
  async versenden(art, betreff, text, modulId = null, { an: nur = null, bcc = [], benutzer = null } = {}) {
    const eintrag = { zeit: new Date(this.jetzt()).toISOString(), art, modul: modulId, betreff, ok: true, ...(benutzer ? { benutzer } : {}) };
    try {
      // Allgemeine Empfänger plus die des Moduls, doppelte Adressen (ohne Groß-/Kleinschreibung) nur einmal.
      const an = nur ?? ohneDoppelte([...this.werte.empfaenger, ...(modulId ? this.modulEmpfaenger(modulId) : [])]);
      const blind = ohneDoppelte(bcc).filter((b) => !an.some((a) => a.toLowerCase() === b.toLowerCase()));
      await this.postfach().senden({ an, bcc: blind, betreff, text });
      eintrag.an = an.length;
      if (blind.length) eintrag.bcc = blind.length;
      this.log(`Benachrichtigung gesendet: ${betreff}`);
    } catch (fehler) {
      eintrag.ok = false;
      eintrag.fehler = fehler.message;
      melde(this.log, 'fehler', 'Benachrichtigung', `Mail „${betreff}“ nicht gesendet: ${fehler.message}`, fehler instanceof MailFehler ? undefined : fehler);
    }
    this.zustand.verlauf = [eintrag, ...this.zustand.verlauf].slice(0, MAX_VERLAUF);
    return eintrag;
  }

  // Sicherheitsmeldung (gesperrte Anmeldung, Admin von neuer Adresse) an die allgemeinen Empfänger.
  async sicherheit(betreff, text) {
    if (!this.werte.aktiv || !this.eingerichtet()) return null;
    const eintrag = await this.versenden('sicherheit', betreff, this.text([text, this.werte.link ? `\nOberfläche: ${this.werte.link}` : null]));
    await this.zustandSpeichern();
    return eintrag;
  }

  async testmail(benutzer) {
    if (!this.eingerichtet()) return { ok: false, fehler: 'Bitte zuerst Mandanten-ID, Anwendungs-ID, Schlüssel, Absender und Empfänger speichern.' };
    const eintrag = await this.versenden('test', '[Monitoring] Testmail', this.text([
      `Diese Testmail wurde von ${benutzer} in der Monitoring-Basis ausgelöst.`,
      'Wenn sie ankommt, ist die Benachrichtigung richtig eingerichtet.',
      this.werte.link ? `\nOberfläche: ${this.werte.link}` : null,
    ]));
    await this.zustandSpeichern();
    return eintrag;
  }

  // Statusbericht: Gesamtstatus, Basis und eine Zeile je Modul (Probleme zuerst).
  // benutzer: eigener Bericht eines Benutzers (Hinweis am Ende).
  berichtMail(ansichten, jetzt, verspaetet = null, benutzer = null) {
    const probleme = ansichten.filter(istProblem);
    const zaehlung = {};
    for (const m of probleme) { const t = BERICHT_STATUS[m.anzeige]; zaehlung[t] = (zaehlung[t] ?? 0) + 1; }
    const gesamt = probleme.length ? `${probleme.length} ${probleme.length === 1 ? 'Problem' : 'Probleme'}` : 'alles OK';
    const b = this.basisInfo() ?? {};
    const sortiert = [...ansichten].sort((x, y) => (BERICHT_RANG[x.anzeige] ?? 9) - (BERICHT_RANG[y.anzeige] ?? 9) || x.name.localeCompare(y.name, 'de'));
    const betreff = `[Monitoring] Statusbericht: ${gesamt}${verspaetet ? ' (verspätet)' : ''}`;
    const text = this.text([
      `Statusbericht der Monitoring-Basis vom ${zeitText(jetzt)}`,
      verspaetet ? `Verspätet: geplant für ${zeitText(verspaetet)}, die Basis lief zu dieser Zeit nicht.` : null,
      '',
      `Gesamt: ${probleme.length ? `${gesamt} (${Object.entries(zaehlung).map(([t, n]) => `${n} ${t}`).join(', ')})` : 'alles OK'}`,
      `Basis: läuft${b.seit ? ` seit ${zeitText(b.seit)} (${dauerText(jetzt - b.seit)})` : ''}${b.version ? ` · v${b.version}` : ''}${b.update ? ` · Update auf v${b.update} verfügbar` : ''}`,
      '',
      ansichten.length ? 'Module:' : 'Keine Module eingerichtet.',
      ...sortiert.map((m) => `- ${m.name}: ${BERICHT_STATUS[m.anzeige] ?? m.anzeige}`),
      this.werte.link ? `\nOberfläche: ${this.werte.link}` : null,
      benutzer ? `\nDein eigener Statusbericht (Benutzer ${benutzer}) – ändern unter „Meine Benachrichtigungen“.` : null,
    ]);
    return { betreff, text };
  }

  // Statusbericht sofort senden (Knopf in der Oberfläche).
  async berichtSenden(ansichten, benutzer) {
    if (!this.eingerichtet()) return { ok: false, fehler: 'Bitte zuerst Mandanten-ID, Anwendungs-ID, Schlüssel, Absender und Empfänger speichern.' };
    const { betreff, text } = this.berichtMail(ansichten, this.jetzt());
    const eintrag = await this.versenden('bericht', betreff, text);
    if (eintrag.ok) this.log(`Statusbericht ausgelöst durch ${benutzer}.`);
    await this.zustandSpeichern();
    return eintrag;
  }

  // Geplanter Statusbericht: einmal je Termin; nach einem Ausfall bis 12 Stunden später nachgeholt, nie doppelt.
  // Liefert true, wenn sich der Zustand geändert hat.
  async berichtPruefen(ansichten, jetzt) {
    const { letzter } = berichtTermine(this.werte, jetzt);
    const z = this.zustand.bericht ?? { termin: 0 };
    if (!letzter || letzter <= (z.termin ?? 0)) return false;
    if (z.naechsterVersuch && jetzt < z.naechsterVersuch) return false;
    if (jetzt - letzter > NACHHOLEN_MS) {
      this.zustand.bericht = { termin: letzter };
      this.log(`Statusbericht für ${zeitText(letzter)} nicht nachgeholt (mehr als 12 Stunden her).`);
      return true;
    }
    const verspaetet = jetzt - letzter > 15 * 60_000 ? letzter : null;
    const { betreff, text } = this.berichtMail(ansichten, jetzt, verspaetet);
    const eintrag = await this.versenden('bericht', betreff, text);
    this.zustand.bericht = eintrag.ok ? { termin: letzter } : { ...z, naechsterVersuch: jetzt + WIEDERHOLEN_MS };
    return true;
  }

  // Eigene Statusberichte der Benutzer: gleiche Regeln wie oben, Zustand je Benutzer. Liefert true bei Änderung.
  async berichteBenutzerPruefen(ansichten, jetzt) {
    let geaendert = false;
    const alle = this.zustand.berichte ?? {};
    for (const [name, abo] of Object.entries(this.abos)) {
      const adresse = this.aboAdresse(name);
      if (!adresse) continue;
      const { letzter } = berichtTermine({ ...STANDARD, ...abo }, jetzt);
      const z = alle[name] ?? { termin: 0 };
      if (!letzter || letzter <= (z.termin ?? 0) || (z.naechsterVersuch && jetzt < z.naechsterVersuch)) continue;
      geaendert = true;
      if (jetzt - letzter > NACHHOLEN_MS) { alle[name] = { termin: letzter }; continue; }
      const { betreff, text } = this.berichtMail(ansichten.filter((m) => this.darfSehen(name, m.id)), jetzt, jetzt - letzter > 15 * 60_000 ? letzter : null, name);
      const eintrag = await this.versenden('bericht', betreff, text, null, { an: [adresse], benutzer: name });
      alle[name] = eintrag.ok ? { termin: letzter } : { ...z, naechsterVersuch: jetzt + WIEDERHOLEN_MS };
    }
    this.zustand.berichte = alle;
    return geaendert;
  }

  mailText(m, art, jetzt, seit, mitAbos = false) {
    const l = m.letztes;
    return this.text([
      `Modul: ${m.name}${m.version ? ` (v${m.version})` : ''}`,
      `Status: ${STATUSTEXT[m.anzeige === 'modulfehler' ? 'fehler' : m.anzeige] ?? m.anzeige}`,
      m.fehler ? `Problem: ${m.fehler}` : m.anzeige === 'freigabe' ? `Problem: ${m.freigabe?.fehler ?? `Das Modul ist ${m.freigabe?.neu ? 'neu' : 'geändert'} und wird erst ausgeführt, wenn ein Admin es in der Oberfläche freigibt.`}` : m.anzeige === 'dienst-gestoppt' ? `Problem: ${m.dienst?.fehler ?? `Windows-Dienst „${m.dienst?.name}“ ist gestoppt.`}` : m.anzeige === 'keine-meldung' ? `Letzte Meldung: ${l ? zeitText(Date.parse(l.ende ?? l.beginn)) : 'noch nie'}` : l ? `Meldung: ${l.zusammenfassung}` : null,
      art !== 'wieder-ok' && seit ? `Seit: ${zeitText(seit)} (${dauerText(jetzt - seit)})` : null,
      m.problemLaeufe > 1 ? `Läufe ohne OK: ${m.problemLaeufe}` : null,
      ...(m.anzeige === 'freigabe' && art !== 'wieder-ok' && m.freigabe?.aenderungen?.length ? ['', 'Änderungen seit der letzten Freigabe:', ...m.freigabe.aenderungen.slice(0, 20).map((d) => `- ${d}`), ...(m.freigabe.aenderungen.length > 20 ? [`… und ${m.freigabe.aenderungen.length - 20} weitere`] : [])] : []),
      ...(m.anzeige !== 'freigabe' && art !== 'wieder-ok' && l?.details?.length ? ['', 'Details:', ...l.details.slice(0, 20).map((d) => `- ${d}`), ...(l.details.length > 20 ? [`… und ${l.details.length - 20} weitere`] : [])] : []),
      this.werte.link ? `\nOberfläche: ${this.werte.link}` : null,
      `\nZeit: ${zeitText(jetzt)}`,
      mitAbos ? '\nEinige Empfänger haben dieses Modul unter „Meine Benachrichtigungen“ selbst abonniert und können es dort ändern.' : null,
    ]);
  }

  // Wird nach jedem Einlesen der Module aufgerufen. Meldet Statuswechsel und Erinnerungen.
  async pruefen(ansichten) {
    if (this.laeuft || !this.werte.aktiv || !this.eingerichtet()) return;
    this.laeuft = true;
    try {
      const jetzt = this.jetzt();
      let geaendert = false;
      for (const m of ansichten) {
        const k = kategorie(m, this.werte.melden_nach_laeufen);
        if (!k) continue;
        const z = this.zustand.module[m.id] ?? { gemeldet: 'ok' };
        if (z.naechsterVersuch && jetzt < z.naechsterVersuch) continue;
        let art = null;
        if (k !== z.gemeldet) art = k === 'ok' ? 'wieder-ok' : k;
        else if (k !== 'ok' && this.werte.erinnerung_stunden > 0 && z.letzteMail && jetzt - z.letzteMail >= this.werte.erinnerung_stunden * STUNDE) art = 'erinnerung';
        if (!art) continue;
        const seit = art === 'erinnerung' ? z.seit : k === 'dienst-gestoppt' || k === 'freigabe' ? jetzt : (m.problemSeit ? Date.parse(m.problemSeit) : m.ueberfaelligSeit ? Date.parse(m.ueberfaelligSeit) : jetzt);
        const titel = art === 'erinnerung' ? `ERINNERUNG: ${m.name} – ${STATUSTEXT[k]} seit ${dauerText(jetzt - z.seit)}` : `${TITEL[art]}: ${m.name}`;
        // Abonnenten: bei Problemen je nach Stufe; Entwarnung nur an die, die das Problem gemeldet bekommen haben.
        const bisher = z.gemeldet && z.gemeldet !== 'ok' ? z.benutzer ?? [] : [];
        const nutzer = art === 'wieder-ok'
          ? bisher.filter((n) => this.abos[n]?.entwarnung === true && this.abos[n].module?.[m.id] && this.aboAdresse(n) && this.darfSehen(n, m.id))
          : this.abonnenten(m.id, k);
        const eintrag = await this.versenden(art, `[Monitoring] ${titel}`, this.mailText(m, art, jetzt, seit, nutzer.length > 0), m.id, { bcc: nutzer.map((n) => this.aboAdresse(n)) });
        geaendert = true;
        // Fehlgeschlagen: Zustand nicht übernehmen und in 5 Minuten erneut versuchen.
        if (!eintrag.ok) { this.zustand.module[m.id] = { ...z, naechsterVersuch: jetzt + WIEDERHOLEN_MS }; continue; }
        const gemeldetAn = k === 'ok' ? undefined : [...new Set([...bisher, ...nutzer])];
        this.zustand.module[m.id] = art === 'erinnerung' ? { ...z, letzteMail: jetzt, naechsterVersuch: undefined, benutzer: gemeldetAn }
          : { gemeldet: k, seit: k === 'ok' ? jetzt : seit, letzteMail: jetzt, ...(gemeldetAn?.length ? { benutzer: gemeldetAn } : {}) };
      }
      if (await this.berichtPruefen(ansichten, jetzt)) geaendert = true;
      if (await this.berichteBenutzerPruefen(ansichten, jetzt)) geaendert = true;
      if (geaendert) await this.zustandSpeichern();
    } finally {
      this.laeuft = false;
    }
  }

  // Vor dem Beenden der Basis: Bescheid geben, dass bis zum nächsten Start nichts überwacht wird.
  async basisBeendet(benutzer, mitModulen, fehler = []) {
    if (!this.werte.aktiv || !this.eingerichtet()) return null;
    const eintrag = await this.versenden('basis-beendet', `[Monitoring] Basis beendet durch ${benutzer}`, this.text([
      `Die Monitoring-Basis wurde von ${benutzer} beendet.`,
      'Bis zum nächsten Start werden keine Module überwacht und keine Benachrichtigungen verschickt.',
      mitModulen ? 'Die eigenständigen Module wurden ebenfalls beendet.' : 'Eigenständige Module laufen weiter.',
      ...(fehler.length ? ['', 'Nicht beendet:', ...fehler.map((f) => `- ${f}`)] : []),
      '',
      'Neu starten: auf dem Worker Start.exe ausführen oder im Aufgabenplaner die Aufgabe „Monitoring-Basis“ starten (oder Rechner neu starten).',
      `\nZeit: ${zeitText(this.jetzt())}`,
    ]));
    await this.zustandSpeichern();
    return eintrag;
  }

  async zustandSpeichern() {
    try { await schreibeAtomar(this.zustandDatei, this.zustand); }
    catch (fehler) { melde(this.log, 'fehler', 'Benachrichtigung', `Zustand konnte nicht gespeichert werden: ${fehler.message}`); }
  }
}
