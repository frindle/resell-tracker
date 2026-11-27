// From "Costco eGift delivery email arrives" to "a SCRAPE_EGIFT queued for the order". Every
// dependency is injected so this is unit-testable with node:test; lib/egiftIngestDb.ts wires prisma.
//
// The delivery link and the recipient address are secrets / personal data: they pass through here in
// memory only. Nothing is logged except counts.

import type { EgiftDelivery } from './egiftDelivery.ts';
import { normalizeEgiftEmail } from './egiftEmail.ts';

export type CandidateOrder = { id: number; userId: number | null; orderNumber: string | null };

export type IngestDeps = {
  /** Costco orders whose number contains these digits (a superset: exact matching is done here). */
  findCostcoOrders: (digits: string) => Promise<CandidateOrder[]>;
  hasLink: (orderId: number) => Promise<boolean>;
  /**
   * Follows click-tracking links to the delivery link (lib/egiftLinkResolve.ts). Null when none of
   * them leads to a valid one. Called only when the order still has no link.
   */
  resolveTrackedLink: (urls: readonly string[]) => Promise<string | null>;
  /** Saves through the egift-link PUT handler (validation, hashing, encryption, order lock). True when stored. */
  putLink: (order: CandidateOrder, link: string) => Promise<boolean>;
  hasOrderEmail: (orderId: number) => Promise<boolean>;
  saveOrderEmail: (orderId: number, email: string) => Promise<void>;
  /** True when the order or the user's default holds an address (the scrape cannot start without one). */
  hasAnyEmail: (order: CandidateOrder) => Promise<boolean>;
  hasCards: (orderId: number) => Promise<boolean>;
  /** True when a SCRAPE_EGIFT for this order exists in ANY state (pending, running, done, failed). */
  hasScrapeCommand: (orderId: number) => Promise<boolean>;
  queueScrape: (orderId: number) => Promise<void>;
};

export type IngestCounts = {
  seen: number;
  noOrderNumber: number;
  noMatch: number;
  ambiguous: number;
  linksStored: number;
  linksKept: number; // an order already had a link (hand-set or earlier): left alone
  linksRejected: number;
  linksUnresolved: number; // only click-tracking links, and none of them led to a delivery link
  emailsStored: number;
  queued: number;
  alreadyQueued: number;
  hasCards: number;
  noEmail: number; // no address known: the scrape is not queued
  failed: number;
};

export const emptyCounts = (): IngestCounts => ({
  seen: 0, noOrderNumber: 0, noMatch: 0, ambiguous: 0, linksStored: 0, linksKept: 0, linksRejected: 0, linksUnresolved: 0,
  emailsStored: 0, queued: 0, alreadyQueued: 0, hasCards: 0, noEmail: 0, failed: 0,
});

const digitsOf = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

export async function ingestEgiftDeliveries(
  deliveries: readonly EgiftDelivery[],
  deps: IngestDeps,
  opts: { userId?: number | null } = {},
): Promise<IngestCounts> {
  const c = emptyCounts();
  const done = new Set<number>(); // an order is handled once per batch even if several emails name it
  for (const d of deliveries) {
    c.seen++;
    try {
      const digits = digitsOf(d.orderNumber);
      if (digits.length < 6) { c.noOrderNumber++; continue; }
      let orders = (await deps.findCostcoOrders(digits)).filter(o => digitsOf(o.orderNumber) === digits);
      if (opts.userId != null) orders = orders.filter(o => o.userId === opts.userId);
      if (!orders.length) { c.noMatch++; continue; }
      if (orders.length > 1) { c.ambiguous++; continue; }
      const order = orders[0];
      if (done.has(order.id)) continue;
      done.add(order.id);

      // The link: never overwrite one that is already there (it may have been pasted by hand).
      if (await deps.hasLink(order.id)) c.linksKept++;
      else {
        const link = d.link ?? (d.trackedLinks?.length ? await deps.resolveTrackedLink(d.trackedLinks) : null);
        if (!link) { c.linksUnresolved++; continue; }
        if (await deps.putLink(order, link)) c.linksStored++;
        else { c.linksRejected++; continue; }
      }

      // The address: only when the email shows one and the order has none of its own.
      const email = normalizeEgiftEmail(d.recipient);
      if (email && !(await deps.hasOrderEmail(order.id))) { await deps.saveOrderEmail(order.id, email); c.emailsStored++; }

      if (await deps.hasCards(order.id)) { c.hasCards++; continue; }
      if (await deps.hasScrapeCommand(order.id)) { c.alreadyQueued++; continue; }
      if (!(await deps.hasAnyEmail(order))) { c.noEmail++; continue; }
      await deps.queueScrape(order.id);
      c.queued++;
    } catch {
      c.failed++; // the error text could carry the link or address: count only
    }
  }
  return c;
}

export function countsLine(c: IngestCounts): string {
  return `[egift-ingest] ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`;
}

export type SweepDeps = {
  /** Recent Costco orders that have a saved delivery link. */
  listLinkedOrders: (userId: number | null | undefined) => Promise<CandidateOrder[]>;
  hasCards: IngestDeps['hasCards'];
  hasScrapeCommand: IngestDeps['hasScrapeCommand'];
  hasAnyEmail: IngestDeps['hasAnyEmail'];
  queueScrape: IngestDeps['queueScrape'];
};

/**
 * Orders that already have a link but never got their scrape (the link arrived before a recipient
 * email was known). Queues those whose address is now known; counts the rest as waiting.
 */
export async function sweepLinkedOrders(deps: SweepDeps, opts: { userId?: number | null } = {}): Promise<{ queued: number; waiting: number; failed: number }> {
  const r = { queued: 0, waiting: 0, failed: 0 };
  for (const order of await deps.listLinkedOrders(opts.userId)) {
    try {
      if (await deps.hasCards(order.id)) continue;
      if (await deps.hasScrapeCommand(order.id)) continue;
      if (!(await deps.hasAnyEmail(order))) { r.waiting++; continue; }
      await deps.queueScrape(order.id);
      r.queued++;
    } catch {
      r.failed++;
    }
  }
  return r;
}
