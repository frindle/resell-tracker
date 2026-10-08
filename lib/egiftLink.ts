// Costco eGift delivery-link helpers (the link is a secret).
import { createHash } from 'node:crypto';

export { parseCostcoDeliveryLink, maskDeliveryLink } from './egiftLinkParse.ts';

export function hashLink(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}
