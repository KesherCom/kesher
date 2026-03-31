import type {
  StreamDeckButtonConfig,
  StreamDeckButtonAction,
} from "../types";

type StreamDeckLabelLookup = {
  rooms: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  users: Array<{ id: string; username: string; roleId?: string }>;
  activeUsers?: Array<{ id: string; username: string; roleId?: string }>;
  broadcastGroups: Array<{ id: string; name: string }>;
  lastDirectCallerUserId?: string | null;
};

function resolveReplyTargetLabel(lookup: StreamDeckLabelLookup): string {
  if (!lookup.lastDirectCallerUserId) {
    return "No active caller";
  }

  const activeUser = lookup.activeUsers?.find(
    (entry) => entry.id === lookup.lastDirectCallerUserId,
  );
  if (activeUser?.username) {
    return activeUser.username;
  }

  const knownUser = lookup.users.find(
    (entry) => entry.id === lookup.lastDirectCallerUserId,
  );
  if (knownUser?.username) {
    return knownUser.username;
  }

  return "Unknown caller";
}

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
    case "select_talk_room":
      return (
        lookup.rooms.find((room) => room.id === action.roomId)?.name ||
        action.roomId
      );
    case "select_listen_room":
      return (
        lookup.rooms.find((room) => room.id === action.roomId)?.name ||
        action.roomId
      );
    case "ptt_selected":
      return "PTT";
    case "listen_room":
      return (
        lookup.rooms.find((room) => room.id === action.roomId)?.name ||
        action.roomId
      );
    case "call_room":
      return (
        lookup.rooms.find((room) => room.id === action.roomId)?.name ||
        action.roomId
      );
    case "direct_role":
      {
        const roleName =
          lookup.roles.find((role) => role.id === action.roleId)?.name ||
          action.roleId;
        const roleUsers = (lookup.activeUsers ?? lookup.users).filter(
          (u) => u.roleId === action.roleId,
        );
        if (roleUsers.length > 0) {
          return `${roleUsers[0].username}\n${roleName}`;
        }
        return roleName;
      }
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
      return `Reply\n${resolveReplyTargetLabel(lookup)}`;
    case "incoming_call_indicator":
      return "Incoming";
    case "mute_toggle":
      return "Mute";
    case "volume_delta":
      return "Volume";
    case "page_up":
      return "Page +";
    case "page_down":
      return "Page -";
    case "page_home":
      return "Home";
    case "page_jump":
      return action.targetPage !== undefined ? `Page ${action.targetPage + 1}` : "Jump";
    case "none":
    default:
      return undefined;
  }
}

export function withResolvedStreamDeckButtonLabel(
  button: StreamDeckButtonConfig,
  lookup: StreamDeckLabelLookup,
): StreamDeckButtonConfig {
  if (button.action?.type === "reply_to_caller") {
    const existingLabel = button.label?.trim() ?? "";
    const primaryLabel =
      existingLabel.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ||
      "Reply";
    return {
      ...button,
      label: `${primaryLabel}\n${resolveReplyTargetLabel(lookup)}`,
    };
  }

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
