'use strict';

const STATUS_TEXT = { ok: 'OK', warnung: 'Warnung', fehler: 'Fehler', modulfehler: 'Modul fehlerhaft', 'keine-meldung': 'Keine Meldung', unbekannt: 'Noch keine Meldung', inaktiv: 'Pausiert', laeuft: 'Läuft …', beendet: 'Beendet', 'dienst-gestoppt': 'Dienst gestoppt', freigabe: 'Freigabe nötig' };
const DIENST_TEXT = { laeuft: 'läuft', gestoppt: 'gestoppt', startet: 'wird gestartet …', stoppt: 'wird beendet …', pausiert: 'angehalten', fehlt: 'nicht installiert', unbekannt: 'Zustand unbekannt', 'nicht-verfuegbar': 'nur unter Windows abfragbar' };
const $ = (id) => document.getElementById(id);
let offenesModul = null;
let istAdmin = false;
let letzteModule = [];
let kontoName = null; // Konto der Basis (nur für Admins bekannt)

function relativ(iso) {
  if (!iso) return null;
  const sekunden = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const betrag = Math.abs(sekunden);
  if (betrag < 5) return 'gerade eben';
  const text = betrag < 60 ? `${betrag} s` : betrag < 3600 ? `${Math.round(betrag / 60)} min` : betrag < 86400 ? `${Math.round(betrag / 3600)} h` : `${Math.round(betrag / 86400)} Tagen`;
  return sekunden < 0 ? `vor ${text}` : `in ${text}`;
}
const zeit = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
const el = (tag, eigenschaften = {}, ...kinder) => { const e = document.createElement(tag); Object.assign(e, eigenschaften); e.append(...kinder); return e; };

