/**
 * `npm run cleanup:media` — collect expired drafts and released assets.
 *
 * This is the backing for the product's "24 hours" promise. It deliberately
 * asks the database, not the filesystem: a filename is not a reference count,
 * and scanning the media directory for old-looking files would delete something
 * a message still points at.
 */

import { log } from '../observability/logging.ts';
import { selectStore } from '../db/select.ts';
import { FileMediaBlobStore } from '../media/blob-store.ts';
import { mediaRoot } from '../media/config.ts';
import { mediaLimits } from '../media/limits.ts';
import { MediaService } from '../media/service.ts';

async function main(): Promise<void> {
  const { store, kind, detail } = await selectStore();
  try {
    const limits = mediaLimits();
    const media = new MediaService({
      store,
      blobs: new FileMediaBlobStore(mediaRoot()),
      limits,
    });
    const result = await media.collect();
    process.stdout.write(
      `\nstore: ${kind} · ${detail}\n` +
        `media: ${result.removed} expired draft/released asset(s) removed` +
        ` · grace ${Math.round(limits.unboundGraceMs / 3_600_000)}h\n\n`,
    );
    log.info('media.cleanup', { removed: result.removed, store: kind });
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log.error('media.cleanup_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
