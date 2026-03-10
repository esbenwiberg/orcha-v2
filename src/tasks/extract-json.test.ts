import { describe, it, expect } from 'vitest';
import { extractJson } from './extract-json.js';

describe('extractJson', () => {
  it('parses clean JSON', () => {
    const result = extractJson('{"rating":"good","summary":"works"}');
    expect(result).toEqual({ rating: 'good', summary: 'works' });
  });

  it('extracts JSON from markdown fences', () => {
    const result = extractJson('```json\n{"rating":"good"}\n```');
    expect(result).toEqual({ rating: 'good' });
  });

  it('extracts JSON after prose text', () => {
    const result = extractJson('Here is my analysis.\n\n{"rating":"excellent","summary":"great"}');
    expect(result).toEqual({ rating: 'excellent', summary: 'great' });
  });

  it('handles prose containing ${var} braces before the JSON', () => {
    // Real failure case: Claude outputs prose with template literals then JSON
    const text = 'The code uses `toast toast--${type}` for classes. ' +
      '{"rating":"excellent","summary":"Clear CSS bug","reasoning":"text","pros":["p"],"cons":["c"],"filesExamined":["f.css"]}';
    const result = extractJson(text);
    expect(result).not.toBeNull();
    expect(result!['rating']).toBe('excellent');
    expect(result!['summary']).toBe('Clear CSS bug');
  });

  it('handles trailing commas', () => {
    const result = extractJson('{"rating":"good","pros":["a","b",],}');
    expect(result).toEqual({ rating: 'good', pros: ['a', 'b'] });
  });

  it('returns null for pure prose with no JSON', () => {
    const result = extractJson('This is just analysis text with no JSON at all.');
    expect(result).toBeNull();
  });

  it('handles multiple { in prose before the real JSON', () => {
    const text = 'Pattern: if (x) { foo(); } else { bar(); }. Result: {"rating":"viable"}';
    const result = extractJson(text);
    expect(result).toEqual({ rating: 'viable' });
  });
});
