import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  bootstrap,
  createRole,
  getPublicBootstrap,
  login,
  logout,
} from "./api";

const server = setupServer(
  http.get("http://localhost/api/public-bootstrap", () => {
    return HttpResponse.json({
      roles: [{ id: "op", name: "Operator" }],
      rooms: [],
      broadcastGroups: [],
    });
  }),
  http.post("http://localhost/api/login", async ({ request }) => {
    const body = (await request.json()) as { username: string; roleId: string };
    if (!body.username || !body.roleId) {
      return new HttpResponse("missing fields", { status: 400 });
    }
    return HttpResponse.json({
      token: "token-123",
      user: { id: "u1", username: body.username, roleId: body.roleId },
    });
  }),
  http.get("http://localhost/api/bootstrap", ({ request }) => {
    const auth = request.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return new HttpResponse("unauthorized", { status: 401 });
    }
    return HttpResponse.json({
      self: { id: "u1", username: "Tim", roleId: "op" },
      users: [],
      roles: [],
      rooms: [],
      broadcastGroups: [],
    });
  }),
  http.post(
    "http://localhost/api/logout",
    () => new HttpResponse(null, { status: 204 }),
  ),
  http.post("http://localhost/api/admin/roles", async ({ request }) => {
    const auth = request.headers.get("authorization");
    const body = (await request.json()) as { id?: string; name?: string };
    if (!auth) return new HttpResponse("unauthorized", { status: 401 });
    if (!body.id || !body.name)
      return new HttpResponse("invalid", { status: 400 });
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("api helpers", () => {
  it("loads public bootstrap", async () => {
    const data = await getPublicBootstrap();
    expect(data.roles).toHaveLength(1);
    expect(data.roles[0]?.id).toBe("op");
  });

  it("logs in and returns token + user", async () => {
    const result = await login("Tim", "op");
    expect(result.token).toBe("token-123");
    expect(result.user.username).toBe("Tim");
  });

  it("loads authenticated bootstrap", async () => {
    const data = await bootstrap("token-123");
    expect(data.self.id).toBe("u1");
  });

  it("can execute logout", async () => {
    await expect(logout("token-123")).resolves.toBeUndefined();
  });

  it("throws server error body for mutation helper", async () => {
    server.use(
      http.post("http://localhost/api/admin/roles", () => {
        return new HttpResponse("role exists", { status: 409 });
      }),
    );
    await expect(
      createRole("token-123", { id: "op", name: "Operator" }),
    ).rejects.toThrow("role exists");
  });
});
