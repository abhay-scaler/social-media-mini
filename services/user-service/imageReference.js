import { URL } from "url";

/**
 * An image reference may only be a URL this system itself produced.
 *
 * `/upload` validates magic bytes and stores the object in Supabase, then
 * returns its public URL. Accepting an arbitrary `image` string from the
 * request body bypassed that entirely: a client could skip `/upload` and store
 * a multi-megabyte `data:` URI in MongoDB, or point the field at any external
 * host. This restricts the field to the configured Supabase origin.
 *
 * Returns null for an absent value, the trimmed URL when acceptable, and
 * throws otherwise.
 */
export function validateImageReference(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("image must be a URL string returned by /upload");
  }
  const candidate = value.trim();
  if (!candidate) return null;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("image must be an absolute URL returned by /upload");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("image must be an https URL returned by /upload");
  }
  // `https://evil.example@project-ref.supabase.co/x.png` resolves to the
  // allowed host, so a host check alone accepts it -- but the attacker-chosen
  // userinfo is what a reader sees. /upload never produces credentials in a
  // URL, so reject them outright.
  if (parsed.username || parsed.password) {
    throw new Error("image URL must not contain credentials");
  }

  const base = process.env.SUPABASE_URL;
  if (!base) {
    // Uploads are unconfigured, so no image reference can legitimately exist.
    throw new Error("image uploads are not configured on this deployment");
  }
  let allowedHost;
  try {
    allowedHost = new URL(base).host;
  } catch {
    throw new Error("image uploads are not configured correctly");
  }
  if (parsed.host !== allowedHost) {
    throw new Error("image must be a URL returned by /upload");
  }
  // Return the canonical form rather than the caller's spelling, so a default
  // port or odd host casing cannot be persisted verbatim.
  return parsed.href;
}
