import { describe, it, expect } from 'vitest';

import { parseDuration, parseConditions } from './conditions.js';

describe('parseDuration', () => {
  it('parses milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('parses fractional values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('returns null for invalid strings', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('10x')).toBeNull();
    expect(parseDuration('m')).toBeNull();
  });
});

describe('parseConditions', () => {
  it('returns null for null/empty', () => {
    expect(parseConditions(null)).toBeNull();
    expect(parseConditions('')).toBeNull();
    expect(parseConditions('null')).toBeNull();
    expect(parseConditions('[]')).toBeNull();
  });

  it('parses bare leaf condition with defaults', () => {
    const result = parseConditions('{"type":"battery_charging"}');
    expect(result).not.toBeNull();
    expect(result!.expr).toEqual({ type: 'battery_charging' });
    expect(result!.staleAfter).toEqual({ type: 'deferrals', value: 10 });
    expect(result!.remindIntervalMs).toBe(3_600_000);
  });

  it('parses bare array as implicit AND with defaults', () => {
    const json = JSON.stringify([
      { type: 'battery_charging' },
      { type: 'wifi_connected' },
    ]);
    const result = parseConditions(json);
    expect(result).not.toBeNull();
    expect(result!.expr).toEqual({
      and: [{ type: 'battery_charging' }, { type: 'wifi_connected' }],
    });
    expect(result!.staleAfter).toEqual({ type: 'deferrals', value: 10 });
  });

  it('parses single-element array as unwrapped leaf', () => {
    const json = JSON.stringify([{ type: 'vpn_connected' }]);
    const result = parseConditions(json);
    expect(result!.expr).toEqual({ type: 'vpn_connected' });
  });

  it('parses wrapper format with deferral count stale_after', () => {
    const json = JSON.stringify({
      conditions: [{ type: 'battery_charging' }],
      stale_after: 5,
      remind_interval: '30m',
    });
    const result = parseConditions(json);
    expect(result).not.toBeNull();
    expect(result!.expr).toEqual({ type: 'battery_charging' });
    expect(result!.staleAfter).toEqual({ type: 'deferrals', value: 5 });
    expect(result!.remindIntervalMs).toBe(1_800_000);
  });

  it('parses wrapper format with duration stale_after', () => {
    const json = JSON.stringify({
      conditions: { type: 'wifi_connected', ssid: 'Office' },
      stale_after: '2h',
      remind_interval: '15m',
    });
    const result = parseConditions(json);
    expect(result!.staleAfter).toEqual({ type: 'duration', ms: 7_200_000 });
    expect(result!.remindIntervalMs).toBe(900_000);
  });

  it('uses defaults for missing stale_after and remind_interval in wrapper', () => {
    const json = JSON.stringify({
      conditions: [{ type: 'battery_charging' }],
    });
    const result = parseConditions(json);
    expect(result!.staleAfter).toEqual({ type: 'deferrals', value: 10 });
    expect(result!.remindIntervalMs).toBe(3_600_000);
  });

  it('returns null for wrapper with empty conditions', () => {
    const json = JSON.stringify({ conditions: [] });
    expect(parseConditions(json)).toBeNull();
  });

  it('returns null for wrapper with null conditions', () => {
    const json = JSON.stringify({ conditions: null });
    expect(parseConditions(json)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseConditions('{bad json')).toBeNull();
  });
});
