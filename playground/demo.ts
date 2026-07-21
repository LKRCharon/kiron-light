type UserRole = "admin" | "editor" | "viewer";

interface UserProfile {
  id: string;
  name: string;
  role: UserRole;
  createdAt: Date;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const greeting = "hello\nkiron-light";

export async function loadUser(id: string): Promise<UserProfile | null> {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) {
    console.error("Request failed", response.status);
    return null;
  }

  const data = (await response.json()) as UserProfile;
  console.log(JSON.stringify(data, null, 2));
  setTimeout(() => console.info(greeting), DEFAULT_TIMEOUT_MS);
  return data;
}

const roles = new Map<string, UserRole>([
  ["a1", "admin"],
  ["b2", "editor"],
]);

for (const [key, value] of roles.entries()) {
  console.log(key.toUpperCase(), value ?? "viewer");
}
