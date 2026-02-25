type Channel = {
  id: string;
  label: string;
};

type ChannelSelectorProps = {
  channels: Channel[];
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
  enableDirectPpt: boolean;
  onChannelPttStart: (channelId: string) => void;
  onChannelPttStop: (channelId: string) => void;
  pttPressedChannelId: string | null;
};

export function ChannelSelector({
  channels,
  selectedChannelId,
  onSelectChannel,
  enableDirectPpt,
  onChannelPttStart,
  onChannelPttStop,
  pttPressedChannelId,
}: ChannelSelectorProps) {
  const handleChannelPointerDown = (channelId: string) => {
    if (enableDirectPpt) {
      onChannelPttStart(channelId);
    } else {
      onSelectChannel(channelId);
    }
  };

  const handleChannelPointerUp = (channelId: string) => {
    if (enableDirectPpt) {
      onChannelPttStop(channelId);
    }
  };

  const handleChannelPointerLeave = (channelId: string) => {
    if (enableDirectPpt && pttPressedChannelId === channelId) {
      onChannelPttStop(channelId);
    }
  };

  const handleChannelPointerCancel = (channelId: string) => {
    if (enableDirectPpt && pttPressedChannelId === channelId) {
      onChannelPttStop(channelId);
    }
  };

  if (channels.length === 0) {
    return <div className="channel-selector-empty">No channels available</div>;
  }

  // Wrap channels in groups (max 2 columns, max 2 rows)
  const groupedChannels = [];
  for (let i = 0; i < channels.length; i += 2) {
    groupedChannels.push(channels.slice(i, i + 2));
  }

  return (
    <div className="channel-selector">
      {groupedChannels.map((group, groupIdx) => (
        <div key={`group-${groupIdx}`} className="channel-group">
          {group.map((channel) => {
            const isSelected = selectedChannelId === channel.id;
            const isPressed = pttPressedChannelId === channel.id;
            const isActive = enableDirectPpt && isSelected;

            return (
              <button
                key={`channel-${channel.id}`}
                className={`channel-button ${isActive ? "active" : ""} ${isPressed ? "pressed" : ""}`}
                onPointerDown={() => handleChannelPointerDown(channel.id)}
                onPointerUp={() => handleChannelPointerUp(channel.id)}
                onPointerLeave={() => handleChannelPointerLeave(channel.id)}
                onPointerCancel={() => handleChannelPointerCancel(channel.id)}
                title={
                  enableDirectPpt
                    ? "Press and hold to transmit"
                    : "Click to select channel"
                }
              >
                <div className="channel-talk-label">TALK</div>
                <div className="channel-name">{channel.label}</div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
