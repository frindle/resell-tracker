import { NextResponse } from "next/server";

// STUB — headless Shortcut image-ingest endpoint. To be implemented:
// auth via resolveExtensionUserId, giftCardOcrGate (404 when disabled),
// store unassigned OrderAttachment, run readGiftCardImage, return candidates.
export async function POST(_req: Request) {
  return NextResponse.json({ error: "not implemented" }, { status: 501 });
}