async function api(weg, optionen = {}) {
  const antwort = await fetch(weg, { credentials: 'same-origin', ...optionen });
  if (antwort.status === 401) { location.href = '/login?fehler=abgelaufen'; throw new Error('abgemeldet'); }
  return antwort;
}
// Automatische Abfragen (Nachladen alle 10 s) zählen nicht als Aktivität – sonst würde man bei offener Seite nie abgemeldet.
const HINTERGRUND = { headers: { 'X-Monitor-Hintergrund': '1' } };
const senden = (weg, koerper) => api(weg, { method: 'POST', headers: { 'X-Monitor-Anfrage': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(koerper) });

const KEINE_VERBINDUNG = 'Keine Verbindung zur Monitoring-Basis.';
// Sperrt Schaltflächen während einer Anfrage und gibt sie immer wieder frei – auch wenn die Verbindung abbricht.
// Bei einem Verbindungsfehler erscheint die Meldung über „melden“; das Ergebnis ist dann undefined.
async function gesperrt(knoepfe, melden, arbeit) {
  for (const k of knoepfe) k.disabled = true;
  try { return await arbeit(); }
  catch (fehler) { if (fehler.message !== 'abgemeldet') melden(KEINE_VERBINDUNG, 'fehler'); return undefined; }
  finally { for (const k of knoepfe) k.disabled = false; }
}

// Statuszeile eines aufklappbaren Bereichs (sichtbar auch im zugeklappten Zustand).
function bereichStatus(id, text, art = '') {
  const s = $(`${id}-status`);
  s.textContent = text;
  s.dataset.art = art;
}

// Zweimal klicken: der erste Klick fragt nach, ein zweiter innerhalb von 5 s führt aus.
function nachfragen(knopf, frage, aktion) {
  knopf.addEventListener('click', () => {
    if (knopf.dataset.sicher !== '1') {
      knopf.dataset.sicher = '1';
      knopf.dataset.text = knopf.textContent;
      knopf.textContent = frage;
      setTimeout(() => { if (knopf.dataset.sicher === '1') { knopf.dataset.sicher = ''; knopf.textContent = knopf.dataset.text; } }, 5000);
      return;
    }
    knopf.dataset.sicher = '';
    knopf.textContent = knopf.dataset.text;
    aktion();
  });
}

function textZuModul(m) {
  if (m.fehler) return m.fehler;
  if (m.anzeige === 'freigabe') return m.freigabe?.fehler ?? `${m.freigabe?.neu ? 'Neues Modul' : 'Geändert'} – wird erst nach Freigabe durch einen Admin ausgeführt.`;
  if (m.anzeige === 'keine-meldung') {
    const letzte = m.letztes?.ende ?? m.letztes?.beginn;
    return letzte ? `Keine Meldung seit ${relativ(letzte).replace(/^vor /, '')} – läuft das Modul noch?` : 'Das Modul hat sich noch nie gemeldet – läuft es?';
  }
  if (m.statusFehler) return `Meldung nicht lesbar: ${m.statusFehler}`;
  if (m.anzeige === 'inaktiv') return 'Pausiert – wird nicht überwacht.';
  if (m.anzeige === 'beendet') return `Beendet ${relativ(m.beendet)}${m.beendetVon ? ` durch ${m.beendetVon}` : ''} – wird nicht überwacht, bis es sich wieder meldet.`;
  if (m.anzeige === 'dienst-gestoppt') return m.dienst?.fehler ?? `Windows-Dienst „${m.dienst?.name}“ ist gestoppt.`;
  return m.letztes?.zusammenfassung ?? (m.betriebsart === 'eigenstaendig' ? 'Wartet auf die erste Meldung des Moduls.' : 'Noch nicht geprüft.');
}

function leisteFuellen(container, verlauf) {
  container.replaceChildren(...verlauf.map((v) => el('span', { title: `${zeit(v.zeit)} – ${STATUS_TEXT[v.status] ?? v.status}`, className: `segment ${v.status}` })));
  container.hidden = !verlauf.length;
}

function zeitenText(m) {
  const teile = [];
  const letzte = m.letztes?.ende ?? m.letztes?.beginn;
  if (letzte) teile.push(`${m.betriebsart === 'eigenstaendig' ? 'Letzte Meldung' : 'Geprüft'} ${relativ(letzte)}`);
  if (m.problemLaeufe && m.problemSeit) teile.push(`Problem seit ${relativ(m.problemSeit)} (${m.problemLaeufe} ${m.problemLaeufe === 1 ? 'Lauf' : 'Läufe'})`);
  if (m.naechsterLauf && !m.laeuft && !['inaktiv', 'beendet', 'keine-meldung', 'dienst-gestoppt', 'freigabe'].includes(m.anzeige)) teile.push(`nächster Lauf ${relativ(m.naechsterLauf)}`);
  else if (m.betriebsart === 'basis' && !m.intervallMinuten && !m.fehler) teile.push('nur manuell');
  return teile.join(' · ');
}

function kachelBauen(m) {
  const kachel = $('kachel-vorlage').content.firstElementChild.cloneNode(true);
  kachel.dataset.status = m.anzeige;
  kachel.querySelector('.name').textContent = m.name;
  if (m.updateVerfuegbar) kachel.querySelector('.name').append(el('span', { className: 'hinweis-punkt', title: 'Update verfügbar' }));
  const pill = kachel.querySelector('.status');
  pill.textContent = STATUS_TEXT[m.anzeige] ?? m.anzeige;
  pill.dataset.status = m.anzeige;
  kachel.querySelector('.zusammenfassung').textContent = textZuModul(m);
  leisteFuellen(kachel.querySelector('.leiste'), m.verlaufKurz ?? []);
  kachel.querySelector('.zeiten').textContent = zeitenText(m);
  const knopf = kachel.querySelector('.pruefen');
  knopf.hidden = !m.kannPruefen;
  knopf.disabled = m.laeuft;
  knopf.addEventListener('click', () => pruefen(m.id, knopf));
  kachel.querySelector('.mehr').addEventListener('click', () => detailsOeffnen(m.id));
  return kachel;
}

async function aktualisieren() {
  try {
    const daten = await (await api('/api/status', HINTERGRUND)).json();
    $('verbindung').hidden = true;
    istAdmin = daten.admin;
    $('benutzer').textContent = daten.benutzer;
    $('version').textContent = daten.version ? `v${daten.version}` : '';
    $('einstellungen-oeffnen').hidden = !daten.admin;
    $('admin-hinweis').hidden = !daten.adminNurIntern;
    $('update-hinweis').hidden = !daten.updateVerfuegbar;
    $('sys-neustart').hidden = !daten.neustartMoeglich;
    $('sys-beenden').hidden = !daten.beendenMoeglich;
    const k = daten.konto ?? null;
    kontoName = k ? (k.system ? 'SYSTEM' : k.name) : null;
    $('sys-konto').hidden = !k;
    if (k) $('sys-konto-text').textContent = kontoText(k);
    $('ber-sys').hidden = !k && !daten.neustartMoeglich && !daten.beendenMoeglich;
    const aktionen = [daten.neustartMoeglich && 'Neu starten', daten.beendenMoeglich && 'Beenden'].filter(Boolean).join(' oder ');
    bereichStatus('ber-sys', [k && `Konto ${kontoName}`, aktionen].filter(Boolean).join(' · '), !k ? '' : k.fehlt?.length ? 'fehler' : k.system || k.admin ? 'warnung' : '');
    letzteModule = daten.module;
    const zaehler = { ok: 0, warnung: 0, fehler: 0, 'keine-meldung': 0 };
    for (const m of daten.module) {
      const s = ['modulfehler', 'dienst-gestoppt'].includes(m.anzeige) ? 'fehler' : m.anzeige === 'freigabe' ? 'warnung' : m.anzeige;
      if (s in zaehler) zaehler[s]++;
    }
    for (const [s, n] of Object.entries(zaehler)) $(`anzahl-${s}`).textContent = n;
    $('kacheln').replaceChildren(...daten.module.map(kachelBauen));
    $('leer').hidden = daten.module.length > 0;
    $('stand').textContent = `${daten.module.length} ${daten.module.length === 1 ? 'Modul' : 'Module'} · Stand ${new Date().toLocaleTimeString('de-DE')}`;
    const probleme = zaehler.fehler + zaehler['keine-meldung'];
    document.title = probleme ? `(${probleme}) Monitoring` : 'Monitoring';
    if (offenesModul) {
      const neu = daten.module.find((m) => m.id === offenesModul);
      if (neu) detailsFuellen(neu, true);
    }
  } catch (fehler) {
    if (fehler.message === 'abgemeldet') return;
    $('verbindung').textContent = 'Keine Verbindung zur Monitoring-Basis. Neuer Versuch in wenigen Sekunden …';
    $('verbindung').hidden = false;
  }
}

async function pruefen(id, knopf) {
  knopf.disabled = true;
  const vorher = knopf.textContent;
  knopf.textContent = 'Wird gestartet …';
  let antwort;
  try { antwort = await api(`/api/module/${encodeURIComponent(id)}/pruefen`, { method: 'POST', headers: { 'X-Monitor-Anfrage': '1' } }); }
  catch (fehler) {
    knopf.disabled = false;
    knopf.textContent = fehler.message === 'abgemeldet' ? vorher : 'Keine Verbindung';
    return;
  }
  if (!antwort.ok) {
    const { fehler } = await antwort.json().catch(() => ({}));
    knopf.textContent = fehler || 'Nicht möglich';
    knopf.title = knopf.textContent;
  }
  // Eine Ablehnung (z. B. „gerade erst geprüft“) etwas länger stehen lassen.
  setTimeout(aktualisieren, antwort.ok ? 800 : 4000);
}

function fakt(name, wert) { return wert ? [el('dt', { textContent: name }), el('dd', { textContent: wert })] : []; }
const prozent = (v) => (v ? `${v.prozent.toLocaleString('de-DE')} % (${v.laeufe} ${v.laeufe === 1 ? 'Lauf' : 'Läufe'}${v.unvollstaendig ? ', Verlauf kürzer' : ''})` : '–');

async function detailsFuellen(m, hintergrund = false) {
  $('details-titel').textContent = m.version ? `${m.name} (v${m.version})` : m.name;
  $('details-beschreibung').textContent = m.beschreibung;
  $('details-beschreibung').hidden = !m.beschreibung;
  $('details-zusammenfassung').textContent = `${STATUS_TEXT[m.anzeige] ?? m.anzeige}: ${textZuModul(m)}`;
  const l = m.letztes;
  $('details-fakten').replaceChildren(
    ...fakt('Betriebsart', m.betriebsart === 'eigenstaendig' ? `Eigenständig${m.intervallMinuten ? `, meldet sich etwa alle ${m.intervallMinuten} min` : ''}` : `Von der Basis gestartet${m.intervallMinuten ? `, alle ${m.intervallMinuten} min` : ', nur manuell'}`),
    ...fakt(m.betriebsart === 'eigenstaendig' ? 'Letzte Meldung' : 'Letzte Prüfung', l ? `${zeit(l.ende ?? l.beginn)}${Number.isFinite(l.dauerMs) ? ` · Dauer ${(l.dauerMs / 1000).toFixed(1)} s` : ''}` : 'noch keine'),
    ...fakt('Windows-Dienst', m.dienst ? `${m.dienst.name} – ${DIENST_TEXT[m.dienst.zustand] ?? m.dienst.zustand}` : null),
    ...fakt('Beendet', m.beendet ? `${zeit(m.beendet)}${m.beendetVon ? ` durch ${m.beendetVon}` : ''}` : null),
    ...fakt('Nächster Lauf', m.naechsterLauf && !['inaktiv', 'beendet'].includes(m.anzeige) ? `${zeit(m.naechsterLauf)} (${relativ(m.naechsterLauf)})` : null),
    ...fakt('Überfällig seit', m.ueberfaelligSeit ? zeit(m.ueberfaelligSeit) : null),
    ...fakt('Problem seit', m.problemSeit ? `${zeit(m.problemSeit)} · ${m.problemLaeufe} ${m.problemLaeufe === 1 ? 'Lauf' : 'Läufe'} ohne OK` : null),
    ...fakt('Verfügbarkeit 24 h', m.fehler ? null : prozent(m.verfuegbarkeit?.h24)),
    ...fakt('Verfügbarkeit 7 Tage', m.fehler ? null : prozent(m.verfuegbarkeit?.d7)),
  );
  leisteFuellen($('details-leiste'), m.verlaufKurz ?? []);
  $('details-admin').hidden = !istAdmin || Boolean(m.fehler);
  $('details-pause').textContent = m.aktiv ? 'Pausieren' : 'Fortsetzen';
  $('details-pause').onclick = () => gesperrt([$('details-pause')], aktionMeldung, async () => {
    await senden(`/api/module/${encodeURIComponent(m.id)}/aktiv`, { aktiv: !m.aktiv });
    aktualisieren();
  });
  // Beenden mit Rückfrage auf demselben Knopf (zweiter Klick innerhalb von 5 s).
  const beendenKnopf = $('details-beenden');
  if (beendenKnopf.dataset.modul !== m.id) { beendenKnopf.dataset.modul = m.id; beendenKnopf.dataset.bestaetigen = ''; }
  beendenKnopf.hidden = !m.kannBeenden;
  beendenKnopf.title = m.betriebsart === 'eigenstaendig' ? (m.dienst ? `Stoppt den Windows-Dienst ${m.dienst.name}` : 'Bittet das Modul über befehl.json, sich zu beenden') : 'Bricht die laufende Prüfung ab und pausiert das Modul';
  if (!beendenKnopf.dataset.bestaetigen) beendenKnopf.textContent = m.betriebsart === 'eigenstaendig' ? 'Beenden' : 'Prüfung abbrechen';
  beendenKnopf.onclick = () => {
    if (!beendenKnopf.dataset.bestaetigen) {
      beendenKnopf.dataset.bestaetigen = '1';
      beendenKnopf.textContent = 'Wirklich beenden?';
      setTimeout(() => { if (beendenKnopf.dataset.bestaetigen) { beendenKnopf.dataset.bestaetigen = ''; beendenKnopf.textContent = m.betriebsart === 'eigenstaendig' ? 'Beenden' : 'Prüfung abbrechen'; } }, 5000);
      return;
    }
    beendenKnopf.dataset.bestaetigen = '';
    modulAktion(m, 'beenden', beendenKnopf);
  };
  freigabeFuellen(m);
  $('md-upd').hidden = !istAdmin || !m.repo || Boolean(m.fehler);
  if (!$('md-upd').hidden) modulUpdateLaden(m.id, false, hintergrund);
  $('details-starten').hidden = !m.kannStarten;
  $('details-starten').onclick = () => modulAktion(m, 'starten', $('details-starten'));
  const messwerte = Object.entries(l?.messwerte ?? {});
  const hinweise = l?.details ?? [];
  $('details-messwerte').replaceChildren(...messwerte.flatMap(([name, wert]) => fakt(name, wert.toLocaleString('de-DE'))));
  $('details-liste').replaceChildren(...hinweise.map((d) => el('li', { textContent: d })));
  $('details-ausgabe').hidden = !l?.fehlerausgabe;
  $('details-ausgabe').textContent = l?.fehlerausgabe ?? '';
  $('md-werte').hidden = !messwerte.length && !hinweise.length && !l?.fehlerausgabe;
  bereichStatus('md-werte', [messwerte.length && `${messwerte.length} ${messwerte.length === 1 ? 'Kennzahl' : 'Kennzahlen'}`,
    hinweise.length && `${hinweise.length} ${hinweise.length === 1 ? 'Hinweis' : 'Hinweise'}`, l?.fehlerausgabe && 'Fehlerausgabe'].filter(Boolean).join(' · '));
  $('md-verlauf').hidden = Boolean(m.fehler);
  if (m.fehler) { $('details-verlauf').replaceChildren(); return; }
  const { verlauf } = await (await api(`/api/module/${encodeURIComponent(m.id)}/verlauf?anzahl=30`, hintergrund ? HINTERGRUND : {})).json();
  if (offenesModul !== m.id) return;
  const zaehlung = {};
  for (const e of verlauf) zaehlung[e.status] = (zaehlung[e.status] ?? 0) + 1;
  bereichStatus('md-verlauf', verlauf.length ? `${verlauf.length === 1 ? 'Letzter Lauf' : `Letzte ${verlauf.length} Läufe`}: ${Object.entries(zaehlung).map(([s, n]) => `${n} ${STATUS_TEXT[s] ?? s}`).join(', ')}` : 'Noch keine Läufe');
  $('details-verlauf').replaceChildren(...verlauf.map((e) => {
    const li = el('li', {}, el('span', { className: 'punkt' }), el('span', { textContent: `${zeit(e.ende ?? e.beginn)} – ${e.zusammenfassung}` }));
    li.dataset.status = e.status;
    return li;
  }));
}

// ---- Modul-Updates (nur Admins, nur Module mit „repo“) ----
const MUPD_PHASEN = { suche: 'Suche nach Updates …', herunterladen: 'Paket wird heruntergeladen …', pruefen: 'Prüfsumme wird kontrolliert …', entpacken: 'Paket wird entpackt …', beenden: 'Modul wird beendet …', austauschen: 'Neue Version wird eingesetzt …', starten: 'Modul wird gestartet …' };
let mupdTimer = null;
const mupdMeldung = (text, art = '') => { $('mupd-meldung').textContent = text; $('mupd-meldung').dataset.art = art; };

function modulUpdateZeigen(st) {
  const v = st.verfuegbar;
  $('mupd-fakten').replaceChildren(
    ...fakt('Installiert', st.installiert ? `v${st.installiert}` : '–'),
    ...fakt('Verfügbar', v ? `v${v.version}${v.veroeffentlicht ? ` (${new Date(v.veroeffentlicht).toLocaleDateString('de-DE')})` : ''}` : '–'),
    ...fakt('Zuletzt geprüft', st.letztePruefung ? relativ(st.letztePruefung) : 'noch nicht'),
    ...fakt('Vorherige Version', st.vorherige ? `v${st.vorherige}` : null),
  );
  const laeuft = Boolean(MUPD_PHASEN[st.phase]);
  if (laeuft) mupdMeldung(MUPD_PHASEN[st.phase]);
  else if (st.fehler) mupdMeldung(st.fehler, 'fehler');
  else if (st.hinweis) mupdMeldung(st.hinweis, 'ok');
  else if (!st.tokenGesetzt) mupdMeldung('Kein GitHub-Token: unter Einstellungen → Updates eintragen (Contents: Read-only, auch für das Modul-Repo).', 'fehler');
  else mupdMeldung(st.updateMoeglich ? `Version ${v.version} ist verfügbar.` : v ? 'Das Modul ist aktuell.' : '');
  $('mupd-notizen-rahmen').hidden = !(st.updateMoeglich && v?.notizen);
  $('mupd-notizen').textContent = v?.notizen ?? '';
  $('mupd-installieren').hidden = !st.updateMoeglich;
  $('mupd-installieren').textContent = st.updateMoeglich ? `Version ${v.version} installieren` : 'Installieren';
  $('mupd-installieren').onclick = () => modulUpdateAktion(st.id, 'installieren', { version: v.version });
  $('mupd-zurueck').hidden = !st.vorherige;
  $('mupd-zurueck').textContent = st.vorherige ? `Zurück zu v${st.vorherige}` : 'Zurück';
  $('mupd-zurueck').onclick = () => modulUpdateAktion(st.id, 'zurueck');
  $('mupd-suchen').onclick = () => modulUpdateAktion(st.id, 'suchen');
  for (const k of ['mupd-suchen', 'mupd-installieren', 'mupd-zurueck']) $(k).disabled = laeuft;
  bereichStatus('md-upd', laeuft ? MUPD_PHASEN[st.phase] : st.fehler ? 'Fehler beim letzten Vorgang' : !st.tokenGesetzt ? 'Kein GitHub-Token'
    : st.updateMoeglich ? `Update auf v${v.version} verfügbar` : `${st.installiert ? `v${st.installiert}` : ''}${v ? ' · aktuell' : ''}`,
  st.fehler || !st.tokenGesetzt ? 'fehler' : st.updateMoeglich ? 'warnung' : '');
  clearTimeout(mupdTimer);
  // Während eines Vorgangs jede Sekunde nachsehen; danach Kacheln auffrischen.
  if (laeuft) mupdTimer = setTimeout(() => modulUpdateLaden(st.id, true), 1000);
}

async function modulUpdateLaden(id, nachVorgang = false, hintergrund = nachVorgang) {
  if (offenesModul !== id) return;
  const antwort = await api(`/api/module/${encodeURIComponent(id)}/update`, hintergrund ? HINTERGRUND : {}).catch(() => null);
  if (!antwort?.ok || offenesModul !== id) return;
  const st = await antwort.json();
  modulUpdateZeigen(st);
  if (nachVorgang && !MUPD_PHASEN[st.phase]) aktualisieren();
}

async function modulUpdateAktion(id, aktion, koerper = {}) {
  for (const k of ['mupd-suchen', 'mupd-installieren', 'mupd-zurueck']) $(k).disabled = true;
  mupdMeldung(aktion === 'suchen' ? MUPD_PHASEN.suche : 'Wird gestartet …');
  let antwort;
  try { antwort = await senden(`/api/module/${encodeURIComponent(id)}/update/${aktion}`, koerper); }
  catch (fehler) {
    if (fehler.message !== 'abgemeldet') mupdMeldung(KEINE_VERBINDUNG, 'fehler');
    for (const k of ['mupd-suchen', 'mupd-installieren', 'mupd-zurueck']) $(k).disabled = false;
    return;
  }
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) {
    if (daten.status) modulUpdateZeigen(daten.status);
    mupdMeldung(daten.fehler || 'Nicht möglich.', 'fehler');
    for (const k of ['mupd-suchen', 'mupd-installieren', 'mupd-zurueck']) $(k).disabled = false;
    return;
  }
  modulUpdateZeigen(daten);
  if (aktion === 'suchen') aktualisieren();
}

