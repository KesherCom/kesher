import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoginView } from "./LoginView";

const baseProps = {
  publicData: {
    roles: [
      { id: "op", name: "Operator" },
      { id: "admin", name: "Admin" },
    ],
    rooms: [],
    broadcastGroups: [],
  },
  username: "",
  roleId: "",
  onUsernameChange: vi.fn(),
  onRoleChange: vi.fn(),
  onLogin: vi.fn(),
  adminPin: "",
  onAdminPinChange: vi.fn(),
  onAdminLogin: vi.fn(),
};

describe("LoginView", () => {
  it("disables join button until username and role are present", () => {
    const { rerender } = render(<LoginView {...baseProps} />);
    expect(
      screen.getByRole("button", { name: "Join Intercom" }),
    ).toBeDisabled();

    rerender(<LoginView {...baseProps} username="Tim" roleId="op" />);
    expect(screen.getByRole("button", { name: "Join Intercom" })).toBeEnabled();
  });

  it("calls callbacks when typing/selecting and joining", async () => {
    const user = userEvent.setup();
    const onUsernameChange = vi.fn();
    const onRoleChange = vi.fn();
    const onLogin = vi.fn();

    render(
      <LoginView
        {...baseProps}
        username="Tim"
        roleId="op"
        onUsernameChange={onUsernameChange}
        onRoleChange={onRoleChange}
        onLogin={onLogin}
      />,
    );

    await user.type(screen.getByLabelText("Display name"), " A");
    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    await user.click(screen.getByRole("button", { name: "Join Intercom" }));

    expect(onUsernameChange).toHaveBeenCalled();
    expect(onRoleChange).toHaveBeenCalledWith("admin");
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("toggles admin panel and handles admin login action", async () => {
    const user = userEvent.setup();
    const onAdminPinChange = vi.fn();
    const onAdminLogin = vi.fn();

    render(
      <LoginView
        {...baseProps}
        adminPin="1234"
        adminError="Wrong PIN"
        onAdminPinChange={onAdminPinChange}
        onAdminLogin={onAdminLogin}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show admin" }));
    expect(
      screen.getByRole("heading", { name: "Admin console" }),
    ).toBeVisible();
    expect(screen.getByText("Wrong PIN")).toBeVisible();

    await user.type(screen.getByLabelText("Admin PIN"), "5");
    await user.click(
      screen.getByRole("button", { name: "Open admin console" }),
    );
    expect(onAdminPinChange).toHaveBeenCalled();
    expect(onAdminLogin).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(
      screen.queryByRole("heading", { name: "Admin console" }),
    ).not.toBeInTheDocument();
  });
});
