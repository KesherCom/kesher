import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatSignalPanel } from "./ChatSignalPanel";

describe("ChatSignalPanel", () => {
  const defaultProps = {
    listenRoomIds: ["foh"],
    rooms: [
      { id: "foh", name: "FOH" },
      { id: "stage", name: "Stage" },
    ],
    roles: [{ id: "audio", name: "Audio" }],
    activeUsers: [
      {
        userId: "u1",
        username: "Sarah",
        roleId: "audio",
        roleName: "Audio",
      },
    ],
  };

  it("shows empty state when no chat messages are present", () => {
    render(
      <ChatSignalPanel
        message=""
        onMessageChange={vi.fn()}
        onSendChat={vi.fn()}
        chatMessages={[]}
        {...defaultProps}
      />,
    );

    expect(screen.getByText("No chat messages yet.")).toBeVisible();
  });

  it("updates message and sends via button and enter", async () => {
    const user = userEvent.setup();
    const onMessageChange = vi.fn();
    const onSendChat = vi.fn();

    render(
      <ChatSignalPanel
        message="hello"
        onMessageChange={onMessageChange}
        onSendChat={onSendChat}
        chatMessages={[]}
        {...defaultProps}
      />,
    );

    await user.type(screen.getByPlaceholderText("Type chat message…"), "!");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Send chat" }));

    expect(onMessageChange).toHaveBeenCalled();
    expect(onSendChat).toHaveBeenCalledTimes(2);
  });

  it("prefills @username when sender is clicked", async () => {
    const user = userEvent.setup();
    const onMessageChange = vi.fn();

    render(
      <ChatSignalPanel
        message=""
        onMessageChange={onMessageChange}
        onSendChat={vi.fn()}
        chatMessages={[
          {
            from: "Sarah",
            fromUserId: "u1",
            body: "Hey",
            at: "10:00",
            room: "Direct",
            self: false,
            scope: "direct",
            targetId: "u2",
            targetType: "user",
          },
        ]}
        {...defaultProps}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sarah" }));
    expect(onMessageChange).toHaveBeenCalledWith("@Sarah ");
  });

  it("filters room messages by current listen rooms but keeps directs", () => {
    render(
      <ChatSignalPanel
        message=""
        onMessageChange={vi.fn()}
        onSendChat={vi.fn()}
        chatMessages={[
          {
            from: "A",
            fromUserId: "u1",
            body: "room keep",
            at: "10:00",
            room: "FOH",
            self: false,
            scope: "room",
            targetId: "foh",
          },
          {
            from: "B",
            fromUserId: "u2",
            body: "room hide",
            at: "10:01",
            room: "Stage",
            self: false,
            scope: "room",
            targetId: "stage",
          },
          {
            from: "C",
            fromUserId: "u3",
            body: "direct keep",
            at: "10:02",
            room: "Direct",
            self: false,
            scope: "direct",
            targetId: "u4",
            targetType: "user",
          },
        ]}
        {...defaultProps}
      />,
    );

    expect(screen.getByText("room keep")).toBeVisible();
    expect(screen.queryByText("room hide")).not.toBeInTheDocument();
    expect(screen.getByText("direct keep")).toBeVisible();
  });
});
