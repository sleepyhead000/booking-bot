import type { Slot } from '../adapter/types.js';
import type { TargetFilter } from '../config/schema.js';

/** Inclusive date comparison on YYYY-MM-DD strings (lexicographic is safe here). */
function inRange(date: string, from: string | null, to: string | null): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function matchesTarget(slot: Slot, filter: TargetFilter): boolean {
  if (!inRange(slot.date, filter.dateFrom, filter.dateTo)) return false;
  if (filter.weekdays.length > 0) {
    // Parse as UTC so the weekday does not depend on the machine's timezone.
    const weekday = new Date(`${slot.date}T00:00:00Z`).getUTCDay();
    if (!filter.weekdays.includes(weekday)) return false;
  }
  return true;
}

/**
 * The slot a human would take: earliest date, then earliest time.
 * Ordering must be total and stable or the bot will oscillate between two
 * equally-good options across poll cycles.
 */
export function sortSlots(slots: Slot[]): Slot[] {
  return [...slots].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.time ?? '';
    const bt = b.time ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function filterSlots(slots: Slot[], filter: TargetFilter): Slot[] {
  return sortSlots(slots.filter((s) => matchesTarget(s, filter)));
}

/** Best matching slot (earliest), or null when nothing qualifies. */
export function pickBest(slots: Slot[], filter: TargetFilter): Slot | null {
  return filterSlots(slots, filter)[0] ?? null;
}

/** Debug helper: why did nothing match? */
export function explainFilter(slots: Slot[], filter: TargetFilter): string {
  if (slots.length === 0) return 'portal reported no availability';
  const dates = slots.map((s) => s.date).sort();
  const range = `${filter.dateFrom ?? 'any'} → ${filter.dateTo ?? 'any'}`;
  const weekdays = filter.weekdays.length ? filter.weekdays.join(',') : 'any';
  return `${slots.length} slot(s) ${dates[0]}..${dates[dates.length - 1]} outside target (range ${range}, weekdays ${weekdays})`;
}
