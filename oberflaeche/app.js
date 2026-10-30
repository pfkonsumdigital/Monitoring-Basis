'use strict';

const STATUS_TEXT = { ok: 'OK', warnung: 'Warnung', fehler: 'Fehler', modulfehler: 'Modul fehlerhaft', 'keine-meldung': 'Keine Meldung', unbekannt: 'Noch keine Meldung', inaktiv: 'Pausiert', laeuft: 'Läuft …', beendet: 'Beendet', 'dienst-gestoppt': 'Dienst gestoppt' };
const DIENST_TEXT = { laeuft: 'läuft', gestoppt: 'gestoppt', startet: 'wird gestartet …', stoppt: 'wird beendet …', pausiert: 'angehalten', fehlt: 'nicht installiert', unbekannt: 'Zustand unbekannt', 'nicht-verfuegbar': 'nur unter Windows abfragbar' };
const $ = (id) => document.getElementById(id);
let offenesModul = null;
let istAdmin = false;
let letzteModule = [];

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
  if (antwort.status === 401) { location.href = '/login'; throw new Error('abgemeldet'); }
  return antwort;
}
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

function textZuModul(m) {
  if (m.fehler) return m.fehler;
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
  if (m.naechsterLauf && !m.laeuft && !['inaktiv', 'beendet', 'keine-meldung', 'dienst-gestoppt'].includes(m.anzeige)) teile.push(`nächster Lauf ${relativ(m.naechsterLauf)}`);
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
    const daten = await (await api('/api/status')).json();
    $('verbindung').hidden = true;
    istAdmin = daten.admin;
    $('benutzer').textContent = daten.benutzer;
    $('version').textContent = daten.version ? `v${daten.version}` : '';
    $('updates-oeffnen').hidden = !daten.admin;
    $('protokoll-oeffnen').hidden = !daten.admin;
    $('benachrichtigung-oeffnen').hidden = !daten.admin;
    $('benutzerverwaltung-oeffnen').hidden = !daten.admin;
    $('neustart-oeffnen').hidden = !daten.neustartMoeglich;
    $('beenden-oeffnen').hidden = !daten.beendenMoeglich;
    $('update-hinweis').hidden = !daten.updateVerfuegbar;
    letzteModule = daten.module;
    const zaehler = { ok: 0, warnung: 0, fehler: 0, 'keine-meldung': 0 };
    for (const m of daten.module) {
      const s = ['modulfehler', 'dienst-gestoppt'].includes(m.anzeige) ? 'fehler' : m.anzeige;
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
      if (neu) detailsFuellen(neu);
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
  }
  setTimeout(aktualisieren, 800);
}

function fakt(name, wert) { return wert ? [el('dt', { textContent: name }), el('dd', { textContent: wert })] : []; }
const prozent = (v) => (v ? `${v.prozent.toLocaleString('de-DE')} % (${v.laeufe} ${v.laeufe === 1 ? 'Lauf' : 'Läufe'}${v.unvollstaendig ? ', Verlauf kürzer' : ''})` : '–');

async function detailsFuellen(m) {
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
  $('details-einstellungen').hidden = !m.hatEinstellungen;
  $('details-pause').textContent = m.aktiv ? 'Pausieren' : 'Fortsetzen';
  $('details-pause').onclick = () => gesperrt([$('details-pause')], aktionMeldung, async () => {
    await senden(`/api/module/${encodeURIComponent(m.id)}/aktiv`, { aktiv: !m.aktiv });
    aktualisieren();
  });
  $('details-einstellungen').onclick = () => einstellungenOeffnen(m);
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
  $('mupd').hidden = !istAdmin || !m.repo || Boolean(m.fehler);
  if (!$('mupd').hidden) modulUpdateLaden(m.id);
  $('details-starten').hidden = !m.kannStarten;
  $('details-starten').onclick = () => modulAktion(m, 'starten', $('details-starten'));
  const messwerte = Object.entries(l?.messwerte ?? {});
  $('details-messwerte-titel').hidden = !messwerte.length;
  $('details-messwerte').replaceChildren(...messwerte.flatMap(([name, wert]) => fakt(name, wert.toLocaleString('de-DE'))));
  $('details-liste').replaceChildren(...(l?.details ?? []).map((d) => el('li', { textContent: d })));
  $('details-ausgabe').hidden = !l?.fehlerausgabe;
  $('details-ausgabe').textContent = l?.fehlerausgabe ?? '';
  if (m.fehler) { $('details-verlauf').replaceChildren(); return; }
  const { verlauf } = await (await api(`/api/module/${encodeURIComponent(m.id)}/verlauf?anzahl=30`)).json();
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
  else if (!st.tokenGesetzt) mupdMeldung('Kein GitHub-Token: im Dialog „Updates“ eintragen (Contents: Read-only, auch für das Modul-Repo).', 'fehler');
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
  clearTimeout(mupdTimer);
  // Während eines Vorgangs jede Sekunde nachsehen; danach Kacheln auffrischen.
  if (laeuft) mupdTimer = setTimeout(() => modulUpdateLaden(st.id, true), 1000);
}

