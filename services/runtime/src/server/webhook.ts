/**
 * Neynar webhook handler for @atlas mentions on Farcaster.
 *
 * Receives cast.created events, filters for Atlas mentions,
 * invokes Claude Code with DB/world context, and posts replies.
 */

import { createHmac, timingSafeEqual } from "crypto";

interface NeynarWebhookPayload {
  type: string;
  data: {
    hash: string;
    text: string;
    author: {
      fid: number;
      username: string;
      display_name: string;
    };
    parent_hash?: string;
    thread_hash?: string;
    mentioned_profiles?: Array<{ fid: number; username: string }>;
  };
}

export function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = createHmac("sha512", secret);
  hmac.update(body);
  const digest = hmac.digest("hex");
  const normalized = signature.replace(/^sha512=/i, "");

  try {
    const expected = Buffer.from(digest, "hex");
    const received = Buffer.from(normalized, "hex");
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

export function isMentioningAtlas(payload: NeynarWebhookPayload): boolean {
  const atlasFid = parseInt(process.env.AGENT_FID || "12193");
  return (
    payload.type === "cast.created" &&
    (payload.data.mentioned_profiles?.some((p) => p.fid === atlasFid) ?? false)
  );
}

export function extractQuestion(text: string): string {
  // Remove @atlas mention and clean up
  return text.replace(/@atlas\b/gi, "").trim();
}

export async function replyToCast(
  apiKey: string,
  signerUuid: string,
  parentHash: string,
  text: string,
): Promise<string> {
  const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      signer_uuid: signerUuid,
      text: text.slice(0, 1024),
      parent: parentHash,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neynar reply failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.cast?.hash || "unknown";
}
