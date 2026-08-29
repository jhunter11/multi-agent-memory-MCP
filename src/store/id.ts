import { randomBytes } from 'node:crypto';

/**
 * ULID generation, with no dependencies.
 *
 * An id is `mem_` followed by 26 Crockford base32 characters: 10 characters of
 * millisecond timestamp and 16 characters of randomness. Crockford base32 keeps
 * lexical order equal to numeric order, so a plain sort of ids is a sort by
 * creation time. Exports are written in id order, which makes two exports of the
 * same store byte identical and makes a git diff of an export readable.
 *
 * The generator is monotonic. Two ids made in the same millisecond still sort in
 * call order, because the random part increments instead of being redrawn.
 */

/** Crockford base32, lowercase. The letters i, l, o and u are left out. */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BITS = 80n;
const RANDOM_MAX = (1n << RANDOM_BITS) - 1n;
/** 10 base32 characters hold 50 bits, so a 48 bit millisecond clock always fits. */
const MAX_TIME_MS = 2 ** 48 - 1;

export const ENTRY_ID_PREFIX = 'mem_';
export const FEEDBACK_ID_PREFIX = 'fbk_';
export const ENTRY_ID_PATTERN = /^mem_[0-9a-hjkmnp-tv-z]{26}$/u;
export const ULID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/u;

let lastTimeMs = -1;
let lastRandom = 0n;

function encodeTime(ms: number): string {
  let out = '';
  let left = ms;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    // `charAt` returns a string rather than `string | undefined`, which keeps
    // this readable under `noUncheckedIndexedAccess`.
    out = CROCKFORD.charAt(left % 32) + out;
    left = Math.floor(left / 32);
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = '';
  let left = value;
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    out = CROCKFORD.charAt(Number(left & 31n)) + out;
    left >>= 5n;
  }
  return out;
}

function drawRandom(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & RANDOM_MAX;
}

/**
 * Returns a 26 character ULID body with no prefix.
 *
 * `now` exists for tests. Leave it out in real code.
 */
export function newUlid(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError(`ulid time must be a non-negative number, got ${String(now)}`);
  }
  let time = Math.floor(now);
  if (time > MAX_TIME_MS) {
    throw new RangeError(`ulid time ${time} is beyond the 48 bit limit ${MAX_TIME_MS}`);
  }

  if (time <= lastTimeMs) {
    // Same millisecond, or a clock that stepped backwards. Keep the sequence
    // rising so ids stay sortable.
    time = lastTimeMs;
    const next = lastRandom + 1n;
    if (next > RANDOM_MAX) {
      time = lastTimeMs + 1;
      lastRandom = drawRandom();
    } else {
      lastRandom = next;
    }
  } else {
    lastRandom = drawRandom();
  }

  lastTimeMs = time;
  return encodeTime(time) + encodeRandom(lastRandom);
}

/** A new entry id, for example `mem_01jz9v4h8k0000zx2m3n4p5q6r`. */
export function newEntryId(now?: number): string {
  return ENTRY_ID_PREFIX + newUlid(now);
}

/** A new feedback row id. Feedback ids are free form, so they carry their own prefix. */
export function newFeedbackId(now?: number): string {
  return FEEDBACK_ID_PREFIX + newUlid(now);
}

export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && ENTRY_ID_PATTERN.test(value);
}

/** Reads the millisecond timestamp back out of an id. Useful when debugging order. */
export function ulidTime(id: string): number {
  const body = id.length === 30 && id.charAt(4 - 1) === '_' ? id.slice(4) : id;
  if (!ULID_PATTERN.test(body)) {
    throw new Error(`not a ulid: ${id}`);
  }
  let time = 0;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    const digit = CROCKFORD.indexOf(body.charAt(i));
    if (digit < 0) {
      throw new Error(`not a ulid: ${id}`);
    }
    time = time * 32 + digit;
  }
  return time;
}