async function modulUpdateLaden(id, nachVorgang = false) {
  if (offenesModul !== id) return;
  const antwort = await api(`/api/module/${encodeURIComponent(id)}/update`).catch(() => null);
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
  detailsFuellen(m);
  if (!$('details').open) $('details').showModal();
}

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
  const standard = f.standard === undefined || f.typ === 'schalter' || f.typ === 'liste' ? '' : `Standard: ${f.standard}`;
  const hilfe = el('small', { className: 'leise', textContent: [f.beschreibung, standard].filter(Boolean).join(' · ') });
  const fehler = el('small', { className: 'feldfehler', id: `${id}-fehler` });
  return el('div', { className: `feld ${f.typ}` }, label, eingabe, hilfe, fehler);
}

async function einstellungenOeffnen(m) {
  einstModul = m;
  $('einst-titel').textContent = `Einstellungen: ${m.name}`;
  einstMeldung('Wird geladen …');
  $('einst-felder').replaceChildren();
  $('einstellungen').showModal();
  const antwort = await api(`/api/module/${encodeURIComponent(m.id)}/einstellungen`);
  if (!antwort.ok) { einstMeldung('Einstellungen konnten nicht geladen werden.', 'fehler'); return; }
  const { felder, werte } = await antwort.json();
  $('einst-felder').replaceChildren(...felder.map((f) => feldBauen(f, werte[f.schluessel])));
  einstMeldung('');
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
  $('einst-felder').replaceChildren(...daten.felder.map((f) => feldBauen(f, daten.werte[f.schluessel])));
  einstMeldung(daten.geaendert.length ? 'Gespeichert. Das Modul übernimmt die Änderung beim nächsten Lauf.' : 'Keine Änderungen.', 'ok');
});
$('einst-schliessen').addEventListener('click', () => $('einstellungen').close());
$('einst-abbrechen').addEventListener('click', () => $('einstellungen').close());

// ---- Benachrichtigung (nur Admins) ----
const BEN_FELDER = ['tenant_id', 'client_id', 'client_secret', 'absender', 'empfaenger', 'melden_nach_laeufen', 'erinnerung_stunden', 'link'];
const benMeldung = (text, art = '') => { $('ben-meldung').textContent = text; $('ben-meldung').dataset.art = art; };
const BEN_ART = { fehler: 'Fehler', warnung: 'Warnung', 'keine-meldung': 'Keine Meldung', 'wieder-ok': 'Wieder OK', erinnerung: 'Erinnerung', test: 'Testmail' };

function benZeigen(daten) {
  const w = daten.werte;
  $('ben-aktiv').checked = w.aktiv;
  for (const k of BEN_FELDER) {
    if (k === 'client_secret') { $('ben-client_secret').value = ''; $('ben-client_secret').placeholder = w.client_secret.gesetzt ? 'gesetzt' : 'nicht gesetzt'; continue; }
    $(`ben-${k}`).value = Array.isArray(w[k]) ? w[k].join(', ') : w[k] ?? '';
  }
  $('ben-leer').hidden = daten.verlauf.length > 0;
  $('ben-verlauf').replaceChildren(...daten.verlauf.map((e) => {
    const li = el('li', {}, el('span', { className: 'punkt' }), el('span', { textContent: `${zeit(e.zeit)} – ${e.betreff}${e.ok ? '' : ` – nicht gesendet: ${e.fehler}`}` }));
    li.dataset.status = !e.ok ? 'fehler' : e.art === 'wieder-ok' || e.art === 'test' ? 'ok' : e.art === 'warnung' ? 'warnung' : 'fehler';
    li.title = BEN_ART[e.art] ?? e.art;
    return li;
  }));
}

