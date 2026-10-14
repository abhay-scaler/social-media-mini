import { jest } from '@jest/globals';
import { validateImageReference } from './imageReference.js';

// Regression tests for the unvalidated `post.image` field.
//
// Before this guard, POST / and PUT /:postId copied `image` straight from the
// request body into MongoDB. A client could skip /upload entirely and store a
// multi-megabyte `data:` URI, or point the field at any external host --
// bypassing the magic-byte validation that /upload performs.
describe('validateImageReference', () => {
  const ALLOWED = 'https://project-ref.supabase.co';

  beforeEach(() => { process.env.SUPABASE_URL = ALLOWED; });
  afterEach(() => { delete process.env.SUPABASE_URL; });

  describe('accepts', () => {
    it('an absent value', () => {
      expect(validateImageReference(undefined)).toBeNull();
      expect(validateImageReference(null)).toBeNull();
      expect(validateImageReference('')).toBeNull();
      expect(validateImageReference('   ')).toBeNull();
    });

    it('a URL on the configured upload origin', () => {
      const url = `${ALLOWED}/storage/v1/object/public/uploads/abc.png`;
      expect(validateImageReference(url)).toBe(url);
    });

    it('and trims surrounding whitespace', () => {
      const url = `${ALLOWED}/storage/v1/object/public/uploads/abc.png`;
      expect(validateImageReference(`  ${url}  `)).toBe(url);
    });
  });

  describe('rejects', () => {
    it('a base64 data URI — the original defect', () => {
      expect(() => validateImageReference('data:image/png;base64,iVBORw0KGgo='))
        .toThrow(/absolute URL|https URL/);
    });

    it('an arbitrary external host', () => {
      expect(() => validateImageReference('https://evil.example.com/x.png'))
        .toThrow(/returned by \/upload/);
    });

    it('a look-alike host', () => {
      expect(() => validateImageReference('https://project-ref.supabase.co.evil.example/x.png'))
        .toThrow(/returned by \/upload/);
    });

    it('plain http on the allowed host', () => {
      expect(() => validateImageReference('http://project-ref.supabase.co/x.png'))
        .toThrow(/https URL/);
    });

    it('a non-URL string', () => {
      expect(() => validateImageReference('not-a-url')).toThrow(/absolute URL/);
    });

    it('a non-string value', () => {
      expect(() => validateImageReference({ url: 'x' })).toThrow(/URL string/);
      expect(() => validateImageReference(12345)).toThrow(/URL string/);
    });

    it('any value when uploads are unconfigured', () => {
      delete process.env.SUPABASE_URL;
      expect(() => validateImageReference(`${ALLOWED}/x.png`))
        .toThrow(/not configured/);
    });

    it('a URL carrying credentials — userinfo smuggling', () => {
      // Resolves to the allowed host, so a host check alone would accept it,
      // but the attacker chooses what the reader sees before the '@'.
      expect(() => validateImageReference(`https://evil.example@project-ref.supabase.co/a.png`))
        .toThrow(/must not contain credentials/);
      expect(() => validateImageReference(`https://u:p@project-ref.supabase.co/a.png`))
        .toThrow(/must not contain credentials/);
    });

    it('a protocol-relative URL', () => {
      expect(() => validateImageReference('//project-ref.supabase.co/a.png'))
        .toThrow(/absolute URL/);
    });

    it('a javascript: scheme', () => {
      expect(() => validateImageReference('javascript:alert(1)')).toThrow(/https URL/);
    });

    it('an alternate port on the allowed host', () => {
      expect(() => validateImageReference(`${ALLOWED}:8443/a.png`))
        .toThrow(/returned by \/upload/);
    });
  });

  describe('canonicalises', () => {
    it('the default port away', () => {
      expect(validateImageReference('https://project-ref.supabase.co:443/a.png'))
        .toBe('https://project-ref.supabase.co/a.png');
    });

    it('host casing', () => {
      expect(validateImageReference('https://PROJECT-REF.SUPABASE.CO/a.png'))
        .toBe('https://project-ref.supabase.co/a.png');
    });
  });
});
