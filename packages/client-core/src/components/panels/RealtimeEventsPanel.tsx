type RealtimeEventsPanelProps = {
  events: Array<{ label: string; at: string }>;
};

export function RealtimeEventsPanel({ events }: RealtimeEventsPanelProps) {
  return (
    <>
      <h3>Realtime events</h3>
      <ul className="events">
        {events.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span>{e.at}</span>
            <span>{e.label}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
