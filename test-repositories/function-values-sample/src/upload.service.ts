import { requireUploadAccess, type Auth } from './access.js';
import { isChecksumConstraint, mimeTypes, onBeforeLink } from './asset.util.js';

export class AssetStore {
  async create(fileName: string): Promise<string> {
    return fileName;
  }
}

// The shape of Immich's `AssetMediaService.uploadAsset`: class-method calls
// alongside calls to arrow-function helpers.
export class UploadService {
  constructor(private readonly store: AssetStore) {}

  async uploadAsset(auth: Auth | null, fileName: string, livePhotoVideoId?: string) {
    const checked = requireUploadAccess(auth);

    if (livePhotoVideoId) {
      await onBeforeLink(livePhotoVideoId);
    }

    if (!mimeTypes.isAsset(fileName)) {
      throw new Error(`Unsupported file for ${checked.userId}`);
    }

    try {
      return await this.store.create(fileName);
    } catch (error) {
      if (isChecksumConstraint(error)) {
        return 'duplicate';
      }
      throw error;
    }
  }
}
