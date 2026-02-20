import type { Bootstrap, PublicBootstrap, User } from "./types";

export async function getPublicBootstrap(): Promise<PublicBootstrap> {
  const res = await fetch("/api/public-bootstrap");
  if (!res.ok) throw new Error("failed to load public bootstrap");
  return res.json();
}

export async function login(username: string, roleId: string): Promise<{ token: string; user: User }> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, roleId })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function bootstrap(token: string): Promise<Bootstrap> {
  const res = await fetch("/api/bootstrap", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("failed to load bootstrap");
  return res.json();
}

export async function logout(token: string): Promise<void> {
  await fetch("/api/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
}

