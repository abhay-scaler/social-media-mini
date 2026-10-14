import { requireInternalAuth } from './internalAuth.js';

// Tests for the service-to-service guard on POST /sync-user.
//
// /sync-user is reachable through the gateway and cannot use the JWT `protect`
// middleware, because it runs during registration before the new user has a
// token. The guard is therefore the only thing standing between an anonymous
// caller and a forged profile -- including a chosen _id, email and pre-hashed
// password. These tests exercise the exported middleware directly, so they
// cover the code the service runs rather than a replica assembled here.
describe('requireInternalAuth', () => {
  // Shaped like the real value: `openssl rand -hex 32`.
  const TOKEN = 'f'.repeat(64);

  beforeEach(() => { process.env.INTERNAL_SERVICE_TOKEN = TOKEN; });
  afterEach(() => { delete process.env.INTERNAL_SERVICE_TOKEN; });

  // Minimal stand-ins for the Express objects the middleware touches.
  const invoke = (headers) => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };

    let nextCalled = false;
    requireInternalAuth({ headers }, res, () => { nextCalled = true; });

    return { res, nextCalled };
  };

  const expectRejected = (headers) => {
    const { res, nextCalled } = invoke(headers);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    return res;
  };

  describe('accepts', () => {
    it('the exact token', () => {
      const { res, nextCalled } = invoke({ 'x-internal-token': TOKEN });
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBeNull();
      expect(res.body).toBeNull();
    });

    it('the token alongside unrelated headers', () => {
      const { nextCalled } = invoke({
        'content-type': 'application/json',
        'x-internal-token': TOKEN,
        'user-agent': 'axios/1.7.9',
      });
      expect(nextCalled).toBe(true);
    });
  });

  describe('rejects a missing token', () => {
    it('when the header is absent', () => {
      expectRejected({});
    });

    it('when the header is empty', () => {
      expectRejected({ 'x-internal-token': '' });
    });

    it('when the header is undefined', () => {
      expectRejected({ 'x-internal-token': undefined });
    });

    // A header sent twice arrives as a comma-joined string for most names, but
    // an array must not slip past the type check either.
    it('when the header arrives as an array', () => {
      expectRejected({ 'x-internal-token': [TOKEN, TOKEN] });
    });

    it('when the header is a comma-joined duplicate', () => {
      expectRejected({ 'x-internal-token': `${TOKEN},${TOKEN}` });
    });
  });

  describe('rejects an invalid token', () => {
    it('differing in the last character, at the same length', () => {
      expectRejected({ 'x-internal-token': `${'f'.repeat(63)}e` });
    });

    it('differing in the first character, at the same length', () => {
      expectRejected({ 'x-internal-token': `e${'f'.repeat(63)}` });
    });

    it('a correct prefix of the token', () => {
      expectRejected({ 'x-internal-token': TOKEN.slice(0, 32) });
    });

    it('the token with a character appended', () => {
      expectRejected({ 'x-internal-token': `${TOKEN}f` });
    });

    it('the token with surrounding whitespace', () => {
      expectRejected({ 'x-internal-token': ` ${TOKEN} ` });
    });

    it('the token in the opposite case', () => {
      expectRejected({ 'x-internal-token': TOKEN.toUpperCase() });
    });

    it('an entirely unrelated value', () => {
      expectRejected({ 'x-internal-token': 'let-me-in' });
    });
  });

  // Regression: the guard previously compared STRING lengths before calling
  // crypto.timingSafeEqual, which throws a RangeError unless the two buffers
  // have the same BYTE length. A multibyte value can match on characters while
  // differing in bytes ('f'.repeat(63) + 'é' is 64 characters but 65 bytes), so
  // an anonymous caller could turn the guard into a 500 with a stack trace on a
  // path that requires no credentials. The comparison is now on byte length.
  describe('rejects multibyte values without throwing', () => {
    it('a value whose character length matches but byte length does not', () => {
      const multibyte = `${'f'.repeat(63)}é`;
      expect(multibyte).toHaveLength(TOKEN.length);
      expect(Buffer.byteLength(multibyte, 'utf8')).not.toBe(
        Buffer.byteLength(TOKEN, 'utf8'),
      );

      expect(() => invoke({ 'x-internal-token': multibyte })).not.toThrow();
      expectRejected({ 'x-internal-token': multibyte });
    });

    it('a value that is entirely multibyte', () => {
      expectRejected({ 'x-internal-token': 'é'.repeat(64) });
    });

    it('a value using astral-plane characters', () => {
      expectRejected({ 'x-internal-token': '\u{1F600}'.repeat(16) });
    });
  });

  describe('fails closed when the secret is not configured', () => {
    it('rejects when INTERNAL_SERVICE_TOKEN is unset, even with a header', () => {
      delete process.env.INTERNAL_SERVICE_TOKEN;
      expectRejected({ 'x-internal-token': TOKEN });
    });

    it('rejects when INTERNAL_SERVICE_TOKEN is empty, even with an empty header', () => {
      process.env.INTERNAL_SERVICE_TOKEN = '';
      expectRejected({ 'x-internal-token': '' });
    });

    it('rejects when neither the secret nor the header is present', () => {
      delete process.env.INTERNAL_SERVICE_TOKEN;
      expectRejected({});
    });
  });

  it('never echoes the expected token in a rejection', () => {
    const res = expectRejected({ 'x-internal-token': 'wrong' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});
