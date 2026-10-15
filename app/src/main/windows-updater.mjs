import { NsisUpdater } from 'electron-updater';
import { prepareUpdateCache, recordUpdateCache } from './update-cache.mjs';

export class WindowsUpdater extends NsisUpdater {
  async downloadUpdate(cancellationToken) {
    // Keep cache preparation inside the updater's download operation, before
    // its differential planner reads current.blockmap. No install cache moves.
    const helper = await this.getOrCreateDownloadHelper();
    await prepareUpdateCache(helper.cacheDir, this.logger);
    const files = await super.downloadUpdate(cancellationToken);
    await recordUpdateCache(helper.cacheDir, this.installerPath, this.logger);
    return files;
  }
}
