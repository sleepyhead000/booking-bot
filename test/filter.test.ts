import { describe, it, expect } from 'vitest';
import { matchesTarget, pickBest, filterSlots, sortSlots, explainFilter } from '../src/monitor/filter.js';
import type { Slot } from '../src/adapter/types.js';
import type { TargetFilter } from '../src/config/schema.js';

function slot(date: string, time = '09:00'): Slot {
  return { id: `${date}T${time}`, date, time, label: `${date} ${time}` };
}

const anyDay: TargetFilter = { dateFrom: null, dateTo: null, weekdays: [] };

describe('slot filter', () => {
  it('accepts everything when the filter is open', () => {
    expect(matchesTarget(slot('2026-11-03'), anyDay)).toBe(true);
  });

  it('applies an inclusive date range', () => {
    const filter: TargetFilter = { dateFrom: '2026-11-03', dateTo: '2026-11-10', weekdays: [] };
    expect(matchesTarget(slot('2026-11-02'), filter)).toBe(false);
    expect(matchesTarget(slot('2026-11-03'), filter)).toBe(true);
    expect(matchesTarget(slot('2026-11-10'), filter)).toBe(true);
    expect(matchesTarget(slot('2026-11-11'), filter)).toBe(false);
  });

  it('applies weekday filtering (0 = Sunday)', () => {
    const mondays: TargetFilter = { dateFrom: null, dateTo: null, weekdays: [1] };
    expect(matchesTarget(slot('2026-11-02'), mondays)).toBe(true); // Monday
    expect(matchesTarget(slot('2026-11-03'), mondays)).toBe(false); // Tuesday
  });

  it('picks the earliest matching slot', () => {
    const slots = [slot('2026-12-01'), slot('2026-11-05'), slot('2026-11-20')];
    expect(pickBest(slots, anyDay)?.date).toBe('2026-11-05');
  });

  it('breaks same-day ties by time, then id (stable ordering)', () => {
    const slots = [slot('2026-11-05', '14:00'), slot('2026-11-05', '09:00'), slot('2026-11-05', '11:00')];
    expect(sortSlots(slots).map((s) => s.time)).toEqual(['09:00', '11:00', '14:00']);
  });

  it('never mutates the input array', () => {
    const slots = [slot('2026-12-01'), slot('2026-11-05')];
    const original = [...slots];
    filterSlots(slots, anyDay);
    expect(slots).toEqual(original);
  });

  it('explains an empty result', () => {
    expect(explainFilter([], anyDay)).toContain('no availability');
    const filter: TargetFilter = { dateFrom: '2026-11-01', dateTo: '2026-11-05', weekdays: [] };
    expect(explainFilter([slot('2027-01-01')], filter)).toContain('outside target');
  });
});
