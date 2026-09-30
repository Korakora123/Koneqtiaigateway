import { createHash, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Product keys are stored only as sha256 hashes (PRODUCT_KEYS env). */
export class KeyStore {
  private readonly entries: Array<{ product: string; hash: Buffer }>;

  constructor(productKeyHashes: Record<string, string>) {
    this.entries = Object.entries(productKeyHashes).map(([product, hex]) => ({
      product,
      hash: Buffer.from(hex.toLowerCase(), 'hex'),
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** Returns the product name for a bearer key, or null. Compares against every entry in constant time. */
  identify(presentedKey: string): string | null {
    const h = Buffer.from(sha256Hex(presentedKey), 'hex');
    let found: string | null = null;
    for (const e of this.entries) if (timingSafeEqual(h, e.hash) && found === null) found = e.product;
    return found;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

type Range = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** IP allowlist with single addresses and CIDR ranges, IPv4 and IPv6 (v4-mapped v6 normalised). */
export class IpAllowList {
  private readonly ranges: Range[];

  constructor(entries: string[]) {
    this.ranges = entries.map((e) => {
      if (e.includes('/')) return ipaddr.parseCIDR(e);
      const addr = ipaddr.parse(e);
      return [addr, addr.kind() === 'ipv4' ? 32 : 128] as Range;
    });
  }

  allows(ip: string | undefined): boolean {
    if (!ip || !ipaddr.isValid(ip)) return false;
    let addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    return this.ranges.some(([net, bits]) => net.kind() === addr.kind() && addr.match(net, bits));
  }
}
