// #1531 Part 7 — where the last-good copy lives, shared by the Worker writer and the Edge reader.
// Kept apart from `last-good-copy.ts` so the Edge does not bundle the Vercel Blob SDK.

export const LAST_GOOD_COPY_PATH = 'is-down/status.json'
export const LAST_GOOD_COPY_URL = `https://j4d16uwputruseax.public.blob.vercel-storage.com/${LAST_GOOD_COPY_PATH}`
