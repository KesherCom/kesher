type ChatSignalPanelProps = {
  message: string;
  onMessageChange: (value: string) => void;
  onSendChat: () => void;
  onSendSignal: (signal: string) => void;
  chatMessages: Array<{ from: string; body: string; at: string; self: boolean }>;
};

export function ChatSignalPanel({ message, onMessageChange, onSendChat, onSendSignal, chatMessages }: ChatSignalPanelProps) {
  return (
    <>
      <div className="chat">
        <input
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSendChat()}
          placeholder="Type chat message…"
        />
        <button onClick={onSendChat}>Send chat</button>
      </div>
      <div className="signals">
        <button onClick={() => onSendSignal("attention")}>Attention</button>
        <button onClick={() => onSendSignal("standby")}>Standby</button>
        <button onClick={() => onSendSignal("go")}>Go</button>
      </div>
      <div className="chat-feed" aria-live="polite">
        {chatMessages.length === 0 ? (
          <p className="chat-feed-empty">No chat messages yet.</p>
        ) : (
          <ul className="chat-feed-list">
            {chatMessages.map((entry, index) => (
              <li key={`${entry.at}-${entry.from}-${index}`} className={entry.self ? "self" : ""}>
                <span>{entry.at}</span>
                <strong>{entry.from}</strong>
                <p>{entry.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

