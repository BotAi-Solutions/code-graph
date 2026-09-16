export type UserRole = 'admin' | 'member' | 'guest';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role?: UserRole;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: Date;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as UserRole,
    createdAt: row.created_at.toISOString(),
  };
}

export function isAdmin(user: User): boolean {
  return user.role === 'admin';
}
