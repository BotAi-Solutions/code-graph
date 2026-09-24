// The shape of Immich's `src/utils/access.ts`: exported arrow-function helpers
// that call each other.

export interface Auth {
  userId: string;
  permissions: string[];
  sharedLink?: { allowUpload: boolean };
}

export const isGranted = ({ requested, current }: { requested: string[]; current: string[] }) =>
  requested.every((permission) => current.includes(permission));

export const requireUploadAccess = (auth: Auth | null): Auth => {
  if (!auth || (auth.sharedLink && !auth.sharedLink.allowUpload)) {
    throw new Error('Forbidden');
  }
  return auth;
};

export const checkAccess = async (auth: Auth, ids: string[]): Promise<Set<string>> => {
  if (!isGranted({ requested: ['read'], current: auth.permissions })) {
    return new Set();
  }
  return new Set(ids);
};

export const requireAccess = async (auth: Auth, ids: string[]) => {
  const allowed = await checkAccess(auth, ids);
  if (allowed.size !== ids.length) {
    throw new Error('Not found or no access');
  }
};