function benFehlerZeigen(feldfehler = {}) {
  for (const k of ['aktiv', ...BEN_FELDER]) $(`ben-${k}-fehler`).textContent = feldfehler[k] ?? '';
}

$('benachrichtigung-oeffnen').addEventListener('click', async () => {
  benMeldung('Wird geladen …');
  benFehlerZeigen();
  $('benachrichtigung').showModal();
  const antwort = await api('/api/benachrichtigung');
  if (!antwort.ok) { benMeldung('Einstellungen konnten nicht geladen werden.', 'fehler'); return; }
  benZeigen(await antwort.json());
  benMeldung('');
});
$('ben-schliessen').addEventListener('click', () => $('benachrichtigung').close());
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
      zelle.append(admin, loeschen);
    } else {
      zelle.append(el('span', { className: 'leise', textContent: 'eigenes Konto' }));
    }
    return el('tr', {}, el('td', { textContent: b.name }), el('td', { textContent: b.admin ? 'Admin' : 'Benutzer' }),
      el('td', { textContent: b.sitzungen ? `ja (${b.sitzungen} ${b.sitzungen === 1 ? 'Sitzung' : 'Sitzungen'})` : 'nein' }), zelle);
  }));
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
  if (!antwort.ok) { bvMeldung('Benutzer konnten nicht geladen werden.', 'fehler'); return; }
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

$('benutzerverwaltung-oeffnen').addEventListener('click', async () => {
  bvMeldung('');
  $('bv-anlegen').reset();
  $('bv-setzen').reset();
  $('benutzerverwaltung').showModal();
  await bvLaden().catch(() => bvMeldung(KEINE_VERBINDUNG, 'fehler'));
});
$('bv-schliessen').addEventListener('click', () => $('benutzerverwaltung').close());
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
  if (!$('updates').open) $('updates').showModal();
  const antwort = await api('/api/updates');
  if (antwort.ok) updateZeigen(await antwort.json());
}

$('updates-oeffnen').addEventListener('click', updatesOeffnen);
$('updates-schliessen').addEventListener('click', () => $('updates').close());
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
$('protokoll-oeffnen').addEventListener('click', async () => { $('protokoll').showModal(); await protokollLaden(); });
$('protokoll-schliessen').addEventListener('click', () => $('protokoll').close());
$('prot-aktualisieren').addEventListener('click', protokollLaden);
$('prot-stufe').addEventListener('change', protokollLaden);
$('prot-quelle').addEventListener('change', protokollLaden);

// ---- Neustart (nur Admins) ----
const neustartMeldung = (text, art = '') => { $('neustart-meldung').textContent = text; $('neustart-meldung').dataset.art = art; };
$('neustart-oeffnen').addEventListener('click', () => { neustartMeldung(''); $('neustart-ja').disabled = false; $('neustart').showModal(); });
$('neustart-schliessen').addEventListener('click', () => $('neustart').close());
$('neustart-nein').addEventListener('click', () => $('neustart').close());
$('neustart-ja').addEventListener('click', async () => {
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
$('beenden-oeffnen').addEventListener('click', () => { beendenMeldung(''); $('beenden-module').checked = false; $('beenden-ja').disabled = false; $('beenden').showModal(); });
$('beenden-schliessen').addEventListener('click', () => $('beenden').close());
$('beenden-nein').addEventListener('click', () => $('beenden').close());
$('beenden-ja').addEventListener('click', async () => {
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
  $('beenden').close();
  $('details').close();
  for (const id of ['benachrichtigung-oeffnen', 'protokoll-oeffnen', 'neustart-oeffnen', 'beenden-oeffnen', 'updates-oeffnen', 'benutzerverwaltung-oeffnen', 'passwort-oeffnen']) $(id).hidden = true;
  for (const teil of document.querySelectorAll('main > :not(#beendet-seite)')) teil.hidden = true;
  $('beendet-text').textContent = mitModulen ? 'Die eigenständigen Module wurden ebenfalls beendet (soweit sie das unterstützen).' : 'Eigenständige Module laufen weiter.';
  $('beendet-seite').hidden = false;
  document.title = 'Monitoring – beendet';
});

$('details-schliessen').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', () => { offenesModul = null; clearTimeout(mupdTimer); });
aktualisieren();
const aktualisierer = setInterval(aktualisieren, 10_000);
