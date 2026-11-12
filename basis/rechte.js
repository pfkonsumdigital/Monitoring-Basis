// Rechte je Modul (seit 0.19.0). Jeder Benutzer hat ein Grundrecht für alle Module (auch künftige) und
// Abweichungen je Modul. Stufen: kein (Modul unsichtbar), sehen (Kachel, Details, Verlauf, eigene
// Benachrichtigungen), bedienen (zusätzlich „Jetzt prüfen“ und Pause/Fortsetzen).
// Admins sehen und bedienen immer alles. Benutzer ohne „rechte“ stammen aus der Zeit vor 0.19.0 und behalten,
// was sie bisher konnten (alles sehen und prüfen) – das entspricht „bedienen“.
// In config.json: benutzer.<name>.rechte = { grund: 'kein'|'sehen'|'bedienen', module: { <Modul-id>: Stufe } }

export const STUFEN = ['kein', 'sehen', 'bedienen'];
// Recht für die Tickets (seit 0.20.0), gespeichert wie ein Modul unter dieser ID. Anders als bei Modulen gilt hier
// nicht das Grundrecht: Tickets sieht nur, wem ein Admin sie ausdrücklich freigibt (sehen = lesen, bedienen = anlegen
// und bearbeiten). Admins dürfen immer alles. Ein Modul mit dieser ID lehnt die Basis ab (module.js).
export const TICKETS = 'basis-tickets';
const RANG = { kein: 0, sehen: 1, bedienen: 2 };
const MODUL_ID = /^[a-z0-9-]{1,64}$/;

// Stufe eines Benutzers (Eintrag aus config.json) für ein Modul.
export function stufe(eintrag, modulId) {
  if (!eintrag) return 'kein';
  if (eintrag.admin === true) return 'bedienen';
  const r = eintrag.rechte;
  if (!r) return 'bedienen';
  const s = Object.hasOwn(r.module ?? {}, modulId) ? r.module[modulId] : r.grund;
  return STUFEN.includes(s) ? s : 'kein';
}

// Stufe eines Benutzers für die Tickets.
export function ticketStufe(eintrag) {
  if (!eintrag) return 'kein';
  if (eintrag.admin === true) return 'bedienen';
  const s = eintrag.rechte?.module?.[TICKETS];
  return STUFEN.includes(s) ? s : 'kein';
}
export const darfTickets = (eintrag, benoetigt) => RANG[ticketStufe(eintrag)] >= RANG[benoetigt];

// true, wenn der Benutzer für das Modul mindestens die Stufe „benoetigt“ hat.
export const darf = (eintrag, modulId, benoetigt) => RANG[stufe(eintrag, modulId)] >= RANG[benoetigt];

// Prüft eine Eingabe aus der Oberfläche. Liefert { werte } oder { fehler }. Abweichungen gleich dem Grundrecht entfallen.
export function pruefeRechte(eingabe) {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  if (!STUFEN.includes(e.grund)) return { fehler: 'Grundrecht muss „kein“, „sehen“ oder „bedienen“ sein.' };
  const roh = e.module && typeof e.module === 'object' && !Array.isArray(e.module) ? e.module : {};
  const module = {};
  for (const [id, s] of Object.entries(roh)) {
    if (!MODUL_ID.test(id) || id === '__proto__') return { fehler: `Ungültige Modul-ID: ${id}` };
    if (!STUFEN.includes(s)) return { fehler: `Ungültige Stufe für ${id}: ${s}` };
    // Tickets hängen nicht am Grundrecht: dort zählt nur ein ausdrücklich gesetztes Recht (außer „kein“).
    if (id === TICKETS ? s !== 'kein' : s !== e.grund) module[id] = s;
  }
  if (Object.keys(module).length > 500) return { fehler: 'Zu viele Abweichungen.' };
  return { werte: { grund: e.grund, module } };
}

// Für config.json beim Start: Fehlertext oder null.
export function rechteFehler(r) {
  if (r === undefined) return null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'muss ein Objekt sein';
  if (!STUFEN.includes(r.grund)) return 'grund muss "kein", "sehen" oder "bedienen" sein';
  if (r.module !== undefined && (!r.module || typeof r.module !== 'object' || Array.isArray(r.module))) return 'module muss ein Objekt sein';
  for (const [id, s] of Object.entries(r.module ?? {})) if (!MODUL_ID.test(id) || !STUFEN.includes(s)) return `module.${id} ist ungültig`;
  return null;
}

// Kurztext für die Benutzerliste, z. B. „sehen; FTP: bedienen“.
export function rechteText(eintrag, namen = {}) {
  if (eintrag?.admin === true) return 'alle (Admin)';
  const r = eintrag?.rechte;
  if (!r) return 'bedienen (alle Module, wie vor 0.19.0)';
  const abw = Object.entries(r.module ?? {}).map(([id, s]) => `${id === TICKETS ? 'Tickets' : namen[id] ?? id}: ${s}`);
  return [`Grundrecht ${r.grund}`, ...abw].join('; ');
}
