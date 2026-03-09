package app

// NOTE: The term "room" is used throughout the backend for historical reasons
// (database table names, JSON fields, internal APIs). The user-facing
// terminology has been updated to "party line"; API consumers within this
// repo still see "rooms" in JSON payloads for backwards compatibility.
// New code should use "party line" in comments and documentation when
// referring to the concept, but avoid renaming JSON tags without a proper
// migration plan.

import "time"

type Role struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	DefaultRoomID     string `json:"defaultRoomId,omitempty"`
	DefaultVoiceMode  string `json:"defaultVoiceMode,omitempty"`
	DefaultSimpleView bool   `json:"defaultSimpleView,omitempty"`
}

type CompanionRoomDiscovery struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CanTalk   bool   `json:"canTalk"`
	CanListen bool   `json:"canListen"`
}

type CompanionDiscoveryResponse struct {
	Username        string                   `json:"username"`
	RoleID          string                   `json:"roleId"`
	Rooms           []CompanionRoomDiscovery `json:"rooms"`
	Users           []User                   `json:"users"`
	BroadcastGroups []BroadcastGroup         `json:"broadcastGroups"`
}

type Room struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	SenderRoleIDs       []string `json:"senderRoleIds"`
	ReceiverRoleIDs     []string `json:"receiverRoleIds"`
	ForcedListenRoleIDs []string `json:"forcedListenRoleIds"`
}

type BroadcastGroup struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	RoomIDs        []string `json:"roomIds"`
	AllowedRoleIDs []string `json:"allowedRoleIds"`
}

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type Session struct {
	Token     string
	UserID    string
	Username  string
	RoleID    string
	ExpiresAt time.Time
}

type BootstrapResponse struct {
	Self            User             `json:"self"`
	Roles           []Role           `json:"roles"`
	Rooms           []Room           `json:"rooms"`
	BroadcastGroups []BroadcastGroup `json:"broadcastGroups"`
	Users           []User           `json:"users"`
}

type PublicBootstrapResponse struct {
	Roles           []Role           `json:"roles"`
	Rooms           []Room           `json:"rooms"`
	BroadcastGroups []BroadcastGroup `json:"broadcastGroups"`
}

type LoginRequest struct {
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type LoginResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type WSInbound struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type WSOutbound struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type RoomMatrixEvent struct {
	ListenRoomIDs []string `json:"listenRoomIds"`
	TalkRoomIDs   []string `json:"talkRoomIds"`
}
type PresenceState struct {
	UserID          string   `json:"userId"`
	Username        string   `json:"username"`
	RoleID          string   `json:"roleId"`
	ListenRooms     []string `json:"listenRooms"`
	TalkRooms       []string `json:"talkRooms"`
	VoiceMode       string   `json:"voiceMode"`
	MicEnabled      bool     `json:"micEnabled"`
	BroadcastActive bool     `json:"broadcastActive"`
}

type RoutedEvent struct {
	Scope      string `json:"scope"`
	TargetType string `json:"targetType,omitempty"`
	TargetID   string `json:"targetId"`
	Body       string `json:"body"`
	Signal     string `json:"signal,omitempty"`
	FromUser   User   `json:"fromUser"`
	Timestamp  int64  `json:"timestamp"`
}

type RoutingStatusEvent struct {
	Code       string `json:"code"`
	TargetType string `json:"targetType,omitempty"`
	Target     string `json:"target,omitempty"`
	Message    string `json:"message"`
	Timestamp  int64  `json:"timestamp"`
}

type WebRTCOffer struct {
	SDP string `json:"sdp"`
}

type WebRTCAnswer struct {
	SDP string `json:"sdp"`
}

type WebRTCIceCandidate struct {
	Candidate     string `json:"candidate"`
	SDPMid        string `json:"sdpMid,omitempty"`
	SDPMLineIndex uint16 `json:"sdpMLineIndex,omitempty"`
}

type CompanionCommand struct {
	CommandID     string   `json:"commandId,omitempty"`
	Command       string   `json:"command"`
	Mode          string   `json:"mode,omitempty"`
	Scope         string   `json:"scope,omitempty"`
	TargetID      string   `json:"targetId,omitempty"`
	State         string   `json:"state,omitempty"`
	Signal        string   `json:"signal,omitempty"`
	ListenRoomIDs []string `json:"listenRoomIds,omitempty"`
	TalkRoomIDs   []string `json:"talkRoomIds,omitempty"`
}

type CompanionBridgeState struct {
	Username            string         `json:"username"`
	Bound               bool           `json:"bound"`
	Presence            *PresenceState `json:"presence,omitempty"`
	ReplyDirectUserID   string         `json:"replyDirectUserId,omitempty"`
	ReplyDirectUsername string         `json:"replyDirectUsername,omitempty"`
	SignalActive        bool           `json:"signalActive"`
	SignalFrom          string         `json:"signalFrom,omitempty"`
	SignalMessage       string         `json:"signalMessage,omitempty"`
}

type StatusResponse struct {
	RoomListenerCounts map[string]int `json:"roomListenerCounts"`
	TimestampUnixMs    int64          `json:"timestampUnixMs"`
}

type TelegramMapping struct {
	ID     string `json:"id"`
	ChatID string `json:"chatId"`
	Label  string `json:"label"`
	RoomID string `json:"roomId"`
}

type TelegramStatusResponse struct {
	BotConfigured bool              `json:"botConfigured"`
	Mode          string            `json:"mode"` // "polling" or "webhook"
	Mappings      []TelegramMapping `json:"mappings"`
}

type TelegramUpdate struct {
	UpdateID int64            `json:"update_id"`
	Message  *TelegramMessage `json:"message,omitempty"`
}

type TelegramMessage struct {
	MessageID int64         `json:"message_id"`
	From      *TelegramUser `json:"from,omitempty"`
	Chat      TelegramChat  `json:"chat"`
	Text      string        `json:"text,omitempty"`
}

type TelegramUser struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	Username  string `json:"username,omitempty"`
}

type TelegramChat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}
