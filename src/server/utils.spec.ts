import { safeJsonStringify, escapeHtml } from './utils';

describe('safeJsonStringify', () => {
  it('escapes angle brackets to prevent script breakout', () => {
    const result = safeJsonStringify({ val: '</script><script>alert(1)//' });
    expect(result).not.toContain('</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('\\u003c');
    expect(result).toContain('\\u003e');
  });

  it('escapes unicode line/paragraph separators', () => {
    const result = safeJsonStringify({ val: 'a b c' });
    expect(result).not.toContain(' ');
    expect(result).not.toContain(' ');
    expect(result).toContain('\\u2028');
    expect(result).toContain('\\u2029');
  });

  it('produces valid JSON when parsed after unescaping', () => {
    const input = { key: '<img onerror="alert(1)">', nested: { a: 1 } };
    const result = safeJsonStringify(input);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual(input);
  });

  it('handles null and primitive values', () => {
    expect(safeJsonStringify(null)).toBe('null');
    expect(safeJsonStringify(42)).toBe('42');
    expect(safeJsonStringify('hello')).toBe('"hello"');
  });
});

describe('escapeHtml', () => {
  it('escapes all HTML-sensitive characters', () => {
    const result = escapeHtml('<div class="a" data-x=\'b\'>&');
    expect(result).toBe(
      '&lt;div class=&quot;a&quot; data-x=&#39;b&#39;&gt;&amp;',
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });
});
