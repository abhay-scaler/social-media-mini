/**
 * Migration: legacy base64 image strings → Supabase Storage objects
 *
 * Earlier versions of the app stored images as base64 `data:` URLs directly in
 * MongoDB (post.image and user.profilePic). This uploads each one to Supabase
 * Storage and replaces the field with the resulting public URL.
 *
 * Safety properties:
 *  - Idempotent. Only documents whose field still starts with "data:" are
 *    considered, so already-migrated records are never re-uploaded.
 *  - Resumable. Each document is uploaded and then updated individually; an
 *    interrupted run leaves every untouched document exactly as it was.
 *  - Storage-first. MongoDB is written only after the object is durably stored,
 *    so a failure can never leave a document pointing at a nonexistent object.
 *  - Non-destructive. Nothing is deleted. A failed record keeps its original
 *    base64 value and is reported for follow-up.
 *  - Streaming. Documents are walked with a cursor rather than loaded into
 *    memory at once, since each base64 image can be several megabytes.
 *  - Content-checked. Decoded bytes must be a real JPEG/PNG/GIF/WebP; malformed
 *    or non-image values are skipped rather than uploaded as garbage.
 *
 * Posts and profiles live in SEPARATE databases, so both URIs are required
 * explicitly — the script never guesses one from the other.
 *
 * Required environment:
 *   POST_MONGO_URI             e.g. mongodb://…/post-service
 *   USER_MONGO_URI             e.g. mongodb://…/user-service
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_STORAGE_BUCKET    optional, defaults to "uploads"
 *
 * Usage — always dry-run first, and take a database backup before the real run:
 *   DRY_RUN=1 node scripts/migrate-base64-images.js
 *   node scripts/migrate-base64-images.js
 */

import mongoose from "mongoose";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { detectImageType } from "../services/post-service/imageType.js";

dotenv.config();

const DRY_RUN = process.env.DRY_RUN === '1';
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
const LOG_EVERY = 50;

const REQUIRED = ['POST_MONGO_URI', 'USER_MONGO_URI', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DATA_URL = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

const decodeDataUrl = (value) => {
  const match = typeof value === 'string' ? value.match(DATA_URL) : null;
  if (!match) throw new Error('not a recognisable base64 image data URL');

  const buffer = Buffer.from(match[2], 'base64');
  const detected = detectImageType(buffer);
  if (!detected) throw new Error('decoded bytes are not a valid JPEG, PNG, GIF or WebP image');

  return { buffer, detected };
};

/**
 * `ownerField` names the field holding the owning user id; when omitted the
 * document's own _id is the owner (profile pictures belong to the user doc).
 */
const migrate = async ({ label, Model, field, prefix, ownerField }) => {
  const filter = { [field]: /^data:/ };
  const total = await Model.countDocuments(filter);
  console.log(`\n${label}: ${total} document(s) with a base64 ${field}`);

  const stats = { migrated: 0, skipped: 0, failed: 0 };
  if (total === 0) return stats;

  const projection = ['_id', field, ownerField].filter(Boolean).join(' ');
  const cursor = Model.find(filter).select(projection).lean().cursor();

  for await (const doc of cursor) {
    let decoded;
    try {
      decoded = decodeDataUrl(doc[field]);
    } catch (err) {
      console.error(`  ⚠️  ${label} ${doc._id}: skipped — ${err.message}`);
      stats.skipped++;
      continue;
    }

    const owner = ownerField ? doc[ownerField] : doc._id;
    const objectPath = `${prefix}/${owner}/${randomUUID()}${decoded.detected.ext}`;

    if (DRY_RUN) {
      console.log(`  [dry-run] ${label} ${doc._id} → ${objectPath} (${decoded.buffer.length} bytes)`);
      stats.migrated++;
      continue;
    }

    try {
      const { error } = await supabase.storage.from(BUCKET).upload(objectPath, decoded.buffer, {
        contentType: decoded.detected.mime,
        upsert: false,
      });
      if (error) throw new Error(error.message);

      const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
      await Model.updateOne({ _id: doc._id }, { $set: { [field]: publicUrl } });

      stats.migrated++;
      if (stats.migrated % LOG_EVERY === 0) {
        console.log(`  …${stats.migrated}/${total} migrated`);
      }
    } catch (err) {
      // Message only — never the full error object, which can carry request
      // metadata including the service-role key.
      console.error(`  ❌ ${label} ${doc._id}: ${err.message}`);
      stats.failed++;
    }
  }

  return stats;
};

async function main() {
  console.log(`base64 → Supabase Storage migration${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);
  console.log(`Bucket: ${BUCKET}`);

  const postConn = await mongoose.createConnection(process.env.POST_MONGO_URI).asPromise();
  const userConn = await mongoose.createConnection(process.env.USER_MONGO_URI).asPromise();

  try {
    const loose = () => new mongoose.Schema({}, { strict: false });
    const Post = postConn.model('Post', loose(), 'posts');
    const User = userConn.model('User', loose(), 'users');

    const posts = await migrate({
      label: 'post', Model: Post, field: 'image', prefix: 'posts', ownerField: 'user',
    });
    const profiles = await migrate({
      label: 'profile', Model: User, field: 'profilePic', prefix: 'profiles',
    });

    console.log('\n── Summary ──');
    console.log(`Posts:    ${posts.migrated} migrated, ${posts.skipped} skipped, ${posts.failed} failed`);
    console.log(`Profiles: ${profiles.migrated} migrated, ${profiles.skipped} skipped, ${profiles.failed} failed`);
    if (DRY_RUN) console.log('\nDry run complete. Re-run without DRY_RUN=1 to apply.');

    if (posts.failed + profiles.failed > 0) process.exitCode = 1;
  } finally {
    await postConn.close();
    await userConn.close();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
