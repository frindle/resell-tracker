// BFMR write-transport switch. Setting `bfmr_write_transport` = 'rest' routes
// writes through the REST v2 API; anything else (including unset) keeps the
// legacy web path. Pure on purpose. Removed in U10.
export function isRestWrites(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'rest';
}
