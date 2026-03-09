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
};

type AutocompleteItem = {
  key: string;
  label: string;
  insertText: string;
};

type ChatSignalPanelProps = {
  message: string;
  onMessageChange: (value: string) => void;
  onSendChat: () => void;
  chatMessages: ChatEntry[];
  listenRoomIds: string[];
  rooms: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  activeUsers: Array<{
    userId: string;
    username: string;
    roleId: string;
    roleName: string;
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
  chatMessages,
  listenRoomIds,
  rooms,
  roles,
  activeUsers,
}: ChatSignalPanelProps) {
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [caret, setCaret] = useState(message.length);

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
    if (context.trigger === "@") {
      const userItems = activeUsers
        .filter((u) => u.username.toLowerCase().includes(context.query))
        .map((u) => ({
          key: `user:${u.userId}`,
          label: `${u.username} [${u.roleName}]`,
          insertText: `@${u.username} `,
        }));
      const roleItems = roles
        .filter(
          (r) =>
            r.name.toLowerCase().includes(context.query) ||
            r.id.toLowerCase().includes(context.query),
        )
        .map((r) => ({
          key: `role:${r.id}`,
          label: `Rolle: ${r.name}`,
          insertText: `@${r.id} `,
        }));
      return [...userItems, ...roleItems].slice(0, 8);
    }
    return rooms
      .filter(
        (room) =>
          room.name.toLowerCase().includes(context.query) ||
          room.id.toLowerCase().includes(context.query),
      )
      .map((room) => ({
        key: `room:${room.id}`,
        label: `${room.name} (#${room.id})`,
        insertText: `#${room.id} `,
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
            if (suggestions.length > 0 && e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedSuggestion((prev) =>
                prev + 1 >= suggestions.length ? 0 : prev + 1,
              );
              return;
            }
            if (suggestions.length > 0 && e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedSuggestion((prev) =>
                prev - 1 < 0 ? suggestions.length - 1 : prev - 1,
              );
              return;
            }
            if (suggestions.length > 0 && e.key === "Enter") {
              e.preventDefault();
              const selected = suggestions[selectedSuggestion] || suggestions[0];
              if (selected) {
                applySuggestion(selected);
              }
              return;
            }
            if (e.key === "Enter") {
              onSendChat();
            }
          }}
          placeholder="Type chat message…"
        />
        <button onClick={onSendChat}>Send chat</button>
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
                  <span className="chat-feed-room">{entry.room}</span>
                </div>
                <p>{entry.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
