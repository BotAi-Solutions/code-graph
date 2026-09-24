// The shape of Immich's asset helpers used by the upload flow.

export const onBeforeLink = async (livePhotoVideoId: string) => {
  if (!livePhotoVideoId) {
    throw new Error('Invalid live photo');
  }
  return livePhotoVideoId;
};

export const isChecksumConstraint = (error: unknown) =>
  (error as { constraint?: string })?.constraint === 'UQ_owner_checksum';

export const mimeTypes = {
  isAsset: (fileName: string) => fileName.endsWith('.jpg'),
};
