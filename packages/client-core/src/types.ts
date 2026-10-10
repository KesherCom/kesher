export type Role = {
  id: string;
  name: string;
  defaultRoomId?: string;
  defaultVoiceMode?: "always_on" | "ptt";
  defaultSimpleView?: boolean;
  /** One login at a time; roles are shared by default. */
  exclusive?: boolean;
};

/** Direct target for everyone logged in with a role (a role call). */
export const directRoleTargetPrefix = "role:";

export type VersionInfo = {
  version: string;
  buildTimestamp: string;
};

// NOTE: this type is still called Room for backwards compatibility with
// the server API JSON, but user-facing UI now refers to these entities as
// "party lines". When communicating with new code or documentation, prefer
// the term party line instead of room.
export type Room = {
  id: string;
  name: string;
  priorityLevel?: number;
  senderRoleIds: string[];
  receiverRoleIds: string[];
  forcedListenRoleIds: string[];
};
export type BroadcastGroup = {
  id: string;
  name: string;
  priorityLevel?: number;
  roomIds: string[];
  allowedRoleIds: string[];
};
export type User = { id: string; username: string; roleId: string };

export type UserWithOnlineStatus = User & { online: boolean };
export type ConfigurationSection =
  | "roles"
  | "users"
  | "rooms"
  | "broadcastGroups"
  | "telegramAllowlist"
  | "ackSettings"
  | "streamDeckSettings";

export type ConfigurationMetadata = {
  format: string;
  schemaVersion: number;
  exportedAt: string;
  sourceVersion: VersionInfo;
  sections: ConfigurationSection[];
};

export type ConfigurationUserAssignment = {
  username: string;
  roleId: string;
};

export type ConfigurationUserStreamDeckSettings = {
  username: string;
  settings: StreamDeckSettings;
};

export type ConfigurationDocument = {
  meta: ConfigurationMetadata;
  roles: Role[];
  users: ConfigurationUserAssignment[];
  rooms: Room[];
  broadcastGroups: BroadcastGroup[];
  telegramAllowlist: TelegramAllowlistEntry[];
  ackSettings: { enabled: boolean } | null;
  streamDeckSettings: ConfigurationUserStreamDeckSettings[];
};

export type ConfigurationImportResponse = {
  importedSections: ConfigurationSection[];
};

export type CompanionPublishedProfileSummary = {
  roleId: string;
  username: string;
  profileVersion: number;
  profileStatus: string;
  profileUpdatedAt?: number;
};

export type CompanionAdminSummary = {
  sharedSecret: string;
  publishedProfiles: CompanionPublishedProfileSummary[];
};

export type CompanionProfileResponse = {
  roleId: string;
  username: string;
  pageNumber?: number;
  profileVersion: number;
  profileStatus: string;
  profileUpdatedAt?: number;
};

export type CompanionRolePageConfig = {
  roleId: string;
  pageNumber: number;
};

export type CompanionRolePagesResponse = {
  rolePages: Record<string, number>;
};

export type LoginSuccess = {
  token: string;
  user: User;
  showBirthdayGreeting?: boolean;
};
export type LoginConflict = {
  requiresTakeover: true;
  conflictRoleId: string;
  conflictRoleName?: string;
  conflictUsername?: string;
};
export type SessionRevokedEvent = {
  reason: string;
  timestamp: number;
};
export type Presence = {
  userId: string;
  username: string;
  roleId: string;
  listenRooms: string[];
  talkRooms: string[];
  voiceMode: "ptt" | "always_on";
  micEnabled: boolean;
  broadcastActive: boolean;
  /** Source ID of this session on the native UDP audio transport. */
  audioSourceId?: number;
};

export type PublicBootstrap = {
  roles: Role[];
  rooms: Room[];
  broadcastGroups: BroadcastGroup[];
  ackEnabled: boolean;
  appVersion: VersionInfo;
  /** Fresh server: show the first-run setup instead of the login. */
  setupRequired?: boolean;
};

