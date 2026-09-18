export interface User {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}
