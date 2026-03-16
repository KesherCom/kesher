import type {
  StreamDeckButtonConfig,
  StreamDeckButtonAction,
} from "../types";

type StreamDeckLabelLookup = {
  rooms: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  users: Array<{ id: string; username: string; roleId?: string }>;
  broadcastGroups: Array<{ id: string; name: string }>;
};

function resolveActionLabel(
  action: StreamDeckButtonAction | undefined,
  lookup: StreamDeckLabelLookup,
): string | undefined {
  if (!action) return undefined;

  switch (action.type) {
    case "ptt_room":
      return (
        lookup.rooms.find((room) => room.id === action.roomId)?.name ||
        action.roomId
      );
    case "direct_role":
      return (
        lookup.roles.find((role) => role.id === action.roleId)?.name ||
        action.roleId
      );
    case "direct_user":
      {
        const user = lookup.users.find((entry) => entry.id === action.userId);
        const username = user?.username || action.userId;
        const roleName = user?.roleId
          ? lookup.roles.find((role) => role.id === user.roleId)?.name
          : undefined;
        if (username && roleName) {
          return `${username}\n${roleName}`;
        }
        return username;
      }
    case "broadcast_ptt":
      return (
        lookup.broadcastGroups.find((group) => group.id === action.broadcastGroupId)
          ?.name || action.broadcastGroupId
      );
    case "reply_to_caller":
      return "Reply";
    case "mute_toggle":
      return "Mute";
    case "volume_delta":
      return "Volume";
    case "none":
    default:
      return undefined;
  }
}

export function withResolvedStreamDeckButtonLabel(
  button: StreamDeckButtonConfig,
  lookup: StreamDeckLabelLookup,
): StreamDeckButtonConfig {
  if (button.label?.trim()) {
    return button;
  }

  const resolved = resolveActionLabel(button.action, lookup);
  if (!resolved) {
    return button;
  }

  return {
    ...button,
    label: resolved,
  };
}
