import { useMemo, useState } from "react";

type ChatEntry = {
  from: string;
  fromUserId: string;
  body: string;
  at: string;
  room: string;
  self: boolean;
  scope: "direct" | "room" | "broadcast";
  targetId: string;
  targetType?: "room" | "user" | "role";
  messageId?: string;
  ackRequired?: boolean;
  acked?: boolean;
  ackedBy?: string;
  ackedAt?: string;
  source?: string;
};

type AutocompleteItem = {
  key: string;
  label: string;
  displayLabel: string;
  insertText: string;
  type: "user" | "role" | "room";
};

type ChatSignalPanelProps = {
  message: string;
  onMessageChange: (value: string) => void;
  onSendChat: (ackRequired?: boolean) => void;
  onAcknowledge: (messageId: string, senderUserId: string) => void;
  showAckOption?: boolean;
  chatMessages: ChatEntry[];
  listenRoomIds: string[];
  rooms: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  activeUsers: Array<{
    userId: string;
    username: string;
    roleId: string;
    roleName: string;
    isWebOnline?: boolean;
  }>;
};

function autocompleteContext(value: string, caret: number) {
  const left = value.slice(0, caret);
  const match = left.match(/(^|\s)([@#][^\s@#]*)$/);
  if (!match) {
    return null;
  }
  const token = match[2] || "";
  const trigger = token[0] as "@" | "#";
  const query = token.slice(1).toLowerCase();
  const tokenStart = left.length - token.length;
  return {
    trigger,
    query,
    tokenStart,
    tokenEnd: caret,
  };
}

export function ChatSignalPanel({
  message,
  onMessageChange,
  onSendChat,
  onAcknowledge,
  showAckOption = true,
  chatMessages,
  listenRoomIds,
  rooms,
  roles,
  activeUsers,
}: ChatSignalPanelProps) {
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [caret, setCaret] = useState(message.length);
  const [requiresAck, setRequiresAck] = useState(false);

  function submitChat() {
    onSendChat(showAckOption ? requiresAck : false);
    if (message.trim()) {
      setRequiresAck(false);
    }
  }

  const visibleMessages = useMemo(
    () =>
      chatMessages.filter(
        (entry) => entry.scope !== "room" || listenRoomIds.includes(entry.targetId),
      ),
    [chatMessages, listenRoomIds],
  );

  const suggestions = useMemo(() => {
    const context = autocompleteContext(message, caret);
    if (!context) {
      return [] as AutocompleteItem[];
    }

    // Keep the initial @ list focused on online users, but allow finding
    // external/telegram users once a specific query is typed.
    const onlineUsers = activeUsers.filter((u) => u.isWebOnline !== false);
    const externalUsers = activeUsers.filter((u) => u.isWebOnline === false);

    if (context.trigger === "@") {
      // Build user suggestions (online users only)
      const userItems = onlineUsers
        .filter((u) => u.username.toLowerCase().includes(context.query))
        .map((u) => ({
          key: `user:${u.userId}`,
          label: `👤 @${u.username} [${u.roleName}]`,
          displayLabel: `@${u.username} [${u.roleName}]`,
          insertText: `@${u.username} `,
          type: "user" as const,
        }));

      const externalUserItems =
        context.query.length > 0
          ? externalUsers
              .filter((u) => u.username.toLowerCase().includes(context.query))
              .map((u) => ({
                key: `external-user:${u.userId}`,
                label: `👤 @${u.username} [${u.roleName}] (Telegram/extern)`,
                displayLabel: `@${u.username} [${u.roleName}] (Telegram/extern)`,
                insertText: `@${u.username} `,
                type: "user" as const,
              }))
          : [];

      // Build role suggestions with current occupant or "Unbesetzt"
      const roleItems = roles
        .filter(
          (r) =>
            r.name.toLowerCase().includes(context.query) ||
            r.id.toLowerCase().includes(context.query),
        )
        .map((r) => {
          const occupant = onlineUsers.find((u) => u.roleId === r.id);
          const occupantText = occupant
            ? `Aktuell: ${occupant.username}`
            : "Unbesetzt";
          return {
            key: `role:${r.id}`,
            label: `🎭 @${r.name} (${occupantText})`,
            displayLabel: `@${r.name} (${occupantText})`,
            insertText: `@${r.name} `,
            type: "role" as const,
          };
        });

      return [...userItems, ...externalUserItems, ...roleItems].slice(0, 8);
    }

    // # trigger: rooms/partylines
    return rooms
      .filter(
        (room) =>
          room.name.toLowerCase().includes(context.query) ||
          room.id.toLowerCase().includes(context.query),
      )
      .map((room) => ({
        key: `room:${room.id}`,
        label: `#${room.name}`,
        displayLabel: `#${room.name}`,
        insertText: `#${room.name} `,
        type: "room" as const,
      }))
      .slice(0, 8);
  }, [activeUsers, caret, message, roles, rooms]);

  function applySuggestion(item: AutocompleteItem) {
    const context = autocompleteContext(message, caret);
    if (!context) {
      return;
    }
    const next =
      message.slice(0, context.tokenStart) +
      item.insertText +
      message.slice(context.tokenEnd);
    onMessageChange(next);
    setCaret(context.tokenStart + item.insertText.length);
    setSelectedSuggestion(0);
  }

  function handleSenderReply(username: string) {
    onMessageChange(`@${username} `);
    setCaret(username.length + 2);
  }

  const closeSuggestions = () => {
    setSelectedSuggestion(0);
  };

  return (
    <>
      <div className="chat">
        <input
          value={message}
          onChange={(e) => {
            onMessageChange(e.target.value);
            setCaret(e.target.selectionStart || 0);
            setSelectedSuggestion(0);
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart || 0)}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart || 0)}
          onKeyDown={(e) => {
            if (suggestions.length === 0) {
              if (e.key === "Enter") {
                submitChat();
              }
              return;
            }

            if (e.key === "Escape") {
              e.preventDefault();
              closeSuggestions();
              return;
            }

            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedSuggestion((prev) =>
                prev + 1 >= suggestions.length ? 0 : prev + 1,
              );
              return;
            }

            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedSuggestion((prev) =>
                prev - 1 < 0 ? suggestions.length - 1 : prev - 1,
              );
              return;
            }

            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const selected = suggestions[selectedSuggestion];
              if (selected) {
                applySuggestion(selected);
              }
              return;
            }
          }}
          placeholder="Type chat message…"
        />
        <div className="chat-actions">
          {showAckOption ? (
            <button
              type="button"
              className={`chat-ack-btn ${requiresAck ? "active" : ""}`}
              onClick={() => setRequiresAck(!requiresAck)}
              title={requiresAck ? "ACK required (click to disable)" : "Click to require acknowledgement"}
              aria-label="Requires ACK"
            >
              <span className="chat-ack-indicator" />
            </button>
          ) : null}
          <button type="button" onClick={submitChat}>Send chat</button>
        </div>
        {suggestions.length > 0 ? (
          <ul className="chat-autocomplete" role="listbox" aria-label="chat-autocomplete">
            {suggestions.map((item, idx) => (
              <li key={item.key}>
                <button
                  className={idx === selectedSuggestion ? "active" : ""}
                  onClick={() => applySuggestion(item)}
                  type="button"
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="chat-feed" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <p className="chat-feed-empty">No chat messages yet.</p>
        ) : (
          <ul className="chat-feed-list">
            {visibleMessages.map((entry, index) => (
              <li
                key={`${entry.at}-${entry.from}-${index}`}
                className={
                  entry.scope === "direct"
                    ? `chat-feed-direct ${entry.self ? "self" : ""}`.trim()
                    : entry.self
                      ? "self"
                      : ""
                }
              >
                <div className="chat-feed-meta">
                  <span>{entry.at}</span>
                  <button
                    type="button"
                    className="chat-feed-sender"
                    onClick={() => handleSenderReply(entry.from)}
                  >
                    {entry.from}
                  </button>
                  {entry.source === "telegram" ? (
                    <span className="chat-feed-source-icon" title="Message from Telegram">
                      📱
                    </span>
                  ) : null}
                  <span className="chat-feed-room">{entry.room}</span>
                  {showAckOption && entry.self && entry.ackRequired ? (
                    <span
                      className={`chat-feed-ack-status ${entry.acked ? "acked" : "pending"}`}
                    >
                      {entry.acked
                        ? `ACK by ${entry.ackedBy || "receiver"}`
                        : "ACK pending"}
                    </span>
                  ) : null}
                </div>
                <p>{entry.body}</p>
                {showAckOption &&
                !entry.self &&
                entry.ackRequired &&
                !entry.acked &&
                entry.messageId ? (
                  <button
                    type="button"
                    className="chat-feed-ack-btn"
                    onClick={() => onAcknowledge(entry.messageId || "", entry.fromUserId)}
                  >
                    Acknowledge
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
