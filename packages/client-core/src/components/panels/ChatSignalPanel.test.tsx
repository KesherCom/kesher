import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatSignalPanel } from "./ChatSignalPanel";

type Entry = Parameters<typeof ChatSignalPanel>[0]["chatMessages"][number];

const entry = (overrides: Partial<Entry>): Entry => ({
  from: "Sarah",
  fromUserId: "u1",
  body: "hello",
  at: "10:00",
  room: "FOH",
  self: false,
  scope: "room",
  targetId: "foh",
  ...overrides,
});

describe("ChatSignalPanel", () => {
  const defaultProps = {
    message: "",
    onMessageChange: vi.fn(),
    onSendChat: vi.fn(),
    onAcknowledge: vi.fn(),
    chatMessages: [] as Entry[],
    listenRoomIds: ["foh"],
    rooms: [
      { id: "foh", name: "FOH" },
      { id: "stage", name: "Stage" },
      { id: "lighting", name: "Lighting Booth" },
    ],
    roles: [
      { id: "audio", name: "Audio" },
      { id: "lights", name: "Licht" },
    ],
    activeUsers: [
      {
        userId: "u1",
        username: "Sarah",
        roleId: "audio",
        roleName: "Audio",
        isWebOnline: true,
      },
      {
        userId: "u2",
        username: "Lukas",
        roleId: "lights",
        roleName: "Licht",
        isWebOnline: true,
      },
      {
        userId: "u3",
        username: "TelegramOnly",
        roleId: "audio",
        roleName: "Audio",
        isWebOnline: false,
      },
    ],
    selfUserId: "me",
    defaultRoomId: "foh",
  };

  it("shows the empty state", () => {
    render(<ChatSignalPanel {...defaultProps} />);
    expect(screen.getByText("No chat messages yet.")).toBeVisible();
  });

  it("shows where a message goes before sending: the talk line by default", () => {
    render(<ChatSignalPanel {...defaultProps} />);
    const to = screen.getByRole("combobox", { name: "Send to" });
    expect(to).toHaveDisplayValue("FOH (your talk line)");
  });

  it("sends with Enter and the send button, with or without ask to confirm", async () => {
    const user = userEvent.setup();
    const onSendChat = vi.fn();
    render(
      <ChatSignalPanel
        {...defaultProps}
        message="hello"
        onSendChat={onSendChat}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask to confirm" }));
    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Send chat" }));

    expect(onSendChat).toHaveBeenNthCalledWith(1, true, null);
    expect(onSendChat).toHaveBeenNthCalledWith(2, false, null);
  });

  it("sends to the chosen recipient", async () => {
    const user = userEvent.setup();
    const onSendChat = vi.fn();
    render(
      <ChatSignalPanel
        {...defaultProps}
        message="hi"
        onSendChat={onSendChat}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Send to" }),
      "role:lights",
    );
    await user.click(screen.getByRole("button", { name: "Send chat" }));

    expect(onSendChat).toHaveBeenCalledWith(false, {
      type: "role",
      id: "lights",
    });
  });

  it("does not offer yourself or rooms you cannot write to", () => {
    render(
      <ChatSignalPanel
        {...defaultProps}
        selfUserId="u2"
        writableRoomIds={["foh"]}
      />,
    );
    expect(
      screen.queryByRole("option", { name: "Lukas · Licht" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Sarah · Audio" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Stage" }),
    ).not.toBeInTheDocument();
  });

  it("hides the confirm option when it is turned off", async () => {
    const user = userEvent.setup();
    const onSendChat = vi.fn();
    render(
      <ChatSignalPanel
        {...defaultProps}
        message="hello"
        onSendChat={onSendChat}
        showAckOption={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Ask to confirm" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send chat" }));
    expect(onSendChat).toHaveBeenCalledWith(false, null);
  });

  it("picking a @ suggestion sets the recipient and takes the name out of the text", async () => {
    const user = userEvent.setup();
    const onMessageChange = vi.fn();
    const onSendChat = vi.fn();
    const { rerender } = render(
      <ChatSignalPanel
        {...defaultProps}
        message="@sa"
        onMessageChange={onMessageChange}
        onSendChat={onSendChat}
      />,
    );
    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{End}{Tab}");

    expect(onMessageChange).toHaveBeenLastCalledWith("");
    expect(screen.getByRole("combobox", { name: "Send to" })).toHaveValue(
      "user:u1",
    );

    rerender(
      <ChatSignalPanel
        {...defaultProps}
        message="check mic"
        onMessageChange={onMessageChange}
        onSendChat={onSendChat}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send chat" }));
    expect(onSendChat).toHaveBeenCalledWith(false, { type: "user", id: "u1" });
  });

  it("suggests people with their role and roles with who is online", () => {
    render(<ChatSignalPanel {...defaultProps} message="@" />);
    const list = screen.getByRole("listbox", { name: "chat-autocomplete" });
    expect(list).toHaveTextContent("LukasLicht");
    expect(list).toHaveTextContent("SarahAudio");
    expect(list).toHaveTextContent("AudioRole · Sarah");
    expect(list).toHaveTextContent("LichtRole · Lukas");
    // People only reachable elsewhere appear once something is typed.
    expect(list).not.toHaveTextContent("TelegramOnly");
  });

  it("finds people only on Telegram once a name is typed", () => {
    render(<ChatSignalPanel {...defaultProps} message="@tele" />);
    expect(
      screen.getByRole("listbox", { name: "chat-autocomplete" }),
    ).toHaveTextContent("TelegramOnlyAudio · Telegram");
  });

  it("suggests party lines after #, including names with spaces", () => {
    render(<ChatSignalPanel {...defaultProps} message="#li" />);
    const list = screen.getByRole("listbox", { name: "chat-autocomplete" });
    expect(
      within(list).getByRole("option", { name: /Lighting Booth/ }),
    ).toBeVisible();
  });

  it("keeps suggesting while a name with a space is typed", async () => {
    const user = userEvent.setup();
    const onMessageChange = vi.fn();
    render(
      <ChatSignalPanel
        {...defaultProps}
        message="#lighting bo"
        onMessageChange={onMessageChange}
      />,
    );
    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{End}{Tab}");
    expect(screen.getByRole("combobox", { name: "Send to" })).toHaveValue(
      "room:lighting",
    );
    expect(onMessageChange).toHaveBeenLastCalledWith("");
  });

  it("stops suggesting once the text no longer matches a name", () => {
    render(<ChatSignalPanel {...defaultProps} message="@Sarah check mic" />);
    expect(
      screen.queryByRole("listbox", { name: "chat-autocomplete" }),
    ).not.toBeInTheDocument();
  });

  it("closes the suggestions with Escape", async () => {
    const user = userEvent.setup();
    render(<ChatSignalPanel {...defaultProps} message="@" />);
    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{End}{Escape}");
    expect(
      screen.queryByRole("listbox", { name: "chat-autocomplete" }),
    ).not.toBeInTheDocument();
  });

  it("moves through the suggestions with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<ChatSignalPanel {...defaultProps} message="@" />);
    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{End}");
    const options = () =>
      within(
        screen.getByRole("listbox", { name: "chat-autocomplete" }),
      ).getAllByRole("option", { selected: true });
    // People are sorted by name.
    expect(options()[0]).toHaveTextContent("Lukas");
    await user.keyboard("{ArrowDown}");
    expect(options()[0]).toHaveTextContent("Sarah");
    await user.keyboard("{ArrowUp}");
    expect(options()[0]).toHaveTextContent("Lukas");
  });

  it("shows only party lines you hear, and all direct messages", () => {
    render(
      <ChatSignalPanel
        {...defaultProps}
        chatMessages={[
          entry({ body: "room keep" }),
          entry({ body: "room hide", targetId: "stage", room: "Stage" }),
          entry({
            body: "direct keep",
            scope: "direct",
            targetType: "user",
            targetId: "me",
            room: "Direct",
          }),
        ]}
      />,
    );
    expect(screen.getByText("room keep")).toBeVisible();
    expect(screen.queryByText("room hide")).not.toBeInTheDocument();
    expect(screen.getByText("direct keep")).toBeVisible();
    expect(screen.getByText("to you")).toBeVisible();
  });

  it("always shows your own messages", () => {
    render(
      <ChatSignalPanel
        {...defaultProps}
        chatMessages={[
          entry({ self: true, body: "mine", targetId: "stage", room: "Stage" }),
        ]}
      />,
    );
    expect(screen.getByText("mine")).toBeVisible();
    expect(screen.getByText("to Stage")).toBeVisible();
  });

  it("replies to a sender by making them the recipient", async () => {
    const user = userEvent.setup();
    render(
      <ChatSignalPanel
        {...defaultProps}
        chatMessages={[entry({ from: "Lukas", fromUserId: "u2" })]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Lukas" }));
    expect(screen.getByRole("combobox", { name: "Send to" })).toHaveValue(
      "user:u2",
    );
  });

  it("asks you to confirm a message that waits for it", async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn();
    const { container } = render(
      <ChatSignalPanel
        {...defaultProps}
        onAcknowledge={onAcknowledge}
        chatMessages={[
          entry({
            from: "Regie",
            fromUserId: "u9",
            body: "Standby",
            scope: "direct",
            targetType: "user",
            targetId: "me",
            messageId: "m-1",
            ackRequired: true,
          }),
        ]}
      />,
    );
    expect(container.querySelector(".chat-msg.needs-confirm")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onAcknowledge).toHaveBeenCalledWith("m-1", "u9");
  });

  it("shows whether your message was confirmed", () => {
    render(
      <ChatSignalPanel
        {...defaultProps}
        chatMessages={[
          entry({
            self: true,
            body: "Go",
            messageId: "m-2",
            ackRequired: true,
            acked: true,
            ackedBy: "Sarah",
          }),
          entry({
            self: true,
            body: "Ready?",
            messageId: "m-3",
            ackRequired: true,
          }),
        ]}
      />,
    );
    expect(screen.getByText("Confirmed by Sarah")).toBeVisible();
    expect(screen.getByText("Waiting for confirmation")).toBeVisible();
  });

  it("hides confirm states when the option is turned off", () => {
    render(
      <ChatSignalPanel
        {...defaultProps}
        showAckOption={false}
        chatMessages={[
          entry({
            self: true,
            messageId: "m-2",
            ackRequired: true,
            acked: true,
            ackedBy: "Sarah",
          }),
          entry({
            from: "Regie",
            fromUserId: "u9",
            scope: "direct",
            targetType: "user",
            targetId: "me",
            messageId: "m-4",
            ackRequired: true,
          }),
        ]}
      />,
    );
    expect(screen.queryByText("Confirmed by Sarah")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm" }),
    ).not.toBeInTheDocument();
  });

  it("marks messages from Telegram", () => {
    render(
      <ChatSignalPanel
        {...defaultProps}
        chatMessages={[entry({ source: "telegram" })]}
      />,
    );
    expect(screen.getByTitle("Message from Telegram")).toHaveTextContent(
      "via Telegram",
    );
  });

  it("shows why a message was not delivered and lets you dismiss it", async () => {
    const user = userEvent.setup();
    const onDismissNotice = vi.fn();
    render(
      <ChatSignalPanel
        {...defaultProps}
        notice="Not delivered: party line not found."
        onDismissNotice={onDismissNotice}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not delivered: party line not found.",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissNotice).toHaveBeenCalled();
  });
});
