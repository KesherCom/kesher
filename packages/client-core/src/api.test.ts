import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  adminLogin,
  bootstrap,
  buildAbsoluteApiUrl,
  buildWebSocketUrl,
  createRole,
  exportConfiguration,
  getPublicBootstrap,
  getStreamDeckSettings,
  importConfiguration,
  login,
  loginTakeover,
  logout,
  normalizeServerAddressInput,
  renderStreamDeckPreviewImages,
  resetStreamDeckSettings,
  setGlobalApiBaseUrl,
  updateStreamDeckSettings,
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
  http.post("http://localhost/api/login/takeover", async ({ request }) => {
    const body = (await request.json()) as { username: string; roleId: string };
    return HttpResponse.json({
      token: "token-takeover",
      user: { id: "u1", username: body.username, roleId: body.roleId },
    });
  }),
  http.post("http://localhost/api/admin/login", async ({ request }) => {
    const body = (await request.json()) as { pin: string };
    if (!body.pin) {
      return new HttpResponse("forbidden", { status: 403 });
    }
    return HttpResponse.json({
      token: "admin-token",
      user: { id: "", username: "admin", roleId: "" },
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
    const adminPin = request.headers.get("x-admin-pin");
    const body = (await request.json()) as { id?: string; name?: string };
    if (!auth) return new HttpResponse("unauthorized", { status: 401 });
    if (!adminPin) return new HttpResponse("forbidden", { status: 403 });
    if (!body.id || !body.name)
      return new HttpResponse("invalid", { status: 400 });
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("http://localhost/api/admin/configuration-export", () => {
    return HttpResponse.json({
      meta: {
        format: "kesher-showfile",
        schemaVersion: 1,
        exportedAt: "2026-03-14T12:00:00Z",
        sourceVersion: { version: "test", buildTimestamp: "2026-03-14T12:00:00Z" },
        sections: [
          "roles",
          "users",
          "rooms",
          "broadcastGroups",
          "telegramAllowlist",
          "ackSettings",
          "streamDeckSettings",
        ],
      },
      roles: [{ id: "op", name: "Operator" }],
      users: [{ username: "tim", roleId: "op" }],
      rooms: [],
      broadcastGroups: [],
      telegramAllowlist: [
        {
          id: "allow-1",
          telegramUsername: "tim_telegram",
          telegramNumericId: "",
          kesherUsername: "tim",
          createdAt: 0,
          status: "Pending",
          isBound: false,
        },
      ],
      ackSettings: { enabled: true },
      streamDeckSettings: [],
    });
  }),
  http.post("http://localhost/api/admin/configuration-import", async ({ request }) => {
    const body = (await request.json()) as {
      document?: { meta?: { format?: string } };
      sections?: string[];
    };
    if (!body.document?.meta?.format || !body.sections?.length) {
      return new HttpResponse("invalid", { status: 400 });
    }
    return HttpResponse.json({ importedSections: body.sections });
  }),
  http.get("http://localhost/api/user/stream-deck/settings", () => {
    return HttpResponse.json({
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [
        {
          page: 0,
          buttons: [{ index: 0, action: { type: "reply_to_caller" } }],
        },
      ],
    });
  }),
  http.put("http://localhost/api/user/stream-deck/settings", async ({ request }) => {
    const body = (await request.json()) as {
      gridColumns?: number;
      gridRows?: number;
    };
    if (body.gridColumns !== 5 || body.gridRows !== 3) {
      return new HttpResponse("invalid", { status: 400 });
    }
    return HttpResponse.json(body);
  }),
  http.delete("http://localhost/api/user/stream-deck/settings", () => {
    return HttpResponse.json({
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [{ page: 0, buttons: [{ index: 0 }] }],
    });
  }),
  http.post("http://localhost/api/user/stream-deck/preview", async ({ request }) => {
    const body = (await request.json()) as {
      buttons?: Array<{ buttonIndex: number }>;
    };
    const buttons = Array.isArray(body.buttons) ? body.buttons : [];
    return HttpResponse.json({
      width: 112,
      height: 112,
      images: buttons.map((entry) => ({
        buttonIndex: entry.buttonIndex,
        imageBuffer: "iVBORw0KGgo=",
      })),
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("api helpers", () => {
  afterEach(() => {
    setGlobalApiBaseUrl("");
  });

  it("builds absolute API URL from browser origin when no desktop base is configured", () => {
    expect(buildAbsoluteApiUrl("/api/telegram/webhook")).toBe(
      "http://localhost/api/telegram/webhook",
    );
  });

  it("builds absolute API URL from configured desktop base", () => {
    setGlobalApiBaseUrl("http://192.168.1.50:8080");
    expect(buildAbsoluteApiUrl("/api/telegram/webhook")).toBe(
      "http://192.168.1.50:8080/api/telegram/webhook",
    );
  });

  it("builds websocket URL from configured desktop base", () => {
    setGlobalApiBaseUrl("https://intercom.example.org");
    expect(buildWebSocketUrl("/ws", { token: "abc" })).toBe(
      "wss://intercom.example.org/ws?token=abc",
    );
  });

  it("preserves explicitly configured custom port", () => {
    expect(normalizeServerAddressInput("192.168.1.50:8090")).toBe(
      "http://192.168.1.50:8090",
    );
  });

  it("does not force default port when none is configured", () => {
    expect(normalizeServerAddressInput("server.local")).toBe(
      "http://server.local",
    );
  });

  it("loads public bootstrap", async () => {
    const data = await getPublicBootstrap();
    expect(data.roles).toHaveLength(1);
    expect(data.roles[0]?.id).toBe("op");
  });

  it("logs in and returns token + user", async () => {
    const result = await login("Tim", "op");
    if ("requiresTakeover" in result) {
      throw new Error("expected successful login payload");
    }
    expect(result.token).toBe("token-123");
    expect(result.user.username).toBe("Tim");
  });

  it("executes takeover login", async () => {
    const result = await loginTakeover("Tim", "op");
    expect(result.token).toBe("token-takeover");
  });

  it("executes admin login without role", async () => {
    const result = await adminLogin("123456");
    expect(result.token).toBe("admin-token");
    expect(result.user.roleId).toBe("");
  });

  it("loads authenticated bootstrap", async () => {
    const data = await bootstrap("token-123");
    expect(data.self.id).toBe("u1");
  });

  it("normalizes nullable list fields from bootstrap payloads", async () => {
    server.use(
      http.get("http://localhost/api/public-bootstrap", () =>
        HttpResponse.json({
          roles: null,
          rooms: null,
          broadcastGroups: null,
        }),
      ),
      http.get("http://localhost/api/bootstrap", () =>
        HttpResponse.json({
          self: { id: "u1", username: "Tim", roleId: "op" },
          users: null,
          roles: null,
          rooms: [
            {
              id: "r1",
              name: "Party Line 1",
              senderRoleIds: null,
              receiverRoleIds: null,
            },
          ],
          broadcastGroups: [
            {
              id: "bg1",
              name: "All",
              roomIds: null,
              allowedRoleIds: null,
            },
          ],
        }),
      ),
    );

    const publicData = await getPublicBootstrap();
    expect(publicData.roles).toEqual([]);
    expect(publicData.rooms).toEqual([]);
    expect(publicData.broadcastGroups).toEqual([]);

    const appData = await bootstrap("token-123");
    expect(appData.users).toEqual([]);
    expect(appData.roles).toEqual([]);
    expect(appData.rooms[0]?.senderRoleIds).toEqual([]);
    expect(appData.rooms[0]?.receiverRoleIds).toEqual([]);
    expect(appData.broadcastGroups[0]?.roomIds).toEqual([]);
    expect(appData.broadcastGroups[0]?.allowedRoleIds).toEqual([]);
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
      createRole("token-123", "1234", { id: "op", name: "Operator" }),
    ).rejects.toThrow("role exists");
  });

  it("loads configuration export documents", async () => {
    const document = await exportConfiguration("token-123", "123456");
    expect(document.meta.format).toBe("kesher-showfile");
    expect(document.users[0]?.username).toBe("tim");
    expect(document.telegramAllowlist[0]?.telegramUsername).toBe(
      "tim_telegram",
    );
    expect(document.ackSettings?.enabled).toBe(true);
  });

  it("posts configuration imports with selected sections", async () => {
    const response = await importConfiguration(
      "token-123",
      "123456",
      {
        meta: {
          format: "kesher-showfile",
          schemaVersion: 1,
          exportedAt: "2026-03-14T12:00:00Z",
          sourceVersion: {
            version: "test",
            buildTimestamp: "2026-03-14T12:00:00Z",
          },
          sections: [
            "roles",
            "users",
            "rooms",
            "broadcastGroups",
            "telegramAllowlist",
            "ackSettings",
            "streamDeckSettings",
          ],
        },
        roles: [],
        users: [],
        rooms: [],
        broadcastGroups: [],
        telegramAllowlist: [],
        ackSettings: { enabled: true },
        streamDeckSettings: [],
      },
      ["roles", "rooms"],
    );
    expect(response.importedSections).toEqual(["roles", "rooms"]);
  });

  it("loads stream deck settings", async () => {
    const settings = await getStreamDeckSettings("token-123");
    expect(settings.gridColumns).toBe(5);
    expect(settings.pages[0]?.buttons[0]?.action?.type).toBe("reply_to_caller");
  });

  it("updates stream deck settings", async () => {
    const settings = {
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [{ page: 0, buttons: [{ index: 0, action: { type: "reply_to_caller" as const } }] }],
    };
    const updated = await updateStreamDeckSettings("token-123", settings);
    expect(updated.gridRows).toBe(3);
    expect(updated.pages[0]?.buttons[0]?.action?.type).toBe("reply_to_caller");
  });

  it("resets stream deck settings", async () => {
    const reset = await resetStreamDeckSettings("token-123");
    expect(reset.gridColumns).toBe(5);
    expect(reset.pages[0]?.page).toBe(0);
  });

  it("keeps page navigation actions when loading stream deck settings", async () => {
    server.use(
      http.get("http://localhost/api/user/stream-deck/settings", () => {
        return HttpResponse.json({
          version: 1,
          gridColumns: 5,
          gridRows: 3,
          selectedPage: 0,
          pages: [
            {
              page: 0,
              buttons: [{ index: 0, action: { type: "page_up" } }],
            },
          ],
        });
      }),
    );

    const settings = await getStreamDeckSettings("token-123");
    expect(settings.pages[0]?.buttons[0]?.action?.type).toBe("page_up");
  });

  it("renders stream deck preview images", async () => {
    const images = await renderStreamDeckPreviewImages("token-123", {
      width: 112,
      height: 112,
      buttons: [
        {
          buttonIndex: 0,
          label: "Reply",
          subtitle: "Caller",
          actionType: "reply_to_caller",
          state: "TALK",
          isActive: true,
        },
      ],
    });
    expect(images.get(0)).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});
