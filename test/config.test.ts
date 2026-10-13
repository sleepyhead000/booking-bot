import { describe, it, expect } from 'vitest';
import { applyOverrides, configSchema } from '../src/config/schema.js';

describe('config schema', () => {
  it('fills defaults for an empty config', () => {
    const config = applyOverrides({}, {});
    expect(config.adapter).toBe('reference');
    expect(config.browser.headless).toBe(true);
    expect(config.monitor.minIntervalMs).toBe(4000);
    expect(config.booking.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(config.solver.provider).toBe('manual');
  });

  it('applies CLI dot-path overrides', () => {
    const config = applyOverrides({}, {}, { 'browser.headless': false, 'monitor.minIntervalMs': 999 });
    expect(config.browser.headless).toBe(false);
    expect(config.monitor.minIntervalMs).toBe(999);
  });

  it('applies environment overrides', () => {
    const config = applyOverrides(
      {},
      { HEADLESS: 'false', LOG_LEVEL: 'debug', TARGET_ADAPTER: 'other' },
      {},
    );
    expect(config.browser.headless).toBe(false);
    expect(config.logging.level).toBe('debug');
    expect(config.adapter).toBe('other');
  });

  it('rejects an invalid date format', () => {
    expect(() => applyOverrides({ booking: { dateFrom: '03-11-2026' } }, {})).toThrow();
  });

  it('rejects an inverted monitor range', () => {
    expect(() =>
      applyOverrides({ monitor: { minIntervalMs: 9000, maxIntervalMs: 1000 } }, {}),
    ).toThrow();
  });

  it('rejects an out-of-range weekday', () => {
    expect(() => applyOverrides({ booking: { weekdays: [7] } }, {})).toThrow();
  });

  it('exposes a stable shape', () => {
    const config = configSchema.parse({});
    expect(Object.keys(config)).toEqual(
      expect.arrayContaining(['adapter', 'browser', 'session', 'monitor', 'booking', 'otp', 'notify', 'solver', 'logging']),
    );
  });
});
