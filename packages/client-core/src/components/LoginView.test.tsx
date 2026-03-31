import { useState } from "react";
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
    ackEnabled: true,
    appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
  },
  username: "",
  roleId: "",
  onUsernameChange: vi.fn(),
  onRoleChange: vi.fn(),
  onLogin: vi.fn(),
  loginError: "",
  adminPin: "",
  onAdminPinChange: vi.fn(),
  onAdminLogin: vi.fn(),
  takeoverConflict: null,
  onConfirmTakeover: vi.fn(),
  onCancelTakeover: vi.fn(),
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

  it("shows operator login error in the main login form", () => {
    render(
      <LoginView
        {...baseProps}
        username="Tim"
        roleId="op"
        loginError="Die Rolle Operator ist bereits angemeldet."
      />,
    );

    expect(
      screen.getByText("Die Rolle Operator ist bereits angemeldet."),
    ).toBeVisible();
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

  it("strips whitespace from display name while typing", async () => {
    const user = userEvent.setup();
    const onUsernameChange = vi.fn();

    function Harness() {
      const [username, setUsername] = useState("");
      return (
        <LoginView
          {...baseProps}
          username={username}
          roleId="op"
          onUsernameChange={(value) => {
            onUsernameChange(value);
            setUsername(value);
          }}
        />
      );
    }

    render(<Harness />);

    await user.type(screen.getByLabelText("Display name"), "Tim FOH");
    expect(onUsernameChange).toHaveBeenLastCalledWith("TimFOH");
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

  it("renders and handles takeover confirmation controls", async () => {
    const user = userEvent.setup();
    const onConfirmTakeover = vi.fn();
    const onCancelTakeover = vi.fn();

    render(
      <LoginView
        {...baseProps}
        takeoverConflict={{
          requiresTakeover: true,
          conflictRoleId: "op",
          conflictRoleName: "Operator",
          conflictUsername: "Alex",
        }}
        onConfirmTakeover={onConfirmTakeover}
        onCancelTakeover={onCancelTakeover}
      />,
    );

    expect(screen.getByText(/Role currently in use/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm takeover" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirmTakeover).toHaveBeenCalledTimes(1);
    expect(onCancelTakeover).toHaveBeenCalledTimes(1);
  });
});