// Konto der Basis in Einstellungen → System.
function kontoText(k) {
  const einrichten = 'auf dem Worker als Admin werkzeuge\\konto-einrichten.ps1 ausführen (README „Eigenes Dienstkonto“)';
  const text = k.system ? `Die Basis läuft als SYSTEM und hat damit alle Rechte auf dem Worker. Empfohlen ist ein eigenes Dienstkonto ohne Admin-Rechte: ${einrichten}.`
    : k.admin ? `Die Basis läuft unter ${k.name} mit Administratorrechten. Empfohlen ist ein Konto ohne Admin-Rechte: ${einrichten}.`
      : `Die Basis läuft unter ${k.name} – ohne Administratorrechte.`;
  return k.fehlt?.length ? `${text} Fehlende Schreibrechte: ${k.fehlt.join(', ')} – bitte ${einrichten}.` : text;
}

// Neues oder geändertes Modul: Admins sehen die Änderungen und geben frei; alle anderen nur den Hinweis.
function freigabeFuellen(m) {
  const f = m.freigabe;
  $('details-freigabe').hidden = !f;
  const knopf = $('freigabe-knopf');
  if (!f) { knopf.dataset.wert = ''; return; }
  const dienst = m.typ === 'eigenstaendig';
  $('freigabe-titel').textContent = f.neu ? 'Neues Modul – Freigabe nötig' : 'Geändertes Modul – Freigabe nötig';
  $('freigabe-text').textContent = f.fehler
    ? `${f.fehler} So kann das Modul nicht freigegeben werden; bitte den Modulordner korrigieren.`
    : !istAdmin ? 'Ein Admin muss die Änderungen prüfen und das Modul freigeben. Bis dahin wird es nicht ausgeführt.'
      : dienst ? `Nach der Freigabe kann die Basis den Windows-Dienst „${m.dienst?.name ?? ''}“ starten und beenden. Bitte nur freigeben, wenn die Änderung bekannt und gewollt ist.`
        : `Nach der Freigabe führt die Basis dieses Modul ${kontoName === 'SYSTEM' ? 'als SYSTEM' : kontoName ? `unter dem Konto ${kontoName}` : 'unter dem Konto der Basis'} aus. Bitte nur freigeben, wenn die Änderungen bekannt und gewollt sind.`;
  const liste = istAdmin ? f.aenderungen ?? [] : [];
  $('freigabe-liste').replaceChildren(...liste.map((t) => el('li', { textContent: t })));
  $('freigabe-liste').hidden = !liste.length;
  knopf.hidden = !istAdmin || !f.wert;
  // Ändert sich das Modul während der Rückfrage, beginnt die Rückfrage neu.
  if (knopf.dataset.modul !== m.id || knopf.dataset.wert !== (f.wert ?? '')) {
    if (knopf.dataset.sicher === '1') { knopf.dataset.sicher = ''; knopf.textContent = knopf.dataset.text; }
    knopf.dataset.modul = m.id;
    knopf.dataset.wert = f.wert ?? '';
  }
}

async function freigeben() {
  const knopf = $('freigabe-knopf');
  const { modul, wert } = knopf.dataset;
  if (!modul || !wert) return;
  aktionMeldung('Wird freigegeben …');
  await gesperrt([knopf], aktionMeldung, async () => {
    const antwort = await senden(`/api/module/${encodeURIComponent(modul)}/freigeben`, { wert });
    const daten = await antwort.json().catch(() => ({}));
    aktionMeldung(antwort.ok ? daten.text || 'Freigegeben.' : daten.fehler || 'Nicht möglich.', antwort.ok ? 'ok' : 'fehler');
  });
  aktualisieren();
}

const aktionMeldung = (text, art = '') => { $('details-aktion-meldung').textContent = text; $('details-aktion-meldung').dataset.art = art; };

async function modulAktion(m, aktion, knopf) {
  knopf.disabled = true;
  aktionMeldung(aktion === 'beenden' ? 'Wird beendet …' : 'Dienst wird gestartet …');
  try {
    const antwort = await api(`/api/module/${encodeURIComponent(m.id)}/${aktion}`, { method: 'POST', headers: { 'X-Monitor-Anfrage': '1' } });
    const daten = await antwort.json().catch(() => ({}));
    aktionMeldung(antwort.ok ? (aktion === 'beenden' ? 'Beendet.' : 'Dienst gestartet.') : (daten.fehler || 'Nicht möglich.'), antwort.ok ? 'ok' : 'fehler');
  } catch (fehler) {
    if (fehler.message !== 'abgemeldet') aktionMeldung('Keine Verbindung zur Monitoring-Basis.', 'fehler');
  } finally {
    knopf.disabled = false;
    aktualisieren();
  }
}

function detailsOeffnen(id) {
  const m = letzteModule.find((x) => x.id === id);
  if (!m) return;
  offenesModul = id;
  aktionMeldung('');
  // Beim Öffnen sind nur die Kennzahlen aufgeklappt.
  for (const d of $('details').querySelectorAll('.bereich')) d.open = d.id === 'md-werte';
  detailsFuellen(m);
  empfaengerLaden(m);
  einstellungenLaden(m);
  if (!$('details').open) $('details').showModal();
}

// Zusätzliche Mail-Empfänger je Modul (nur Admins).
let empfAktiv = true;
const empfMeldung = (text, art = '') => { $('empf-meldung').textContent = text; $('empf-meldung').dataset.art = art; };
async function empfaengerLaden(m) {
  $('md-empf').hidden = !istAdmin || Boolean(m.fehler);
  if ($('md-empf').hidden) return;
  bereichStatus('md-empf', '');
  empfMeldung('');
  $('empf-wert').value = '';
  const antwort = await api(`/api/module/${encodeURIComponent(m.id)}/empfaenger`).catch(() => null);
  if (!antwort?.ok || offenesModul !== m.id) return;
  const d = await antwort.json();
  empfAktiv = d.aktiv;
  $('empf-wert').value = d.empfaenger.join(', ');
  $('empf-allgemein').textContent = d.allgemein.length ? `Immer: ${d.allgemein.join(', ')}` : 'Noch keine allgemeinen Empfänger eingerichtet.';
  if (!d.aktiv) empfMeldung('Die Benachrichtigung ist noch nicht eingerichtet oder ausgeschaltet (Einstellungen → Benachrichtigung).', 'warnung');
  empfStatus(d.empfaenger, d.aktiv);
}
function empfStatus(empfaenger, aktiv = true) {
  bereichStatus('md-empf', !aktiv ? 'Benachrichtigung ist aus' : empfaenger.length ? `${empfaenger.length} zusätzliche${empfaenger.length === 1 ? 'r' : ''} Empfänger` : 'Nur die allgemeinen Empfänger', aktiv ? '' : 'warnung');
}
$('empf-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const id = offenesModul;
  if (!id) return;
  empfMeldung('Wird gespeichert …');
  const ergebnis = await gesperrt([$('empf-speichern')], empfMeldung, async () => {
    const antwort = await senden(`/api/module/${encodeURIComponent(id)}/empfaenger`, { empfaenger: $('empf-wert').value });
    return { antwort, daten: await antwort.json().catch(() => ({})) };
  });
  if (!ergebnis) return;
  if (!ergebnis.antwort.ok) { empfMeldung(ergebnis.daten.fehler ?? 'Speichern nicht möglich.', 'fehler'); return; }
  $('empf-wert').value = ergebnis.daten.empfaenger.join(', ');
  empfStatus(ergebnis.daten.empfaenger, empfAktiv);
  empfMeldung(ergebnis.daten.empfaenger.length ? 'Gespeichert.' : 'Gespeichert – keine zusätzlichen Empfänger.', 'ok');
});

// ---- Moduleinstellungen (nur Admins) ----
let einstModul = null;
const einstMeldung = (text, art = '') => { $('einst-meldung').textContent = text; $('einst-meldung').dataset.art = art; };

// Ein Eingabeelement für ein Feld oder eine Listenspalte.
function eingabeBauen(f, wert, id) {
  let eingabe;
  if (f.typ === 'schalter') {
    eingabe = el('input', { type: 'checkbox', id, checked: wert === true });
  } else if (f.typ === 'auswahl') {
    eingabe = el('select', { id }, ...(f.pflicht ? [] : [new Option('–', '')]), ...f.optionen.map((o) => new Option(o.text, o.wert)));
    eingabe.value = wert ?? '';
  } else {
    eingabe = el('input', { id, type: { zahl: 'number', passwort: 'password', datum: 'date' }[f.typ] ?? 'text', autocomplete: f.typ === 'passwort' ? 'new-password' : 'off' });
    if (f.typ === 'zahl') { eingabe.step = f.ganzzahl ? '1' : 'any'; if (f.min !== null) eingabe.min = f.min; if (f.max !== null) eingabe.max = f.max; }
    if (f.typ === 'passwort') eingabe.placeholder = wert?.gesetzt ? 'gesetzt – leer lassen, um es zu behalten' : 'nicht gesetzt';
    else eingabe.value = wert ?? '';
  }
  eingabe.dataset.typ = f.typ;
  return eingabe;
}

