/**
 * TASK-1001 - route-stops rate limiting ("The Shield").
 *
 * Free of Deno and Supabase globals, like handler.ts: index.ts supplies the
 * bucket store (public.consume_rate_limit, service role), and the tests supply
 * a fake one.
 *
 * TWO BUCKETS PER REQUEST, spent all-or-nothing by the database:
 *
 *   client   per IP address. Stops one device or script from bursting. Keyed by
 *            IP because the anon key ships inside the app: every install sends
 *            the SAME token, so a token key would put every visitor in one
 *            bucket.
 *   global   one for the whole function. Protects the routing budget from
 *            anyone who rotates addresses, which a per-IP limit cannot.
 *
 * WHY IT FAILS OPEN. A limiter that cannot reach its store lets the request
 * through and logs it. Failing closed would turn a database blip into "no live
 * routes for anyone". Failing open costs, at worst, the few provider calls the
 * limiter exists to prevent, and route_legs_cache still absorbs repeats.
 *
 * WHAT A 429 COSTS A VISITOR: little. The app treats 429 as retryable (5 s, then
 * 20 s, 3 attempts) and keeps drawing the bundled route meanwhile, so a false
 * positive delays the personalised route. It never blocks a tour.
 */

export interface BucketPolicy {
  /** Requests allowed at once. */
  burst: number;
  /** Sustained requests per minute. */
  perMinute: number;
}

export interface RateLimitPolicy {
  client: BucketPolicy;
  global: BucketPolicy;
}

/**
 * PROVISIONAL numbers, pending the PM's routing budget. Override without a
 * redeploy: `supabase secrets set ROUTE_RATE_LIMIT_CLIENT_BURST=...`.
 *
 * client 20 burst, 10/min
 *   One device needs 1-3 calls per tour session (Epic 9 retry policy). The
 *   burst is sized for a hotel lobby or tour group behind one NAT address
 *   starting together. Carrier-grade NAT can put many more visitors behind one
 *   address. That is why a refusal only delays the live route.
 * global 300 burst, 120/min
 *   A ceiling on ALL traffic, cached or not, so the worst sustained provider
 *   spend is 172,800 calls a day, and far less in practice, since
 *   route_legs_cache serves repeats without a provider call.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  client: { burst: 20, perMinute: 10 },
  global: { burst: 300, perMinute: 120 },
};

const ENV_KEYS = {
  clientBurst: 'ROUTE_RATE_LIMIT_CLIENT_BURST',
  clientPerMinute: 'ROUTE_RATE_LIMIT_CLIENT_PER_MINUTE',
  globalBurst: 'ROUTE_RATE_LIMIT_GLOBAL_BURST',
  globalPerMinute: 'ROUTE_RATE_LIMIT_GLOBAL_PER_MINUTE',
} as const;

/**
 * Policy from the environment, with defaults. A value that is missing, not a
 * number, or out of range keeps its default. A typo in a secret must not
 * disable the limiter or make it refuse everything.
 */
export function rateLimitPolicyFromEnv(env: Record<string, string | undefined>): RateLimitPolicy {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 1 && value <= 100_000 ? value : fallback;
  };
  const d = DEFAULT_RATE_LIMIT_POLICY;
  return {
    client: {
      burst: read(ENV_KEYS.clientBurst, d.client.burst),
      perMinute: read(ENV_KEYS.clientPerMinute, d.client.perMinute),
    },
    global: {
      burst: read(ENV_KEYS.globalBurst, d.global.burst),
      perMinute: read(ENV_KEYS.globalPerMinute, d.global.perMinute),
    },
  };
}

// -----------------------------------------------------------------------------
// Client address

/**
 * Headers that may carry the caller's address, most trustworthy first.
 *
 * `cf-connecting-ip` is written by Cloudflare, which fronts the hosted API
 * gateway, and replaces whatever a client sent. `x-forwarded-for`'s FIRST entry
 * is whatever the client claimed, so it is the last resort. VERIFY ON DEPLOY
 * (see the Handover Report): send a forged `X-Forwarded-For` and confirm the
 * refusal still follows the real address.
 */
const ADDRESS_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;

export interface ClientAddress {
  /** Normalised: an IPv4 address, or the /64 prefix of an IPv6 address. */
  key: string;
  header: (typeof ADDRESS_HEADERS)[number];
}

