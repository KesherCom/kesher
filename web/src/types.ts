export type Role = { id: string; name: string; defaultRoomId?: string; defaultVoiceMode?: "always_on" | "ptt" };
export type Room = { id: string; name: string };
export type BroadcastGroup = { id: string; name: string; roomIds: string[] };
export type User = { id: string; username: string; roleId: string };
export type Presence = {
  userId: string;
  username: string;
  roleId: string;
  activeRoom: string;
  voiceMode: string;
  micEnabled: boolean;
  broadcastActive: boolean;
};

export type PublicBootstrap = {
  roles: Role[];
  rooms: Room[];
  broadcastGroups: BroadcastGroup[];
};

export type Bootstrap = PublicBootstrap & {
  self: User;
  users: User[];
};

export type RoutedEvent = {
  scope: "direct" | "room" | "broadcast";
  targetId: string;
  body: string;
  signal?: string;
  fromUser: User;
  timestamp: number;
};

