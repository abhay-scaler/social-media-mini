// Identifies image format from the file's own leading bytes.
// The browser-supplied Content-Type and filename are attacker-controlled, so the
// stored object's extension and content-type are both derived from this instead.
// SVG is deliberately absent: it can carry executable script and is the primary
// XSS vector for image uploads. Only binary raster formats are accepted.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SIGNATURES = [
  {
    ext: '.jpg',
    mime: 'image/jpeg',
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: '.png',
    mime: 'image/png',
    matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC),
  },
  {
    ext: '.gif',
    mime: 'image/gif',
    matches: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  },
  {
    ext: '.webp',
    mime: 'image/webp',
    matches: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

export const detectImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return SIGNATURES.find((sig) => sig.matches(buffer)) ?? null;
};
