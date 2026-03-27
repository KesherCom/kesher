import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminLogsCard } from "./AdminLogsCard";
import { exportAdminLogsText, getAdminLogs } from "../../api";

vi.mock("../../api", () => ({
  getAdminLogs: vi.fn().mockResolvedValue({
    entries: [
      {
        timestampUnixMs: 1700000000000,
        level: "INFO",
        category: "request",
        message: "http request",
        method: "GET",
        path: "/api/status",
        status: 200,
        username: "tim",
        roleId: "op",
      },
    ],
    total: 1,
    timestampUnixMs: 1700000005000,
  }),
  exportAdminLogsText: vi.fn().mockResolvedValue("line one\nline two\n"),
}));

describe("AdminLogsCard", () => {
  it("loads and renders logs", async () => {
    const user = userEvent.setup();
    render(<AdminLogsCard token="token-123" adminPin="1234" />);

    await user.click(screen.getByRole("button", { name: "Show" }));

    await waitFor(() => {
      expect(getAdminLogs).toHaveBeenCalledWith(
        "token-123",
        "1234",
        expect.objectContaining({
          limit: 100,
          offset: 0,
        }),
      );
    });

    expect(screen.getByText("http request")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "request" })).toBeInTheDocument();
  });

  it("exports logs as txt", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi
      .spyOn(window.URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeObjectURL = vi.spyOn(window.URL, "revokeObjectURL").mockImplementation(() => undefined);

    render(<AdminLogsCard token="token-123" adminPin="1234" />);

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Download TXT" }));

    await waitFor(() => {
      expect(exportAdminLogsText).toHaveBeenCalledWith(
        "token-123",
        "1234",
        expect.objectContaining({
          limit: 100,
          offset: 0,
        }),
      );
    });

    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
