/**
 * Every shape a thrown value can take, reduced to a code and a message.
 *
 * Epic 11 device QA, 23 Sep: the Apple step read only `err.code` and fell back
 * to 'UNKNOWN', so a plain Error, a string, or a native error carrying its code
 * under another name lost everything that would have said what went wrong.
 * Checked in order, most specific first:
 *   1. an object with a string `code` - Expo's CodedError ('ERR_REQUEST_CANCELED'),
 *      and errors from native modules generally
 *   2. an Error without one - its `name` ('TypeError') stands in for the code
 *   3. an object with a numeric `code` - NSError-style ('1001')
 *   4. a string
 *   5. anything else - 'UNKNOWN', with the value's type as the message
 * Pure; no React Native.
 */

export interface DescribedError {
  code: string;
  message: string;
}

const MAX_MESSAGE = 160;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_MESSAGE ? `${oneLine.slice(0, MAX_MESSAGE - 1)}…` : oneLine;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

export function describeError(err: unknown): DescribedError {
  const code = field(err, 'code');
  const message = field(err, 'message');
  const messageText = typeof message === 'string' && message.trim() !== '' ? clip(message) : '';

  if (typeof code === 'string' && code.trim() !== '') {
    return { code: code.trim(), message: messageText || '(no message)' };
  }
  if (err instanceof Error) {
    return { code: err.name || 'Error', message: messageText || '(no message)' };
  }
  if (typeof code === 'number' && Number.isFinite(code)) {
    return { code: String(code), message: messageText || '(no message)' };
  }
  if (typeof err === 'string') {
    return { code: 'STRING_THROWN', message: clip(err) || '(empty)' };
  }
  return { code: 'UNKNOWN', message: err === null ? 'null' : `non-error value of type ${typeof err}` };
}
