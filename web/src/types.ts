export type Role = {
  id: string;
  name: string;
  defaultRoomId?: string;
  defaultVoiceMode?: "always_on" | "ptt";
  defaultSimpleView?: boolean;
};
export type Room = {
  id: string;
  name: string;
  senderRoleIds: string[];
  receiverRoleIds: string[];
  forcedListenRoleIds: string[];
};
export type BroadcastGroup = {
  id: string;
  name: string;
  roomIds: string[];
  allowedRoleIds: string[];
};
export type User = { id: string; username: string; roleId: string };
export type Presence = {
  userId: string;
  username: string;
  roleId: string;
  activeRoom: string;
  listenRooms: string[];
  talkRooms: string[];
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

export type TelegramMapping = {
  id: string;
  chatId: string;
  label: string;
  roomId: string;
};

export type TelegramStatus = {
  botConfigured: boolean;
  mode: "polling" | "webhook" | "";
  mappings: TelegramMapping[];
};
export type HubRealtimeStats = {
  connectedClients: number;
  normalQueueDepthTotal: number;
  normalQueueDepthMax: number;
  priorityQueueDepthTotal: number;
  priorityQueueDepthMax: number;
  droppedCriticalMessages: number;
  droppedNormalMessages: number;
  droppedMessagesByType: Record<string, number>;
  presenceBroadcasts: number;
  presenceBroadcastsMerged: number;
};

export type MediaRealtimeStats = {
  peers: number;
  sources: number;
  syncRequests: number;
  syncRuns: number;
  syncRequestsCoalesced: number;
  renegotiations: number;
};

export type StorePolicyCacheStats = {
  roomPolicyHits: number;
  roomPolicyMisses: number;
  broadcastAllowedHits: number;
  broadcastAllowedMisses: number;
  broadcastRoomHits: number;
  broadcastRoomMisses: number;
  forcedListenHits: number;
  forcedListenMisses: number;
};

export type RealtimeStatsResponse = {
  hub: HubRealtimeStats;
  media: MediaRealtimeStats;
  storePolicyCache: StorePolicyCacheStats;
  timestampUnixMs: number;
};

export type RoutedEvent = {
  scope: "direct" | "room" | "broadcast";
  targetId: string;
  body: string;
  signal?: string;
  fromUser: User;
  timestamp: number;
};
