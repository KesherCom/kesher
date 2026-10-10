import { useMemo, useState } from "react";
import type { ChatRecipient } from "../../types";
import { Icon, type IconName } from "../Icon";

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

type Suggestion = {
  key: string;
  recipient: ChatRecipient;
  name: string;
  detail: string;
  icon: IconName;
};

type ChatSignalPanelProps = {
  message: string;
  onMessageChange: (value: string) => void;
  onSendChat: (ackRequired: boolean, recipient: ChatRecipient | null) => void;
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
  /** Your own user ID: you are not offered as a recipient. */
  selfUserId?: string;
  /** Party lines you may write to (default: all). */
  writableRoomIds?: string[];
  /** Your talk line: where a message goes when no recipient is chosen. */
  defaultRoomId?: string;
  /** Why the last message was not delivered. */
  notice?: string;
  onDismissNotice?: () => void;
};

const recipientKey = (r: ChatRecipient | null) =>
  r ? `${r.type}:${r.id}` : "";

function parseRecipientKey(key: string): ChatRecipient | null {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  if (!id || (type !== "room" && type !== "user" && type !== "role")) {
    return null;
  }
  return { type, id };
}

/**
 * The "@sar" or "#lighting bo" being typed at the caret, if any. It may
 * contain spaces (names can); it only counts while a name still matches.
 */