// Listenfeld: Tabelle mit einer Zeile je Eintrag, Zeilen hinzufügen und entfernen.
function listeBauen(f, zeilen, id) {
  const koerper = el('tbody');
  const zeileBauen = (werte = {}) => {
    const tr = el('tr');
    for (const s of f.spalten) {
      const eingabe = eingabeBauen(s, werte[s.schluessel] ?? (Object.keys(werte).length ? null : s.standard), '');
      eingabe.dataset.spalte = s.schluessel;
      eingabe.setAttribute('aria-label', s.bezeichnung);
      tr.append(el('td', {}, eingabe));
    }
    const weg = el('button', { type: 'button', className: 'zweitrangig', textContent: '✕', title: 'Zeile entfernen' });
    weg.setAttribute('aria-label', 'Zeile entfernen');
    weg.addEventListener('click', () => { tr.remove(); knopf.disabled = koerper.rows.length >= f.maxZeilen; });
    tr.append(el('td', {}, weg));
    koerper.append(tr);
    knopf.disabled = koerper.rows.length >= f.maxZeilen;
  };
  const knopf = el('button', { type: 'button', className: 'zweitrangig', textContent: 'Zeile hinzufügen' });
  knopf.addEventListener('click', () => zeileBauen());
  for (const z of zeilen ?? []) zeileBauen(z);
  const kopf = el('thead', {}, el('tr', {}, ...f.spalten.map((s) => el('th', { textContent: s.bezeichnung + (s.pflicht ? ' *' : ''), title: s.beschreibung ?? '' })), el('th')));
  const tabelle = el('table', { className: 'liste-tabelle', id }, kopf, koerper);
  tabelle.dataset.schluessel = f.schluessel;
  tabelle.dataset.typ = 'liste';
  return el('div', { className: 'liste-rahmen' }, tabelle, knopf);
}

function listeLesen(tabelle) {
  return [...tabelle.tBodies[0].rows].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-spalte]')]
    .map((e) => [e.dataset.spalte, e.dataset.typ === 'schalter' ? e.checked : e.value])));
}

function feldBauen(f, wert) {
  const id = `einst-${f.schluessel}`;
  const eingabe = f.typ === 'liste' ? listeBauen(f, wert, id) : eingabeBauen(f, wert, id);
  if (f.typ !== 'liste') eingabe.dataset.schluessel = f.schluessel;
  const label = el('label', { htmlFor: id, textContent: f.bezeichnung + (f.pflicht ? ' *' : '') });
  // Bei Auswahlfeldern den Anzeigetext der Option nennen, nicht den gespeicherten Wert.
  const standardText = f.typ === 'auswahl' ? f.optionen?.find((o) => o.wert === f.standard)?.text ?? f.standard : f.standard;
  const standard = f.standard === undefined || f.typ === 'schalter' || f.typ === 'liste' ? '' : `Standard: ${standardText}`;
  const hilfe = el('small', { className: 'leise', textContent: [f.beschreibung, standard].filter(Boolean).join(' · ') });
  const fehler = el('small', { className: 'feldfehler', id: `${id}-fehler` });
  return el('div', { className: `feld ${f.typ}` }, label, eingabe, hilfe, fehler);
}

// Pflichtfelder ohne Wert (Passwort: nicht gesetzt, Liste: keine Zeile).
const pflichtLeer = (felder, werte) => felder.filter((f) => {
  const w = werte[f.schluessel];
  if (!f.pflicht) return false;
  if (f.typ === 'passwort') return !w?.gesetzt;
  if (f.typ === 'liste') return !w?.length;
  return w === undefined || w === null || w === '';
}).length;

function einstellungenZeigen(felder, werte) {
  $('einst-felder').replaceChildren(...felder.map((f) => feldBauen(f, werte[f.schluessel])));
  const leer = pflichtLeer(felder, werte);
  bereichStatus('md-einst', `${felder.length} ${felder.length === 1 ? 'Einstellung' : 'Einstellungen'}${leer ? ` · ${leer} ${leer === 1 ? 'Pflichtfeld' : 'Pflichtfelder'} leer` : ''}`, leer ? 'warnung' : '');
}

// Wird beim Öffnen der Details geladen (nicht beim automatischen Nachladen, damit Eingaben erhalten bleiben).
async function einstellungenLaden(m) {
  einstModul = m;
  $('md-einst').hidden = !istAdmin || !m.hatEinstellungen || Boolean(m.fehler);
  if ($('md-einst').hidden) return;
  bereichStatus('md-einst', 'Wird geladen …');
  einstMeldung('');
  $('einst-felder').replaceChildren();
  const antwort = await api(`/api/module/${encodeURIComponent(m.id)}/einstellungen`).catch(() => null);
  if (offenesModul !== m.id) return;
  if (!antwort?.ok) { bereichStatus('md-einst', 'Konnte nicht geladen werden', 'fehler'); einstMeldung('Einstellungen konnten nicht geladen werden.', 'fehler'); return; }
  const { felder, werte } = await antwort.json();
  einstellungenZeigen(felder, werte);
}

$('einst-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const werte = {};
  for (const e of $('einst-felder').querySelectorAll('[data-schluessel]')) {
    werte[e.dataset.schluessel] = e.dataset.typ === 'schalter' ? e.checked : e.dataset.typ === 'liste' ? listeLesen(e) : e.value;
  }
  for (const f of $('einst-felder').querySelectorAll('.feldfehler')) f.textContent = '';
  einstMeldung('Wird gespeichert …');
  const ergebnis = await gesperrt([$('einst-speichern')], einstMeldung, async () => {
    const antwort = await senden(`/api/module/${encodeURIComponent(einstModul.id)}/einstellungen`, { werte });
    return { antwort, daten: await antwort.json().catch(() => ({})) };
  });
  if (!ergebnis) return;
  const { antwort, daten } = ergebnis;
  if (!antwort.ok) {
    for (const [k, text] of Object.entries(daten.feldfehler ?? {})) { const f = $(`einst-${k}-fehler`); if (f) f.textContent = text; }
    einstMeldung(daten.feldfehler?._ ?? daten.fehler ?? 'Speichern nicht möglich.', 'fehler');
    return;
  }
  einstellungenZeigen(daten.felder, daten.werte);
  einstMeldung(daten.geaendert.length ? 'Gespeichert. Das Modul übernimmt die Änderung beim nächsten Lauf.' : 'Keine Änderungen.', 'ok');
});

// ---- Benachrichtigung (nur Admins) ----
const BEN_FELDER = ['tenant_id', 'client_id', 'client_secret', 'absender', 'empfaenger', 'melden_nach_laeufen', 'erinnerung_stunden', 'link', 'erlaubte_domains', 'bericht', 'bericht_wochentag', 'bericht_uhrzeit'];
const benMeldung = (text, art = '') => { $('ben-meldung').textContent = text; $('ben-meldung').dataset.art = art; };
const BEN_ART = { fehler: 'Fehler', warnung: 'Warnung', 'keine-meldung': 'Keine Meldung', 'wieder-ok': 'Wieder OK', erinnerung: 'Erinnerung', test: 'Testmail', sicherheit: 'Sicherheit', bericht: 'Statusbericht', code: 'Bestätigungscode' };

// Wochentag und Uhrzeit nur zeigen, wenn sie gebraucht werden.
function berichtFelder() {
  $('ben-bericht-tag').hidden = $('ben-bericht').value !== 'woechentlich';
  $('ben-bericht-zeit').hidden = $('ben-bericht').value === 'aus';
}
$('ben-bericht').addEventListener('change', berichtFelder);

