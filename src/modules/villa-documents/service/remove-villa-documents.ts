import { logger } from "../../../core/config/logger.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import type { StorageService } from "../../../core/storage/StorageService.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Removes a deleted villa's folder from disk. The database rows are already gone (they cascade), so this
// runs after that transaction commits and must never fail the delete: a disk problem is only logged, and
// the leftover folder `villas/<id>` is an orphan to clean up by hand.
export async function removeVillaDocuments(
  villaId: string,
  storage: StorageService = new LocalDiskStorage(),
): Promise<void> {
  try {
    if (!UUID.test(villaId)) {
      return;
    }
    await storage.deleteDirectory(`villas/${villaId}`);
  } catch (err) {
    logger.warn({ err, villaId }, "could not remove a deleted villa's files from disk; they are now orphans");
  }
}
