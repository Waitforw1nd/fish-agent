const ALPHABET = '0123456789abcdefghijklmnopqrstuv';

// Lowercase base32 is reversible, fits a 128-character OpenID in one filename,
// and remains injective on case-insensitive Windows/macOS filesystems.
export function encodeStorageId(value) {
  let bits = 0, buffer = 0, result = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += ALPHABET[(buffer >>> bits) & 31]; }
    buffer &= (1 << bits) - 1;
  }
  if (bits) result += ALPHABET[(buffer << (5 - bits)) & 31];
  return result;
}

export function decodeStorageId(value) {
  if (!/^[0-9a-v]+$/.test(value)) return null;
  let bits = 0, buffer = 0; const bytes = [];
  for (const char of value) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
    buffer &= (1 << bits) - 1;
  }
  const result = Buffer.from(bytes).toString('utf8');
  return encodeStorageId(result) === value ? result : null;
}