function benZeigen(daten) {
  const w = daten.werte;
  $('ben-aktiv').checked = w.aktiv;
  for (const k of BEN_FELDER) {
    if (k === 'client_secret') { $('ben-client_secret').value = ''; $('ben-client_secret').placeholder = w.client_secret.gesetzt ? 'gesetzt' : 'nicht gesetzt'; continue; }
    $(`ben-${k}`).value = Array.isArray(w[k]) ? w[k].join(', ') : w[k] ?? '';
  }
  berichtFelder();
  const naechster = daten.bericht?.naechster;
  $('ben-bericht-naechster').textContent = naechster && w.aktiv ? `Nächster Bericht: ${new Date(naechster).toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : naechster ? 'Die Benachrichtigung ist aus – es wird kein Bericht gesendet.' : '';
  const letzte = daten.verlauf[0];
  bereichStatus('ber-ben', !w.aktiv ? 'Aus' : `Aktiv · ${w.empfaenger.length} Empfänger${daten.bericht?.text ? ` · Bericht ${daten.bericht.text}` : ''}${letzte ? ` · ${letzte.ok ? 'zuletzt gesendet' : 'letzte Mail nicht gesendet'} ${relativ(letzte.zeit)}` : ''}`,
    !w.aktiv ? 'warnung' : letzte && !letzte.ok ? 'fehler' : '');
  $('ben-leer').hidden = daten.verlauf.length > 0;
  $('ben-verlauf').replaceChildren(...daten.verlauf.map((e) => {
    const li = el('li', {}, el('span', { className: 'punkt' }), el('span', { textContent: `${zeit(e.zeit)} – ${e.betreff}${e.ok ? '' : ` – nicht gesendet: ${e.fehler}`}` }));
    li.dataset.status = !e.ok ? 'fehler' : ['wieder-ok', 'test', 'bericht', 'code'].includes(e.art) ? 'ok' : e.art === 'warnung' ? 'warnung' : 'fehler';
    li.title = BEN_ART[e.art] ?? e.art;
    return li;
  }));
}

function benFehlerZeigen(feldfehler = {}) {
  for (const k of ['aktiv', ...BEN_FELDER]) $(`ben-${k}-fehler`).textContent = feldfehler[k] ?? '';
}

async function benLaden() {
  benFehlerZeigen();
  const antwort = await api('/api/benachrichtigung');
  if (!antwort.ok) { benMeldung('Einstellungen konnten nicht geladen werden.', 'fehler'); bereichStatus('ber-ben', 'Konnte nicht geladen werden', 'fehler'); return; }
  benZeigen(await antwort.json());
  benMeldung('');
}
$('ben-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const werte = { aktiv: $('ben-aktiv').checked };
  for (const k of BEN_FELDER) werte[k] = $(`ben-${k}`).value;
  benFehlerZeigen();
  benMeldung('Wird gespeichert …');
  const ergebnis = await gesperrt([$('ben-speichern')], benMeldung, async () => {
    const antwort = await senden('/api/benachrichtigung', { werte });
    return { antwort, daten: await antwort.json().catch(() => ({})) };
  });
  if (!ergebnis) return;
  const { antwort, daten } = ergebnis;
  if (!antwort.ok) { benFehlerZeigen(daten.feldfehler); benMeldung(daten.fehler ?? 'Speichern nicht möglich.', 'fehler'); return; }
  benZeigen(daten);
  benMeldung(daten.geaendert.length ? 'Gespeichert.' : 'Keine Änderungen.', 'ok');
});
$('ben-bericht-senden').addEventListener('click', async () => {
  benMeldung('Statusbericht wird gesendet …');
  const daten = await gesperrt([$('ben-bericht-senden')], benMeldung, async () => (await senden('/api/benachrichtigung/bericht', {})).json().catch(() => ({})));
  if (!daten) return;
  if (daten.verlauf) benZeigen(daten);
  benMeldung(daten.ok ? 'Statusbericht gesendet. Bitte Posteingang prüfen.' : `Nicht gesendet: ${daten.fehler ?? 'unbekannter Fehler'}`, daten.ok ? 'ok' : 'fehler');
});
$('ben-test').addEventListener('click', async () => {
  benMeldung('Testmail wird gesendet …');
  const daten = await gesperrt([$('ben-test')], benMeldung, async () => (await senden('/api/benachrichtigung/test', {})).json().catch(() => ({})));
  if (!daten) return;
  if (daten.verlauf) benZeigen(daten);
  benMeldung(daten.ok ? 'Testmail gesendet. Bitte Posteingang prüfen.' : `Nicht gesendet: ${daten.fehler ?? 'unbekannter Fehler'}`, daten.ok ? 'ok' : 'fehler');
});

// ---- Benutzer (nur Admins) ----
const bvMeldung = (text, art = '') => { $('bv-meldung').textContent = text; $('bv-meldung').dataset.art = art; };
const uhrzeit = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

function bvZeigen(daten) {
  const ich = $('benutzer').textContent;
  $('bv-liste').replaceChildren(...daten.benutzer.map((b) => {
    const zelle = el('td', { className: 'aktionen-zelle' });
    const abo = daten.abos?.[b.name];
    const aboText = !abo ? '–' : `${abo.adresse ?? 'keine Adresse'}${abo.ruht ? ' (ruht: Domäne nicht erlaubt)' : ''} · ${abo.module} ${abo.module === 1 ? 'Modul' : 'Module'}${abo.bericht ? ` · Bericht ${abo.bericht}` : ''}`;
    if (abo) {
      const aboWeg = el('button', { type: 'button', className: 'zweitrangig', textContent: 'Benachrichtigungen löschen' });
      nachfragen(aboWeg, `Benachrichtigungen von ${b.name} löschen?`, () => bvAktion(`/api/benutzer/${b.name}/benachrichtigung-loeschen`, {}, [aboWeg], `Benachrichtigungen von ${b.name} gelöscht.`));
      zelle.append(aboWeg);
    }
    if (b.name !== ich) {
      const admin = el('button', { type: 'button', className: 'zweitrangig', textContent: b.admin ? 'Admin-Recht entziehen' : 'Zum Admin machen' });
      admin.addEventListener('click', () => bvAktion(`/api/benutzer/${b.name}/admin`, { admin: !b.admin }, [admin], b.admin ? `Admin-Recht von ${b.name} entzogen.` : `${b.name} ist jetzt Admin.`));
      const loeschen = el('button', { type: 'button', className: 'zweitrangig gefahr', textContent: 'Löschen' });
      // Zweimal klicken: erst nachfragen, dann löschen.
      loeschen.addEventListener('click', () => {
        if (loeschen.dataset.sicher !== '1') {
          loeschen.dataset.sicher = '1';
          loeschen.textContent = `${b.name} wirklich löschen?`;
          setTimeout(() => { loeschen.dataset.sicher = ''; loeschen.textContent = 'Löschen'; }, 5000);
          return;
        }
        bvAktion(`/api/benutzer/${b.name}/loeschen`, {}, [loeschen], `Benutzer ${b.name} gelöscht.`);
      });
      zelle.append(admin);
      if (b.zweiFaktor) {
        // Zweimal klicken wie beim Löschen; der Benutzer richtet die App beim nächsten Anmelden neu ein.
        const zf = el('button', { type: 'button', className: 'zweitrangig', textContent: '2FA zurücksetzen' });
        zf.addEventListener('click', () => {
          if (zf.dataset.sicher !== '1') {
            zf.dataset.sicher = '1';
            zf.textContent = `2FA von ${b.name} wirklich zurücksetzen?`;
            setTimeout(() => { zf.dataset.sicher = ''; zf.textContent = '2FA zurücksetzen'; }, 5000);
            return;
          }
          bvAktion(`/api/benutzer/${b.name}/zweifaktor-zuruecksetzen`, {}, [zf], `Zwei-Faktor-Anmeldung von ${b.name} zurückgesetzt. Beim nächsten Anmelden (im Firmennetz oder über VPN) wird sie neu eingerichtet.`);
        });
        zelle.append(zf);
      }
      zelle.append(loeschen);
    } else {
      zelle.append(el('span', { className: 'leise', textContent: 'eigenes Konto' }));
    }
    return el('tr', {}, el('td', { textContent: b.name }), el('td', { textContent: b.admin ? 'Admin' : 'Benutzer' }),
      el('td', { textContent: b.zweiFaktor ? 'eingerichtet' : 'beim nächsten Anmelden' }),
      el('td', { textContent: b.sitzungen ? `ja (${b.sitzungen} ${b.sitzungen === 1 ? 'Sitzung' : 'Sitzungen'})` : 'nein' }), el('td', { textContent: aboText }), zelle);
  }));
  const ohne = daten.benutzer.filter((b) => !b.zweiFaktor).length;
  bereichStatus('ber-bv', `${daten.benutzer.length} Benutzer · ${daten.sitzungen.length} ${daten.sitzungen.length === 1 ? 'Sitzung' : 'Sitzungen'}${ohne ? ` · ${ohne} ohne Zwei-Faktor` : ''}`, ohne ? 'warnung' : '');
  const auswahl = $('bv-setzen-name');
  const vorher = auswahl.value;
  auswahl.replaceChildren(...daten.benutzer.map((b) => new Option(b.name, b.name)));
  if (daten.benutzer.some((b) => b.name === vorher)) auswahl.value = vorher;
  $('bv-sitzungen-leer').hidden = daten.sitzungen.length > 0;
  $('bv-sitzungen').replaceChildren(...daten.sitzungen.map((s) => el('tr', {},
    el('td', { textContent: `${s.benutzer}${s.admin ? ' (Admin)' : ''}${s.eigene ? ' – diese Sitzung' : ''}` }),
    el('td', { textContent: s.adresse.replace(/^::ffff:/, '') }), el('td', { textContent: uhrzeit(s.seit) }),
    el('td', { textContent: relativ(s.zuletzt) }), el('td', { textContent: uhrzeit(s.bis) }))));
}

async function bvLaden() {
  const antwort = await api('/api/benutzer');
  if (!antwort.ok) { bvMeldung('Benutzer konnten nicht geladen werden.', 'fehler'); bereichStatus('ber-bv', 'Konnte nicht geladen werden', 'fehler'); return; }
  bvZeigen(await antwort.json());
}

// Führt eine Änderung aus, zeigt die neue Liste und eine Meldung; liefert true bei Erfolg.
async function bvAktion(weg, koerper, knoepfe, erfolg) {
  bvMeldung('Wird gespeichert …');
  const ergebnis = await gesperrt(knoepfe, bvMeldung, async () => {
    const antwort = await senden(weg, koerper);
    return { antwort, daten: await antwort.json().catch(() => ({})) };
  });
  if (!ergebnis) return false;
  const { antwort, daten } = ergebnis;
  if (daten.benutzer) bvZeigen(daten);
  if (!antwort.ok) { bvMeldung(daten.fehler ?? 'Nicht möglich.', 'fehler'); return false; }
  bvMeldung(erfolg, 'ok');
  return true;
}

async function bvOeffnen() {
  bvMeldung('');
  $('bv-anlegen').reset();
  $('bv-setzen').reset();
  await bvLaden();
}
$('bv-anlegen').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const name = $('bv-name').value.trim();
  if ($('bv-passwort').value !== $('bv-passwort2').value) { bvMeldung('Die Passwörter stimmen nicht überein.', 'fehler'); return; }
  if (await bvAktion('/api/benutzer', { name, passwort: $('bv-passwort').value, admin: $('bv-admin').checked }, [$('bv-anlegen-knopf')], `Benutzer ${name} angelegt.`)) $('bv-anlegen').reset();
});
$('bv-setzen').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const name = $('bv-setzen-name').value;
  if (!name) return;
  if ($('bv-setzen-passwort').value !== $('bv-setzen-passwort2').value) { bvMeldung('Die Passwörter stimmen nicht überein.', 'fehler'); return; }
  if (await bvAktion(`/api/benutzer/${name}/passwort`, { passwort: $('bv-setzen-passwort').value }, [$('bv-setzen-knopf')], `Passwort von ${name} gesetzt.`)) {
    $('bv-setzen-passwort').value = '';
    $('bv-setzen-passwort2').value = '';
  }
});

// ---- Meine Benachrichtigungen (alle Benutzer) ----
const meineMeldung = (text, art = '') => { $('meine-meldung').textContent = text; $('meine-meldung').dataset.art = art; };
const MEINE_STUFEN = [['aus', 'nichts'], ['fehler', 'nur Fehler'], ['alle', 'Fehler und Warnungen']];
const MEINE_BERICHT = ['bericht', 'bericht_wochentag', 'bericht_uhrzeit'];
const kurzZeit = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function meineBerichtFelder() {
  $('meine-bericht-tag').hidden = $('meine-bericht').value !== 'woechentlich';
  $('meine-bericht-zeit').hidden = $('meine-bericht').value === 'aus';
}
$('meine-bericht').addEventListener('change', meineBerichtFelder);

// Adresse und Code-Eingabe; mitAbos = auch Module und Bericht neu füllen (nicht nach dem Code, damit Eingaben bleiben).
function meineZeigen(d, mitAbos = true) {
  $('meine-aus').hidden = d.verfuegbar;
  const text = $('meine-adresse-text');
  text.textContent = d.adresse
    ? `Mails gehen an ${d.adresse}.${d.adresseRuht ? ' Diese Domäne ist nicht mehr erlaubt – es kommen keine Mails, bis du eine erlaubte Adresse bestätigst.' : ''}`
    : 'Noch keine Adresse bestätigt – bis dahin bekommst du keine Mails.';
  text.dataset.art = !d.adresse || d.adresseRuht ? 'warnung' : '';
  $('meine-domaenen').textContent = d.erlaubteDomains.length ? `Erlaubt: ${d.erlaubteDomains.map((x) => `@${x}`).join(', ')}. Du bekommst einen Code per Mail.` : 'Ein Admin hat noch keine Domänen freigegeben.';
  $('meine-code-formular').hidden = !d.ausstehend;
  if (d.ausstehend) $('meine-code-hinweis').textContent = `Code an ${d.ausstehend.adresse} geschickt, gültig bis ${new Date(d.ausstehend.bis).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr.`;
  $('meine-bericht-senden').disabled = !d.adresse || d.adresseRuht || !d.verfuegbar;
  $('meine-loeschen').hidden = !d.adresse && !Object.keys(d.module).length;
  $('meine-bericht-naechster').textContent = d.naechsterBericht ? `Nächster Bericht: ${kurzZeit(d.naechsterBericht)}` : '';
  if (!mitAbos) return;
  $('meine-module-leer').hidden = letzteModule.length > 0;
  $('meine-module').replaceChildren(...[...letzteModule].sort((a, b) => a.name.localeCompare(b.name, 'de')).map((m) => {
    const auswahl = el('select', { id: `meine-modul-${m.id}` }, ...MEINE_STUFEN.map(([wert, t]) => new Option(t, wert)));
    auswahl.value = d.module[m.id] ?? 'aus';
    auswahl.dataset.modul = m.id;
    return el('tr', {}, el('td', {}, el('label', { htmlFor: auswahl.id, textContent: m.name })), el('td', {}, auswahl));
  }));
  $('meine-entwarnung').checked = d.entwarnung;
  for (const k of MEINE_BERICHT) { $(`meine-${k}`).value = d[k]; $(`meine-${k}-fehler`).textContent = ''; }
  meineBerichtFelder();
}

// Führt eine Anfrage aus; liefert { ok, daten } oder undefined bei Verbindungsfehler.
async function meineAnfrage(weg, koerper, knoepfe) {
  return gesperrt(knoepfe, meineMeldung, async () => {
    const antwort = await (koerper === undefined ? api(weg) : senden(weg, koerper));
    return { ok: antwort.ok, daten: await antwort.json().catch(() => ({})) };
  });
}

$('meine-oeffnen').addEventListener('click', async () => {
  meineMeldung('Wird geladen …');
  $('meine-adresse-formular').reset();
  $('meine-code-formular').reset();
  $('meine').showModal();
  const r = await meineAnfrage('/api/meine-benachrichtigungen', undefined, [$('meine-speichern')]);
  if (!r) return;
  if (!r.ok) { meineMeldung('Konnte nicht geladen werden.', 'fehler'); return; }
  meineZeigen(r.daten);
  meineMeldung('');
});
$('meine-schliessen').addEventListener('click', () => $('meine').close());
$('meine-adresse-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  meineMeldung('Code wird verschickt …');
  const r = await meineAnfrage('/api/meine-benachrichtigungen/code', { adresse: $('meine-adresse').value }, [$('meine-code-senden')]);
  if (!r) return;
  if (r.daten.adresse !== undefined) meineZeigen(r.daten, false);
  if (!r.ok) { meineMeldung(r.daten.fehler ?? 'Nicht möglich.', 'fehler'); return; }
  meineMeldung('Code verschickt. Bitte Posteingang prüfen und den Code unten eingeben.', 'ok');
  $('meine-code').focus();
});
$('meine-code-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const r = await meineAnfrage('/api/meine-benachrichtigungen/bestaetigen', { code: $('meine-code').value }, [$('meine-bestaetigen')]);
  if (!r) return;
  if (r.daten.adresse !== undefined) meineZeigen(r.daten, false);
  if (!r.ok) { meineMeldung(r.daten.fehler ?? 'Nicht möglich.', 'fehler'); return; }
  $('meine-adresse-formular').reset();
  $('meine-code-formular').reset();
  meineMeldung('Adresse bestätigt.', 'ok');
});
$('meine-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const module = Object.fromEntries([...$('meine-module').querySelectorAll('select')].map((a) => [a.dataset.modul, a.value]));
  const koerper = { module, entwarnung: $('meine-entwarnung').checked };
  for (const k of MEINE_BERICHT) { koerper[k] = $(`meine-${k}`).value; $(`meine-${k}-fehler`).textContent = ''; }
  meineMeldung('Wird gespeichert …');
  const r = await meineAnfrage('/api/meine-benachrichtigungen', koerper, [$('meine-speichern')]);
  if (!r) return;
  if (!r.ok) {
    for (const [k, t] of Object.entries(r.daten.feldfehler ?? {})) { const f = $(`meine-${k}-fehler`); if (f) f.textContent = t; }
    meineMeldung(r.daten.fehler ?? 'Speichern nicht möglich.', 'fehler');
    return;
  }
  meineZeigen(r.daten);
  meineMeldung(r.daten.adresse ? 'Gespeichert.' : 'Gespeichert. Mails kommen erst, wenn deine Adresse bestätigt ist.', 'ok');
});
$('meine-bericht-senden').addEventListener('click', async () => {
  meineMeldung('Bericht wird gesendet …');
  const r = await meineAnfrage('/api/meine-benachrichtigungen/bericht', {}, [$('meine-bericht-senden')]);
  if (!r) return;
  meineMeldung(r.ok ? 'Bericht gesendet. Bitte Posteingang prüfen.' : r.daten.fehler ?? 'Nicht gesendet.', r.ok ? 'ok' : 'fehler');
});
nachfragen($('meine-loeschen'), 'Wirklich alles abbestellen?', async () => {
  const r = await meineAnfrage('/api/meine-benachrichtigungen/loeschen', {}, [$('meine-loeschen')]);
  if (!r) return;
  if (!r.ok) { meineMeldung(r.daten.fehler ?? 'Nicht möglich.', 'fehler'); return; }
  meineZeigen(r.daten);
  meineMeldung('Alle Benachrichtigungen abbestellt und Adresse entfernt.', 'ok');
});

// ---- Eigenes Passwort (alle Benutzer) ----
const pwMeldung = (text, art = '') => { $('pw-meldung').textContent = text; $('pw-meldung').dataset.art = art; };
$('passwort-oeffnen').addEventListener('click', () => { $('pw-formular').reset(); pwMeldung(''); $('passwort').showModal(); });
$('pw-schliessen').addEventListener('click', () => $('passwort').close());
$('pw-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  if ($('pw-neu').value !== $('pw-neu2').value) { pwMeldung('Die neuen Passwörter stimmen nicht überein.', 'fehler'); return; }
  pwMeldung('Wird gespeichert …');
  const ergebnis = await gesperrt([$('pw-speichern')], pwMeldung, async () => {
    const antwort = await senden('/api/passwort', { alt: $('pw-alt').value, neu: $('pw-neu').value });
    return { antwort, daten: await antwort.json().catch(() => ({})) };
  });
  if (!ergebnis) return;
  if (!ergebnis.antwort.ok) { pwMeldung(ergebnis.daten.fehler ?? 'Nicht möglich.', 'fehler'); return; }
  $('pw-formular').reset();
  pwMeldung('Passwort geändert.', 'ok');
});

// ---- Updates (nur Admins) ----
const PHASEN = { suche: 'Suche nach Updates …', herunterladen: 'Paket wird heruntergeladen …', pruefen: 'Prüfsumme wird kontrolliert …', entpacken: 'Paket wird entpackt …', selbsttest: 'Neue Version wird getestet …', neustart: 'Die Basis startet neu …' };
let updateStatus = null;

function updateMeldung(text, art = '') {
  $('upd-meldung').textContent = text;
  $('upd-meldung').dataset.art = art;
}

function updateZeigen(st) {
  updateStatus = st;
  $('upd-installiert').textContent = st.installiert ? `v${st.installiert}` : '–';
  $('upd-verfuegbar').textContent = st.verfuegbar ? `v${st.verfuegbar.version}${st.verfuegbar.veroeffentlicht ? ` (${zeit(st.verfuegbar.veroeffentlicht)})` : ''}` : '–';
  $('upd-geprueft').textContent = st.letztePruefung ? zeit(st.letztePruefung) : 'noch nicht';
  $('upd-notizen').hidden = !(st.updateMoeglich && st.verfuegbar?.notizen);
  $('upd-notizen').textContent = st.verfuegbar?.notizen ?? '';
  const beschaeftigt = Boolean(PHASEN[st.phase]);
  $('upd-suchen').disabled = beschaeftigt || !st.eingerichtet;
  $('upd-installieren').hidden = !(st.updateMoeglich && st.viaStarter) || beschaeftigt;
  $('upd-installieren').textContent = st.verfuegbar ? `Auf v${st.verfuegbar.version} updaten` : 'Updaten';
  $('upd-zurueck').hidden = !(st.vorherige && st.viaStarter) || beschaeftigt;
  $('upd-zurueck').textContent = st.vorherige ? `Zurück auf v${st.vorherige.version}` : 'Vorherige Version wiederherstellen';
  tokenZeigen(st.token);
  bereichStatus('ber-upd', !st.eingerichtet ? 'Nicht eingerichtet (GitHub-Token fehlt)' : beschaeftigt ? PHASEN[st.phase] : st.phase === 'fehler' ? 'Fehler beim letzten Vorgang'
    : st.updateMoeglich ? `Update auf v${st.verfuegbar.version} verfügbar` : `v${st.installiert}${st.verfuegbar ? ' · aktuell' : ''}${st.token?.laeuftBaldAb ? ' · Token läuft bald ab' : ''}`,
  !st.eingerichtet || st.phase === 'fehler' ? 'fehler' : st.updateMoeglich || st.token?.laeuftBaldAb ? 'warnung' : '');
  if (!st.eingerichtet) updateMeldung('Updates sind noch nicht eingerichtet: Bitte unten einen GitHub-Token eintragen.', 'fehler');
  else if (beschaeftigt) updateMeldung(PHASEN[st.phase]);
  else if (st.phase === 'fehler') updateMeldung(st.fehler, 'fehler');
  else if (!st.viaStarter) updateMeldung('Die Basis läuft nicht über start.js. Updates können gesucht, aber nicht installiert werden.', 'fehler');
  else if (st.verfuegbar && !st.updateMoeglich) updateMeldung('Die Basis ist auf dem neuesten Stand.', 'ok');
  else if (st.updateMoeglich) updateMeldung(`Version ${st.verfuegbar.version} ist verfügbar.`);
  else updateMeldung('');
}

const tokMeldung = (text, art = '') => { $('tok-meldung').textContent = text; $('tok-meldung').dataset.art = art; };
function tokenZeigen(t) {
  if (!t) return;
  const teile = [];
  if (!t.gesetzt) teile.push('Kein Token eingetragen.');
  else {
    teile.push(t.quelle === 'oberflaeche' ? 'Token gesetzt (hier eingetragen).' : 'Token gesetzt (aus config.json).');
    if (t.ablauf) teile.push(t.restTage < 0 ? `Abgelaufen am ${zeit(t.ablauf)}.` : `Gültig bis ${new Date(t.ablauf).toLocaleDateString('de-DE')} (noch ${t.restTage} ${t.restTage === 1 ? 'Tag' : 'Tage'}).`);
    if (t.geprueft) teile.push(t.ok ? `Zuletzt erfolgreich geprüft ${relativ(t.geprueft)}.` : `Prüfung fehlgeschlagen: ${t.fehler}`);
  }
  $('tok-status').textContent = teile.join(' ');
  $('tok-status').dataset.art = t.laeuftBaldAb || t.ok === false ? 'fehler' : '';
  $('tok-pruefen').hidden = !t.gesetzt;
  $('tok-entfernen').hidden = t.quelle !== 'oberflaeche';
}

// Liefert { ok, daten } oder null, wenn keine Verbindung bestand (Meldung ist dann schon angezeigt).
async function tokenAktion(weg, koerper, laeuft) {
  tokMeldung(laeuft);
  const ergebnis = await gesperrt(['tok-speichern', 'tok-pruefen', 'tok-entfernen'].map((k) => $(k)), tokMeldung, async () => {
    const antwort = await senden(weg, koerper ?? {});
    return { ok: antwort.ok, daten: await antwort.json().catch(() => ({})) };
  });
  if (!ergebnis) return null;
  const st = ergebnis.daten.status ?? ergebnis.daten;
  if (st.token) updateZeigen(st);
  return ergebnis;
}
$('tok-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  const ergebnis = await tokenAktion('/api/updates/token', { token: $('tok-wert').value.trim() }, 'Token wird bei GitHub geprüft …');
  if (!ergebnis) return;
  const { ok, daten } = ergebnis;
  if (ok) $('tok-wert').value = '';
  tokMeldung(ok ? 'Token gespeichert. Jetzt kann nach Updates gesucht werden.' : daten.fehler ?? 'Speichern nicht möglich.', ok ? 'ok' : 'fehler');
});
$('tok-pruefen').addEventListener('click', async () => {
  const ergebnis = await tokenAktion('/api/updates/token/pruefen', {}, 'Token wird geprüft …');
  if (!ergebnis) return;
  const { daten } = ergebnis;
  tokMeldung(daten.token?.ok ? 'Der Token funktioniert.' : `Der Token funktioniert nicht: ${daten.token?.fehler ?? 'unbekannt'}`, daten.token?.ok ? 'ok' : 'fehler');
});
$('tok-entfernen').addEventListener('click', async () => {
  const ergebnis = await tokenAktion('/api/updates/token', { entfernen: true }, 'Wird entfernt …');
  if (!ergebnis) return;
  const { ok } = ergebnis;
  tokMeldung(ok ? 'Token entfernt.' : 'Entfernen nicht möglich.', ok ? 'ok' : 'fehler');
});

async function updateAktion(weg, koerper) {
  let antwort;
  try { antwort = await api(`/api/updates/${weg}`, { method: 'POST', headers: { 'X-Monitor-Anfrage': '1', 'Content-Type': 'application/json' }, body: koerper ? JSON.stringify(koerper) : undefined }); }
  catch (fehler) {
    if (fehler.message !== 'abgemeldet') updateMeldung(KEINE_VERBINDUNG, 'fehler');
    if (updateStatus) updateZeigen(updateStatus); // Schaltflächen wieder wie vorher
    else $('upd-suchen').disabled = false;
    return null;
  }
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) { if (daten.status) updateZeigen(daten.status); updateMeldung(daten.fehler || 'Aktion nicht möglich.', 'fehler'); return null; }
  updateZeigen(daten);
  return daten;
}

// Wartet auf den Neustart. Nach dem Neustart ist die alte Sitzung ungültig (401) – dann neu anmelden.
async function aufNeustartWarten(zeige = updateMeldung) {
  zeige(PHASEN.neustart);
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const antwort = await fetch('/api/status', { credentials: 'same-origin' });
      if (antwort.status === 401) { location.href = '/login?fehler=update'; return; }
      if (antwort.ok && zeige === updateMeldung) {
        const st = await (await fetch('/api/updates', { credentials: 'same-origin' })).json();
        if (st.phase !== 'neustart') { updateZeigen(st); return; }
      }
    } catch { /* Server startet gerade neu */ }
  }
  zeige('Die Basis meldet sich nicht zurück. Bitte logs\\basis.log auf dem Worker prüfen.', 'fehler');
}

async function updatesOeffnen() {
  $('upd-bestaetigen').hidden = true;
  tokMeldung('');
  $('tok-wert').value = '';
  const antwort = await api('/api/updates');
  if (antwort.ok) updateZeigen(await antwort.json());
}

$('upd-suchen').addEventListener('click', async () => { updateMeldung(PHASEN.suche); $('upd-suchen').disabled = true; await updateAktion('suchen'); });
$('upd-installieren').addEventListener('click', () => {
  $('upd-bestaetigen-version').textContent = `v${updateStatus.verfuegbar.version}`;
  $('upd-bestaetigen').hidden = false;
  $('upd-installieren').hidden = true;
});
$('upd-nein').addEventListener('click', () => { $('upd-bestaetigen').hidden = true; updateZeigen(updateStatus); });
$('upd-ja').addEventListener('click', async () => {
  $('upd-bestaetigen').hidden = true;
  $('upd-installieren').hidden = true;
  updateMeldung(PHASEN.herunterladen);
  const ergebnis = await updateAktion('installieren', { version: updateStatus.verfuegbar.version });
  if (!ergebnis) return;
  // Fortschritt anzeigen, bis die Basis neu startet.
  while (true) {
    await new Promise((r) => setTimeout(r, 1000));
    let st;
    try { st = await (await fetch('/api/updates', { credentials: 'same-origin' })).json(); } catch { break; }
    updateZeigen(st);
    if (st.phase === 'neustart' || !PHASEN[st.phase]) break;
  }
  if (updateStatus.phase === 'neustart' || updateStatus.phase === 'herunterladen') await aufNeustartWarten();
});
$('upd-zurueck').addEventListener('click', async () => {
  if (await updateAktion('zurueck')) await aufNeustartWarten();
});

// ---- Fehlerprotokoll (nur Admins) ----
async function protokollLaden() {
  const parameter = new URLSearchParams();
  if ($('prot-stufe').value) parameter.set('stufe', $('prot-stufe').value);
  if ($('prot-quelle').value) parameter.set('quelle', $('prot-quelle').value);
  $('prot-download').href = `/api/protokoll/download?${parameter}`;
  const antwort = await api(`/api/protokoll?${parameter}`);
  if (!antwort.ok) return;
  const { eintraege, quellen } = await antwort.json();
  const gewaehlt = $('prot-quelle').value;
  $('prot-quelle').replaceChildren(new Option('Alle', ''), ...quellen.map((q) => new Option(q, q)));
  $('prot-quelle').value = quellen.includes(gewaehlt) ? gewaehlt : '';
  // Statuszeile nur ohne Filter: Fehler und Warnungen der letzten 24 Stunden.
  if (!parameter.toString()) {
    const tag = eintraege.filter((e) => Date.now() - Date.parse(e.zeit) < 86_400_000);
    const fehler = tag.filter((e) => e.stufe === 'fehler').length;
    bereichStatus('ber-prot', tag.length ? `24 h: ${fehler} Fehler, ${tag.length - fehler} ${tag.length - fehler === 1 ? 'Warnung' : 'Warnungen'} · letzter Eintrag ${relativ(tag[0].zeit)}` : 'Keine Einträge in den letzten 24 Stunden', fehler ? 'fehler' : tag.length ? 'warnung' : 'ok');
  }
  $('prot-leer').hidden = eintraege.length > 0;
  $('prot-liste').replaceChildren(...eintraege.map((e) => {
    const li = document.createElement('li');
    li.dataset.stufe = e.stufe;
    const kopf = document.createElement('div'); kopf.className = 'kopfzeile';
    const zeitEl = document.createElement('span'); zeitEl.className = 'leise'; zeitEl.textContent = zeit(e.zeit);
    const stufeEl = document.createElement('span'); stufeEl.className = 'status'; stufeEl.dataset.status = e.stufe; stufeEl.textContent = e.stufe === 'fehler' ? 'Fehler' : 'Warnung';
    const quelleEl = document.createElement('span'); quelleEl.className = 'quelle'; quelleEl.textContent = e.quelle;
    kopf.append(zeitEl, stufeEl, quelleEl);
    const meldung = document.createElement('div'); meldung.className = 'prot-meldung'; meldung.textContent = e.meldung;
    li.append(kopf, meldung);
    if (e.details) {
      const d = document.createElement('details');
      const s = document.createElement('summary'); s.textContent = 'Details';
      const pre = document.createElement('pre'); pre.textContent = e.details;
      d.append(s, pre); li.append(d);
    }
    return li;
  }));
}
$('prot-aktualisieren').addEventListener('click', protokollLaden);
$('prot-stufe').addEventListener('change', protokollLaden);
$('prot-quelle').addEventListener('change', protokollLaden);

// ---- HTTPS & Domain (nur Admins) ----
const TLS_MODUS = { aus: 'HTTP im internen Netz (unverschlüsselt)', letsencrypt: 'HTTPS mit Zertifikat von Let’s Encrypt', dateien: 'HTTPS mit eigenem Zertifikat (Dateien)' };
const HTTP_PORT = 8080;
const TLS_FELDER = ['hostname', 'email', 'dns_anbieter', 'token'];
const tlsMeldung = (text, art = '') => { $('tls-meldung').textContent = text; $('tls-meldung').dataset.art = art; };
const tlsVorgang = (text, art = '') => { $('tls-vorgang').textContent = text; $('tls-vorgang').dataset.art = art; };
const umschaltMeldung = (text, art = '') => { $('tls-umschalten-meldung').textContent = text; $('tls-umschalten-meldung').dataset.art = art; };
const datum = (iso) => new Date(iso).toLocaleDateString('de-DE');
let tlsTimer = null;

const zertifikatText = (z) => (z ? `${z.domain} – ${z.gueltig ? `gültig bis ${datum(z.gueltigBis)}` : `abgelaufen am ${datum(z.gueltigBis)}`}` : 'noch keines');

function tlsFehlerZeigen(feldfehler = {}) {
  for (const k of TLS_FELDER) $(`tls-${k}-fehler`).textContent = feldfehler[k] ?? '';
}

function tlsZeigen(st, formular = false) {
  const v = st.vorgang;
  const art = v?.art === 'test' ? 'Testzertifikat' : 'Zertifikat';
  const https = st.modus === 'letsencrypt';
  $('tls-fakten').replaceChildren(
    ...fakt('Betrieb', `${TLS_MODUS[st.modus] ?? st.modus} · Port ${st.port}`),
    ...fakt('Zertifikat', zertifikatText(st.zertifikat)),
    ...fakt('Testzertifikat', st.testzertifikat ? zertifikatText(st.testzertifikat) : null),
    ...fakt(https ? 'Adresse' : 'Adresse mit HTTPS', st.adresse),
  );
  if (formular) {
    $('tls-hostname').value = st.hostname;
    $('tls-email').value = st.email;
    $('tls-dns_anbieter').value = st.dnsAnbieter;
    $('tls-token').value = '';
    $('tls-token').placeholder = st.tokenGesetzt ? 'gesetzt – leer lassen, um ihn zu behalten' : 'nicht gesetzt';
  }
  const p = st.pruefung;
  $('tls-pruefung').hidden = !p;
  if (p) {
    $('tls-pruefung').replaceChildren(...[p.zone, p.aufloesung].map((e) => { const li = el('li', { textContent: e.text }); li.dataset.ok = e.ok ? 'ja' : 'nein'; return li; }),
      el('li', { className: 'leise', textContent: `Geprüft ${relativ(p.zeit)}` }));
  }
  const bereit = Boolean(st.hostname && st.email && st.tokenGesetzt);
  if (v?.laeuft) tlsVorgang(v.schritt ?? `${art} wird angefragt …`);
  else if (v?.ok) tlsVorgang(`${art} erhalten (${relativ(v.ende)}).${v.art === 'test' ? ' Die Einrichtung funktioniert – jetzt das echte Zertifikat anfragen.' : https ? ' Es ist sofort aktiv.' : ''}`, 'ok');
  else if (v?.ok === false) tlsVorgang(`${art} nicht erhalten: ${v.fehler}`, 'fehler');
  else tlsVorgang(bereit ? '' : 'Zuerst Domain, E-Mail und Token speichern.');
  $('tls-pruefen').disabled = !bereit;
  $('tls-test').disabled = !bereit || Boolean(v?.laeuft);
  $('tls-echt').disabled = !bereit || Boolean(v?.laeuft);
  $('tls-echt').textContent = https ? 'Zertifikat erneuern' : 'Zertifikat anfragen';
  const aktiv = st.umschaltenGrund === 'HTTPS ist bereits aktiv.';
  $('tls-umschalten').hidden = aktiv;
  $('tls-umschalten').disabled = !st.umschaltenMoeglich;
  $('tls-http').hidden = st.modus === 'aus';
  const warnung = st.umschaltenMoeglich && p && !p.aufloesung.ok ? ` Achtung: Laut letzter Prüfung zeigt ${st.hostname} nicht auf diesen Rechner – dann ist die Oberfläche bis zum DNS-Eintrag nur über https://<IP-Adresse>:${st.httpsPort}/ mit Zertifikatswarnung erreichbar.` : '';
  $('tls-umschalten-text').textContent = aktiv ? `HTTPS ist aktiv: ${st.adresse} Das Zertifikat wird automatisch vor Ablauf erneuert.`
    : st.umschaltenMoeglich ? `Danach ist die Oberfläche nur noch unter ${st.adresse} erreichbar (nicht mehr per HTTP). Die Basis startet dafür neu; alle müssen sich neu anmelden.${st.neustartMoeglich ? '' : ' Die Basis läuft nicht über Start.exe – nach dem Umschalten bitte von Hand neu starten.'}${warnung}`
      : st.umschaltenGrund;
  const restTage = st.zertifikat ? Math.floor((Date.parse(st.zertifikat.gueltigBis) - Date.now()) / 86_400_000) : null;
  bereichStatus('ber-tls', v?.laeuft ? `${art} wird angefragt …`
    : https ? `HTTPS aktiv · ${st.hostname}${st.zertifikat ? ` · Zertifikat bis ${datum(st.zertifikat.gueltigBis)}` : ''}`
      : st.modus === 'dateien' ? `HTTPS mit eigenem Zertifikat · Port ${st.port}`
        : st.umschaltenMoeglich ? `HTTP intern · Zertifikat für ${st.hostname} liegt bereit`
          : st.hostname ? `HTTP intern · ${st.hostname} eingetragen` : 'HTTP intern · nicht eingerichtet',
  v?.ok === false ? 'fehler' : https && restTage !== null && restTage < 14 ? 'warnung' : https ? 'ok' : '');
  // Während einer Anfrage alle 3 s nachsehen (zählt nicht als Aktivität).
  clearTimeout(tlsTimer);
  if (v?.laeuft && $('einstellungen').open) tlsTimer = setTimeout(() => tlsLaden(false, true).catch(() => {}), 3000);
}

async function tlsLaden(formular = true, hintergrund = false) {
  if (formular) { tlsMeldung(''); tlsFehlerZeigen(); umschaltMeldung(''); }
  const antwort = await api('/api/tls', hintergrund ? HINTERGRUND : {});
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) { bereichStatus('ber-tls', daten.fehler ?? 'Konnte nicht geladen werden', 'fehler'); return; }
  tlsZeigen(daten, formular);
}

