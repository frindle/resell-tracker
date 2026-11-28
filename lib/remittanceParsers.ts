// The registry of group payment-email parsers. Adding a group (Big Sky, ...): write its parser as a RemittanceParser in its own
// file (compose the helpers in remittanceParse.ts), add it here, and add a fixture test with an invented email.
import { bfmrPaymentParser } from './bfmrPaymentEmail.ts';
import type { RemittanceParser } from './remittanceParse.ts';

export const REMITTANCE_PARSERS: readonly RemittanceParser[] = [bfmrPaymentParser];
