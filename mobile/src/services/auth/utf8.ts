/**
 * UTF-8 <-> string, for the session cipher (TASK-1102).
 *
 * expo-crypto takes a plaintext STRING as base64, not as text, so the session
 * JSON has to become bytes first - and it is not ASCII: user_metadata carries
 * the name Apple or Google returned, which for this app is often Hebrew.
 * Hand-rolled rather than TextEncoder/TextDecoder because Hermes has not always
 * shipped TextDecoder, and a missing global here would surface as "signed out"
 * on some builds and not others. Pure; test:auth checks it against Node's.
 */

export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Bytes -> string. Only ever decodes what utf8Encode produced and an
 * authenticated cipher verified, so a malformed sequence becomes U+FFFD rather
 * than a throw; there is no untrusted input to be strict about.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let code: number;
    let width: number;

    if (b0 < 0x80) {
      code = b0;
      width = 1;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      code = b0 & 0x1f;
      width = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      code = b0 & 0x0f;
      width = 3;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      code = b0 & 0x07;
      width = 4;
    } else {
      out += '�';
      i++;
      continue;
    }

    if (i + width > bytes.length) {
      out += '�';
      break;
    }

    let valid = true;
    for (let k = 1; k < width; k++) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      code = (code << 6) | (b & 0x3f);
    }

    if (!valid || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += '�';
      i++;
      continue;
    }

    out += String.fromCodePoint(code);
    i += width;
  }
  return out;
}
