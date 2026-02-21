type ChatSignalPanelProps = {
  message: string;
  onMessageChange: (value: string) => void;
  onSendChat: () => void;
  onSendSignal: (signal: string) => void;
};

export function ChatSignalPanel({ message, onMessageChange, onSendChat, onSendSignal }: ChatSignalPanelProps) {
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
    </>
  );
}