export type Bootstrap = PublicBootstrap & {
  self: User;
  users: User[];
};

/** Hardware station (kesher-node) as listed in the admin area. */
export type Device = {
  id: string;
  name: string;
  hostname: string;
  model: string;
  version: string;
  status: "pending" | "approved" | "rejected";
  roleId: string;
  mode: "ptt" | "always_on";
  lastIp: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
};

/** A Stream Deck reached through Companion, bound to a place. */
export type StreamDeckDevice = {
  id: string;
  name: string;
  placeId: string;
  placeLabel: string;
  /** Own layout; otherwise it shows the layout of the role logged in there. */
  hasLayout: boolean;
  /** Companion surface (serial number) last pressed. */
  surface: string;
  lastIp: string;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
  username?: string;
  roleId?: string;
  /** Shown on the deck while it is not bound to a place. */
  pairingCode?: string;
};

/** A client installation that is connected right now. */
export type ClientPlace = {
  placeId: string;
  username: string;
  roleId: string;
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

export type TelegramAllowlistEntry = {
  id: string;
  telegramUsername: string;
  telegramNumericId?: string;
  kesherUsername: string;
  createdAt: number;
  status: string;
  isBound: boolean;
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
  syncRunAvgMs: number;
  syncRunMaxMs: number;
  voiceStateToSyncAvgMs: number;
  voiceStateToSyncMaxMs: number;
  renegotiations: number;
  renegotiationAvgMs: number;
  renegotiationMaxMs: number;
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

export type AdminLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type AdminLogEntry = {
  timestampUnixMs: number;
  level: AdminLogLevel | string;
  category: string;
  message: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  username?: string;
  roleId?: string;
  remoteAddr?: string;
  error?: string;
};

export type AdminLogsResponse = {
  entries: AdminLogEntry[];
  total: number;
  timestampUnixMs: number;
};

export type StatusResponse = {
  roomListenerCounts: Record<string, number>;
  timestampUnixMs: number;
};

export type StreamDeckActionType =
  | "none"
  | "ptt_room"
  | "select_talk_room"
  | "select_listen_room"
  | "ptt_selected"
  | "listen_room"
  | "call_room"
  | "direct_user"
  | "direct_role"
  | "reply_to_caller"
  | "incoming_call_indicator"
  | "broadcast_ptt"
  | "mute_toggle"
  | "volume_delta"
  | "page_up"
  | "page_down"
  | "page_jump"
  | "page_home"
  | "page_back";

export type StreamDeckPageType =
  | "manual"
  | "all_roles"
  | "all_party_lines";

export type StreamDeckButtonAction = {
  type: StreamDeckActionType;
  roomId?: string;
  userId?: string;
  roleId?: string;
  broadcastGroupId?: string;
  volumeDelta?: number;
  targetPage?: number;
};

export type StreamDeckButtonConfig = {
  index: number;
  label?: string;
  color?: string;
  action?: StreamDeckButtonAction;
};

export type StreamDeckPageConfig = {
  page: number;
  title?: string;
  pageType?: StreamDeckPageType;
  parentPage?: number;
  buttons: StreamDeckButtonConfig[];
};

export type StreamDeckSettings = {
  version: number;
  gridColumns: number;
  gridRows: number;
  selectedPage: number;
  pages: StreamDeckPageConfig[];
};

export type RoutedEvent = {
  scope: "direct" | "room" | "broadcast";
  targetType?: "room" | "user" | "role";
  targetId: string;
  body: string;
  source?: string;
  signal?: string;
  messageId?: string;
  ackRequired?: boolean;
  acked?: boolean;
  ackedBy?: User;
  ackedAt?: number;
  fromUser: User;
  timestamp: number;
};

export type ChatAckUpdate = {
  messageId: string;
  senderUserId: string;
  ackedBy: User;
  ackedAt: number;
};

/** Who a chat message goes to: a party line, a person or a role. */
export type ChatRecipient = { type: "room" | "user" | "role"; id: string };