// Sendet eine Aktion; liefert { ok, daten } oder undefined ohne Verbindung (Meldung steht dann schon da).
const tlsSenden = (weg, koerper, knoepfe, melden) => gesperrt(knoepfe, melden, async () => {
  const antwort = await senden(`/api/tls/${weg}`, koerper);
  return { ok: antwort.ok, daten: await antwort.json().catch(() => ({})) };
});

$('tls-formular').addEventListener('submit', async (ereignis) => {
  ereignis.preventDefault();
  tlsFehlerZeigen();
  tlsMeldung('Wird gespeichert …');
  const ergebnis = await tlsSenden('einstellungen', { hostname: $('tls-hostname').value, email: $('tls-email').value, dns_anbieter: $('tls-dns_anbieter').value, token: $('tls-token').value }, [$('tls-speichern')], tlsMeldung);
  if (!ergebnis) return;
  const { ok, daten } = ergebnis;
  if (!ok) { tlsFehlerZeigen(daten.feldfehler); tlsMeldung(daten.fehler ?? 'Bitte die markierten Felder prüfen.', 'fehler'); return; }
  tlsZeigen(daten.status, true);
  tlsMeldung(daten.geaendert ? 'Gespeichert.' : 'Keine Änderungen.', 'ok');
});

$('tls-pruefen').addEventListener('click', async () => {
  $('tls-pruefung').hidden = false;
  $('tls-pruefung').replaceChildren(el('li', { className: 'leise', textContent: 'Wird geprüft …' }));
  const melden = (text) => {
    const li = el('li', { textContent: text });
    li.dataset.ok = 'nein';
    $('tls-pruefung').replaceChildren(li);
    $('tls-pruefung').hidden = false;
  };
  const ergebnis = await tlsSenden('pruefen', {}, [$('tls-pruefen')], melden);
  if (!ergebnis) return;
  const { ok, daten } = ergebnis;
  if (!ok) { if (daten.status) tlsZeigen(daten.status); melden(daten.fehler ?? 'Prüfung nicht möglich.'); return; }
  tlsZeigen(daten.status);
});

