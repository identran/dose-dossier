// Number and unit formatting for the readouts.

export function number(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

export function halfLife(hours) {
  if (!Number.isFinite(hours)) return '';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 96) return `${+hours.toPrecision(3)} h`;
  return `${+(hours / 24).toPrecision(3)} d`;
}

// 'ng/mL' -> 'ng·h/mL'
export function aucUnit(unit) {
  if (!unit) return '';
  const cut = unit.indexOf('/');
  return cut < 0 ? `${unit}·h` : `${unit.slice(0, cut)}·h${unit.slice(cut)}`;
}
