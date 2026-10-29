export async function pruefen(kontext) {
  console.log('Diese Ausgabe darf das Ergebnis nicht stören.');
  return { status: 'warnung', zusammenfassung: `Hallo ${kontext.einstellungen.name}`, details: ['a'], messwerte: { anzahl: 3, text: 'x' } };
}