async function tlsAnfragen(test) {
  tlsVorgang('Wird gestartet …');
  const ergebnis = await tlsSenden('anfragen', { test }, [$('tls-test'), $('tls-echt')], tlsVorgang);
  if (!ergebnis) return;
  const { ok, daten } = ergebnis;
  if (!ok) { if (daten.status) tlsZeigen(daten.status); tlsVorgang(daten.fehler ?? 'Anfrage nicht möglich.', 'fehler'); return; }
  tlsZeigen(daten);
}
$('tls-test').addEventListener('click', () => tlsAnfragen(true));
$('tls-echt').addEventListener('click', () => tlsAnfragen(false));

// Umschalten mit Neustart: danach ist die Oberfläche unter einer anderen Adresse erreichbar.
async function tlsUmschalten(weg) {
  umschaltMeldung('Wird umgestellt …');
  const ergebnis = await tlsSenden(weg, {}, [$('tls-umschalten'), $('tls-http')], umschaltMeldung);
  if (!ergebnis) return;
  const { ok, daten } = ergebnis;
  if (!ok) { if (daten.status) tlsZeigen(daten.status); umschaltMeldung(daten.fehler ?? 'Nicht möglich.', 'fehler'); return; }
  const ziel = weg === 'http' ? `http://${location.hostname}:${HTTP_PORT}/` : daten.adresse;
  if (!daten.neustart) { umschaltMeldung(`${daten.hinweis} Danach: ${ziel}`, 'warnung'); return; }
  clearInterval(aktualisierer);
  $('tls-umschalten').disabled = true;
  $('tls-http').disabled = true;
  umschaltMeldung(`Die Basis startet neu. In wenigen Sekunden geht es weiter zu ${ziel} – dort neu anmelden.`, 'ok');
  setTimeout(() => { location.href = ziel; }, 12_000);
}
nachfragen($('tls-umschalten'), 'Wirklich umschalten? Die Basis startet neu.', () => tlsUmschalten('umschalten'));
nachfragen($('tls-http'), 'Wirklich zurück auf HTTP? Die Basis startet neu.', () => tlsUmschalten('http'));