export function clientAddress(headers: Headers): ClientAddress | null {
  for (const header of ADDRESS_HEADERS) {
    const raw = headers.get(header);
    if (!raw) continue;
    const first = raw.split(',')[0]?.trim() ?? '';
    const key = normaliseAddress(first);
    if (key !== null) return { key, header };
  }
  return null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * IPv4 as-is. IPv6 reduced to its /64, because one subscriber is routinely
 * handed a whole /64: keying on the full address would give a single phone
 * 2^64 fresh buckets. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is treated as the IPv4
 * address it is. Anything unparseable is null, so garbage cannot mint keys.
 */
export function normaliseAddress(raw: string): string | null {
  let address = raw.trim();
  // "[2001:db8::1]:443" and "1.2.3.4:443" - a port is not part of the address.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1] as string;
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  // A zone id ("fe80::1%eth0") names an interface on the sender's side.
  address = address.split('%')[0] as string;

  if (IPV4.test(address)) return address;

  const mapped = /^::ffff:([\d.]+)$/i.exec(address);
  if (mapped && IPV4.test(mapped[1] as string)) return mapped[1] as string;

  const groups = expandIpv6(address);
  if (groups === null) return null;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

function expandIpv6(address: string): string[] | null {
  if (!/^[0-9a-f:]+$/i.test(address) || address.length > 39) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups : null;
  };
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...tail].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

// -----------------------------------------------------------------------------
// Limiter

export interface BucketRequest {
  key: string;
  capacity: number;
  refillPerSecond: number;
}

export interface BucketOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  /** Keys of the buckets that refused. */
  exhausted: string[];
}

/** public.consume_rate_limit. Throws on any failure; the limiter fails open. */
export type BucketStore = (buckets: BucketRequest[]) => Promise<BucketOutcome>;

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number; scope: 'client' | 'global' };

export type RateLimiter = (request: Request) => Promise<RateLimitDecision>;

const KEY_PREFIX = 'route-stops';
export const GLOBAL_BUCKET_KEY = `${KEY_PREFIX}:global`;

export interface RateLimiterOptions {
  store: BucketStore;
  policy?: RateLimitPolicy;
  /**
   * HMAC key for client addresses, so the table never holds a raw IP. Without
   * one an address is merely hashed, and IPv4 hashes are reversible by brute
   * force, so index.ts always passes a server-side secret.
   */
  secret: string;
  log?: (event: Record<string, unknown>) => void;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const policy = options.policy ?? DEFAULT_RATE_LIMIT_POLICY;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const hmacKey = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  let warnedNoAddress = false;

  const bucket = (key: string, p: BucketPolicy): BucketRequest => ({
    key,
    capacity: p.burst,
    refillPerSecond: p.perMinute / 60,
  });

  return async (request) => {
    const buckets = [bucket(GLOBAL_BUCKET_KEY, policy.global)];
    const address = clientAddress(request.headers);
    let clientKey: string | null = null;

    if (address) {
      const mac = await crypto.subtle.sign('HMAC', await hmacKey, new TextEncoder().encode(address.key));
      // 128 bits of the MAC: collision-free at any realistic address count,
      // and well inside the key length the table allows.
      clientKey = `${KEY_PREFIX}:ip:${hex(new Uint8Array(mac).slice(0, 16))}`;
      buckets.push(bucket(clientKey, policy.client));
    } else if (!warnedNoAddress) {
      // Once per isolate. If this appears in production, the gateway is not
      // forwarding any address header and ONLY the global bucket is working.
      warnedNoAddress = true;
      log({ event: 'route_stops_rate_limit_no_client_address' });
    }

    let outcome: BucketOutcome;
    try {
      outcome = await options.store(buckets);
    } catch (cause) {
      log({ event: 'route_stops_rate_limit_unavailable', message: String(cause) });
      return { allowed: true, remaining: -1 };
    }

    if (outcome.allowed) return { allowed: true, remaining: outcome.remaining };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(outcome.retryAfterSeconds)),
      // Client first: when both are empty, the caller's own burst is the
      // reason worth reporting.
      scope: clientKey !== null && outcome.exhausted.includes(clientKey) ? 'client' : 'global',
    };
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
