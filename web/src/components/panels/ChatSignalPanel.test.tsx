import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatSignalPanel } from "./ChatSignalPanel";

describe("ChatSignalPanel", () => {
  it("shows empty state when no chat messages are present", () => {
    render(
      <ChatSignalPanel
        message=""
        onMessageChange={vi.fn()}
        onSendChat={vi.fn()}
        chatMessages={[]}
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
      />,
    );

    await user.type(screen.getByPlaceholderText("Type chat message…"), "!");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Send chat" }));

    expect(onMessageChange).toHaveBeenCalled();
    expect(onSendChat).toHaveBeenCalledTimes(2);
  });
});