// ---- Neustart (nur Admins) ----
const neustartMeldung = (text, art = '') => { $('neustart-meldung').textContent = text; $('neustart-meldung').dataset.art = art; };
nachfragen($('freigabe-knopf'), 'Wirklich freigeben?', freigeben);
nachfragen($('neustart-ja'), 'Wirklich neu starten?', async () => {
  $('neustart-ja').disabled = true;
  let antwort;
  try { antwort = await api('/api/neustart', { method: 'POST', headers: { 'X-Monitor-Anfrage': '1' } }); }
  catch (fehler) {
    if (fehler.message !== 'abgemeldet') neustartMeldung(KEINE_VERBINDUNG, 'fehler');
    $('neustart-ja').disabled = false;
    return;
  }
  if (!antwort.ok) {
    const { fehler } = await antwort.json().catch(() => ({}));
    neustartMeldung(fehler || 'Neustart nicht möglich.', 'fehler');
    $('neustart-ja').disabled = false;
    return;
  }
  await aufNeustartWarten(neustartMeldung);
});

// ---- Basis beenden (nur Admins) ----
const beendenMeldung = (text, art = '') => { $('beenden-meldung').textContent = text; $('beenden-meldung').dataset.art = art; };
nachfragen($('beenden-ja'), 'Wirklich beenden?', async () => {
  $('beenden-ja').disabled = true;
  const mitModulen = $('beenden-module').checked;
  let antwort;
  try { antwort = await senden('/api/beenden', { module: mitModulen }); }
  catch (fehler) { if (fehler.message !== 'abgemeldet') beendenMeldung('Keine Verbindung zur Monitoring-Basis.', 'fehler'); $('beenden-ja').disabled = false; return; }
  if (!antwort.ok) {
    const { fehler } = await antwort.json().catch(() => ({}));
    beendenMeldung(fehler || 'Beenden nicht möglich.', 'fehler');
    $('beenden-ja').disabled = false;
    return;
  }
  clearInterval(aktualisierer);
  $('einstellungen').close();
  $('details').close();
  for (const id of ['einstellungen-oeffnen', 'meine-oeffnen', 'passwort-oeffnen', 'admin-hinweis']) $(id).hidden = true;
  for (const teil of document.querySelectorAll('main > :not(#beendet-seite)')) teil.hidden = true;
  $('beendet-text').textContent = mitModulen ? 'Die eigenständigen Module wurden ebenfalls beendet (soweit sie das unterstützen).' : 'Eigenständige Module laufen weiter.';
  $('beendet-seite').hidden = false;
  document.title = 'Monitoring – beendet';
});

// ---- Einstellungen: ein Dialog, jeder Bereich einzeln aufklappbar (immer nur einer offen) ----
function sysOeffnen() {
  neustartMeldung('');
  beendenMeldung('');
  $('beenden-module').checked = false;
  $('neustart-ja').disabled = false;
  $('beenden-ja').disabled = false;
  return Promise.resolve();
}
const BEREICHE = { 'ber-tls': () => tlsLaden(), 'ber-ben': benLaden, 'ber-bv': bvOeffnen, 'ber-upd': updatesOeffnen, 'ber-prot': protokollLaden, 'ber-sys': sysOeffnen };
const bereichLaden = (id) => BEREICHE[id]().catch((fehler) => { if (fehler.message !== 'abgemeldet') bereichStatus(id, KEINE_VERBINDUNG, 'fehler'); });

for (const d of document.querySelectorAll('details.bereich')) {
  d.addEventListener('toggle', () => {
    if (!d.open) return;
    // Für Browser ohne <details name>: andere Bereiche derselben Gruppe zuklappen.
    if (d.getAttribute('name')) for (const anderer of document.querySelectorAll(`details.bereich[name="${d.getAttribute('name')}"]`)) if (anderer !== d) anderer.open = false;
    if (BEREICHE[d.id]) bereichLaden(d.id);
  });
}

$('einstellungen-oeffnen').addEventListener('click', () => {
  for (const d of $('einstellungen').querySelectorAll('.bereich')) d.open = false;
  $('einstellungen').showModal();
  // Statuszeilen aller Bereiche gleichzeitig laden; die Inhalte sind danach schon gefüllt.
  for (const id of Object.keys(BEREICHE)) if (!$(id).hidden) bereichLaden(id);
});
$('einstellungen-schliessen').addEventListener('click', () => $('einstellungen').close());
$('einstellungen').addEventListener('close', () => clearTimeout(tlsTimer));

$('details-schliessen').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', () => { offenesModul = null; clearTimeout(mupdTimer); });
aktualisieren();
const aktualisierer = setInterval(aktualisieren, 10_000);