function mentionAt(value: string, caret: number) {
  const left = value.slice(0, caret);
  const match = left.match(/(^|\s)([@#][^@#\n]*)$/);
  if (!match) return null;
  const token = match[2] || "";
  return {
    trigger: token[0] as "@" | "#",
    query: token.slice(1).toLowerCase(),
    start: left.length - token.length,
    end: caret,
  };
}

/**
 * The chat: who it goes to (shown before you send), the message, an
 * optional "ask to confirm", and the feed, newest first. Typing "@" or "#"
 * suggests people, roles and party lines; picking one sets the recipient.
 */
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
  selfUserId = "",
  writableRoomIds,
  defaultRoomId = "",
  notice = "",
  onDismissNotice,
}: ChatSignalPanelProps) {
  const [recipient, setRecipient] = useState<ChatRecipient | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [suggestionsClosed, setSuggestionsClosed] = useState(false);
  const [caret, setCaret] = useState(message.length);
  const [askToConfirm, setAskToConfirm] = useState(false);

  const writableRooms = useMemo(
    () =>
      writableRoomIds
        ? rooms.filter((room) => writableRoomIds.includes(room.id))
        : rooms,
    [rooms, writableRoomIds],
  );
  const people = useMemo(
    () =>
      activeUsers
        .filter((u) => u.userId !== selfUserId)
        .sort((a, b) => a.username.localeCompare(b.username)),
    [activeUsers, selfUserId],
  );
  const roomName = (id: string) =>
    rooms.find((room) => room.id === id)?.name || id;
  const roleName = (id: string) =>
    roles.find((role) => role.id === id)?.name || id;
  const personName = (id: string) =>
    activeUsers.find((u) => u.userId === id)?.username || "";

  // Party line messages show for the lines you hear; your own and direct
  // messages always.
  const visibleMessages = useMemo(
    () =>
      chatMessages.filter(
        (entry) =>
          entry.self ||
          entry.scope !== "room" ||
          listenRoomIds.includes(entry.targetId),
      ),
    [chatMessages, listenRoomIds],
  );

  const mention = mentionAt(message, caret);
  const suggestions = useMemo(() => {
    if (!mention || suggestionsClosed) return [] as Suggestion[];
    const q = mention.query;
    if (mention.trigger === "#") {
      return writableRooms
        .filter(
          (room) =>
            room.name.toLowerCase().includes(q) ||
            room.id.toLowerCase().includes(q),
        )
        .map((room) => ({
          key: `room:${room.id}`,
          recipient: { type: "room" as const, id: room.id },
          name: room.name,
          detail: "Party line",
          icon: "headphones" as const,
        }))
        .slice(0, 8);
    }
    // People online in the app first; people reachable only elsewhere
    // (e.g. Telegram) once something is typed.
    const personItems = people
      .filter(
        (u) =>
          u.username.toLowerCase().includes(q) &&
          (u.isWebOnline !== false || q.length > 0),
      )
      .map((u) => ({
        key: `user:${u.userId}`,
        recipient: { type: "user" as const, id: u.userId },
        name: u.username,
        detail:
          u.isWebOnline === false ? `${u.roleName} · Telegram` : u.roleName,
        icon: "user" as const,
      }));
    const roleItems = roles
      .filter(
        (r) =>
          r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
      )
      .map((r) => {
        const online = [
          ...new Set(
            people
              .filter((u) => u.roleId === r.id && u.isWebOnline !== false)
              .map((u) => u.username),
          ),
        ];
        return {
          key: `role:${r.id}`,
          recipient: { type: "role" as const, id: r.id },
          name: r.name,
          detail: online.length
            ? `Role · ${online.join(", ")}`
            : "Role · nobody online",
          icon: "user" as const,
        };
      });
    return [...personItems, ...roleItems].slice(0, 8);
  }, [mention, suggestionsClosed, writableRooms, people, roles]);

  function pickSuggestion(item: Suggestion) {
    if (!mention) return;
    // The name becomes the recipient; it leaves the text.
    const next = (
      message.slice(0, mention.start) + message.slice(mention.end)
    ).replace(/^\s+/, "");
    setRecipient(item.recipient);
    onMessageChange(next);
    setCaret(mention.start);
    setSelectedSuggestion(0);
  }

  function send() {
    onSendChat(showAckOption ? askToConfirm : false, recipient);
    if (message.trim()) setAskToConfirm(false);
  }

  const defaultLabel = defaultRoomId
    ? `${roomName(defaultRoomId)} (your talk line)`
    : "Your talk line";
  const chosenIsListed =
    !recipient ||
    (recipient.type === "room" &&
      writableRooms.some((r) => r.id === recipient.id)) ||
    (recipient.type === "user" &&
      people.some((u) => u.userId === recipient.id)) ||
    (recipient.type === "role" && roles.some((r) => r.id === recipient.id));

  const targetLabel = (entry: ChatEntry) => {
    if (entry.scope !== "direct") return entry.room;
    if (entry.targetType === "role") return roleName(entry.targetId);
    if (entry.self) return personName(entry.targetId) || "person";
    return "you";
  };

  return (
    <>
      <div className="chat">
        <label className="chat-to">
          <span>To</span>
          <select
            aria-label="Send to"
            value={recipientKey(recipient)}
            onChange={(event) =>
              setRecipient(parseRecipientKey(event.target.value))
            }
          >
            <option value="">{defaultLabel}</option>
            {!chosenIsListed && recipient ? (
              <option value={recipientKey(recipient)}>
                {recipient.type === "room"
                  ? roomName(recipient.id)
                  : recipient.type === "role"
                    ? roleName(recipient.id)
                    : personName(recipient.id) || "Person"}
              </option>
            ) : null}
            {writableRooms.length ? (
              <optgroup label="Party lines">
                {writableRooms.map((room) => (
                  <option key={room.id} value={`room:${room.id}`}>
                    {room.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {people.length ? (
              <optgroup label="People">
                {people.map((u) => (
                  <option key={u.userId} value={`user:${u.userId}`}>
                    {u.username} · {u.roleName}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {roles.length ? (
              <optgroup label="Roles">
                {roles.map((r) => (
                  <option key={r.id} value={`role:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <div className="chat-compose">
          <input
            aria-label="Message"
            value={message}
            onChange={(e) => {
              onMessageChange(e.target.value);
              setCaret(e.target.selectionStart || 0);
              setSelectedSuggestion(0);
              setSuggestionsClosed(false);
            }}
            onClick={(e) => setCaret(e.currentTarget.selectionStart || 0)}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart || 0)}
            onKeyDown={(e) => {
              if (suggestions.length === 0) {
                if (e.key === "Enter") send();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSuggestionsClosed(true);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setSelectedSuggestion(
                  (prev) =>
                    (prev + step + suggestions.length) % suggestions.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const selected = suggestions[selectedSuggestion];
                if (selected) pickSuggestion(selected);
              }
            }}
            placeholder="Message · @ person or role, # party line"
          />
          {showAckOption ? (
            <button
              type="button"
              className={`chat-confirm-toggle ${askToConfirm ? "active" : ""}`}
              onClick={() => setAskToConfirm(!askToConfirm)}
              aria-pressed={askToConfirm}
              aria-label="Ask to confirm"
              title="Ask the recipient to confirm they read it"
            >
              <Icon name="check" size={18} />
              <span>Confirm</span>
            </button>
          ) : null}
          <button
            type="button"
            className="primary chat-send"
            onClick={send}
            aria-label="Send chat"
            title="Send (Enter)"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
        {suggestions.length > 0 ? (
          <ul
            className="chat-autocomplete"
            role="listbox"
            aria-label="chat-autocomplete"
          >
            {suggestions.map((item, idx) => (
              <li key={item.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === selectedSuggestion}
                  className={idx === selectedSuggestion ? "active" : ""}
                  onClick={() => pickSuggestion(item)}
                >
                  <Icon name={item.icon} size={16} />
                  <strong>{item.name}</strong>
                  <span>{item.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {notice ? (
          <p className="chat-notice" role="alert">
            <span>{notice}</span>
            {onDismissNotice ? (
              <button
                type="button"
                className="k-icon-button"
                aria-label="Dismiss"
                onClick={onDismissNotice}
              >
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="chat-feed" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <p className="chat-feed-empty">No chat messages yet.</p>
        ) : (
          <ul className="chat-feed-list">
            {visibleMessages.map((entry, index) => {
              const toMe = !entry.self && entry.scope === "direct";
              const waitsForMe =
                showAckOption &&
                !entry.self &&
                entry.ackRequired &&
                !entry.acked &&
                !!entry.messageId;
              return (
                <li
                  key={`${entry.at}-${entry.from}-${index}`}
                  className={[
                    "chat-msg",
                    entry.self ? "self" : "",
                    toMe ? "to-me" : "",
                    waitsForMe ? "needs-confirm" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <div className="chat-msg-meta">
                    {entry.self ? (
                      <span className="chat-msg-sender">You</span>
                    ) : (
                      <button
                        type="button"
                        className="chat-msg-sender"
                        title={`Reply to ${entry.from}`}
                        onClick={() =>
                          setRecipient({ type: "user", id: entry.fromUserId })
                        }
                      >
                        {entry.from}
                      </button>
                    )}
                    <span className="chat-msg-target">
                      to {targetLabel(entry)}
                    </span>
                    {entry.source === "telegram" ? (
                      <span
                        className="chat-msg-source"
                        title="Message from Telegram"
                      >
                        via Telegram
                      </span>
                    ) : null}
                    <time>{entry.at}</time>
                  </div>
                  <p>{entry.body}</p>
                  {showAckOption && entry.self && entry.ackRequired ? (
                    <span
                      className={`chat-msg-confirm ${entry.acked ? "acked" : "pending"}`}
                    >
                      {entry.acked ? (
                        <>
                          <Icon name="check" size={14} />
                          Confirmed by {entry.ackedBy || "the recipient"}
                        </>
                      ) : (
                        "Waiting for confirmation"
                      )}
                    </span>
                  ) : null}
                  {showAckOption &&
                  !entry.self &&
                  entry.ackRequired &&
                  entry.acked ? (
                    <span className="chat-msg-confirm acked">
                      <Icon name="check" size={14} />
                      Confirmed
                    </span>
                  ) : null}
                  {waitsForMe ? (
                    <button
                      type="button"
                      className="primary chat-confirm-btn"
                      onClick={() =>
                        onAcknowledge(entry.messageId || "", entry.fromUserId)
                      }
                    >
                      <Icon name="check" size={16} />
                      Confirm
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
