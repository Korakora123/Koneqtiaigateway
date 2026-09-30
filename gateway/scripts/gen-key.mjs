#!/usr/bin/env node
// Generates a product key and the sha256 hash that goes into PRODUCT_KEYS.
// Usage: node scripts/gen-key.mjs mesgai
// Give the KEY to the product (its AI_GATEWAY_KEY); put only the HASH on the gateway server.
import { createHash, randomBytes } from 'node:crypto';

const product = process.argv[2];
if (!product || !/^[a-z0-9_-]+$/.test(product)) {
  console.error('usage: node scripts/gen-key.mjs <product-name>   (lowercase, e.g. mesgai)');
  process.exit(1);
}
const key = `kq_${product}_${randomBytes(24).toString('base64url')}`;
const hash = createHash('sha256').update(key, 'utf8').digest('hex');
console.log(`product : ${product}`);
console.log(`key     : ${key}      <- product env AI_GATEWAY_KEY (keep secret)`);
console.log(`sha256  : ${hash}`);
console.log(`PRODUCT_KEYS entry: "${product}":"${hash}"`);
