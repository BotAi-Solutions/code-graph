export type UserRole = 'admin' | 'member' | 'guest';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
}

export interface UserDraft {
  email: string;
  displayName: string;
  role?: UserRole;
}

export function createUser(id: string, draft: UserDraft): User {
  return {
    id,
    email: draft.email.trim().toLowerCase(),
    displayName: draft.displayName.trim(),
    role: draft.role ?? 'member',
    createdAt: new Date().toISOString(),
  };
}

export function isAdmin(user: User): boolean {
  return user.role === 'admin';
}
