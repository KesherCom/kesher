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
	Username          string                   `json:"username"`
	RoleID            string                   `json:"roleId"`
	Rooms             []CompanionRoomDiscovery `json:"rooms"`
	Users             []User                   `json:"users"`
	ActiveRoleUsers   []CompanionRoleUser      `json:"activeRoleUsers,omitempty"`
	BroadcastGroups   []BroadcastGroup         `json:"broadcastGroups"`
	CurrentPageNumber int                      `json:"currentPageNumber,omitempty"`
	ProfileVersion    int                      `json:"profileVersion,omitempty"`
	ProfileStatus     string                   `json:"profileStatus,omitempty"`
	ProfileUpdatedAt  int64                    `json:"profileUpdatedAt,omitempty"`
}

type CompanionProfileResponse struct {
	RoleID            string                   `json:"roleId"`
	Username          string                   `json:"username"`
	PageNumber        int                      `json:"pageNumber,omitempty"`
	CurrentPageNumber int                      `json:"currentPageNumber,omitempty"`
	Rooms             []CompanionRoomDiscovery `json:"rooms"`
	Users             []User                   `json:"users"`
	ActiveRoleUsers   []CompanionRoleUser      `json:"activeRoleUsers,omitempty"`
	BroadcastGroups   []BroadcastGroup         `json:"broadcastGroups"`
	StreamDeck        StreamDeckSettings       `json:"streamDeckSettings"`
	ProfileVersion    int                      `json:"profileVersion"`
	ProfileStatus     string                   `json:"profileStatus"`
	ProfileUpdatedAt  int64                    `json:"profileUpdatedAt,omitempty"`
}

type CompanionPublishedProfileSummary struct {
	RoleID           string `json:"roleId"`
	Username         string `json:"username"`
	ProfileVersion   int    `json:"profileVersion"`
	ProfileStatus    string `json:"profileStatus"`
	ProfileUpdatedAt int64  `json:"profileUpdatedAt,omitempty"`
}

type CompanionAdminSummaryResponse struct {
	SharedSecret      string                             `json:"sharedSecret"`
	PublishedProfiles []CompanionPublishedProfileSummary `json:"publishedProfiles"`
}

type CompanionRoleUser struct {
	RoleID   string `json:"roleId"`
	Username string `json:"username"`
	UserID   string `json:"userId"`
}

type Room struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	PriorityLevel       int      `json:"priorityLevel"`
	SenderRoleIDs       []string `json:"senderRoleIds"`
	ReceiverRoleIDs     []string `json:"receiverRoleIds"`
	ForcedListenRoleIDs []string `json:"forcedListenRoleIds"`
}

type BroadcastGroup struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	PriorityLevel  int      `json:"priorityLevel"`
	RoomIDs        []string `json:"roomIds"`
	AllowedRoleIDs []string `json:"allowedRoleIds"`
}

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type AdminUserView struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
	Online   bool   `json:"online"`
}

type Session struct {
	Token     string
	UserID    string
	Username  string
	RoleID    string
	ExpiresAt time.Time
}

type StreamDeckActionType string

type StreamDeckPageType string

const (
	StreamDeckActionTypeNone           StreamDeckActionType = "none"
	StreamDeckActionTypePTTRoom        StreamDeckActionType = "ptt_room"
	StreamDeckActionTypeSelectTalkRoom StreamDeckActionType = "select_talk_room"
	StreamDeckActionTypeSelectListen   StreamDeckActionType = "select_listen_room"
	StreamDeckActionTypePTTSelected    StreamDeckActionType = "ptt_selected"
	StreamDeckActionTypeListenRoom     StreamDeckActionType = "listen_room"
	StreamDeckActionTypeCallRoom       StreamDeckActionType = "call_room"
	StreamDeckActionTypeDirectUser     StreamDeckActionType = "direct_user"
	StreamDeckActionTypeDirectRole     StreamDeckActionType = "direct_role"
	StreamDeckActionTypeReplyToCaller  StreamDeckActionType = "reply_to_caller"
	StreamDeckActionTypeIncomingCall   StreamDeckActionType = "incoming_call_indicator"
	StreamDeckActionTypeBroadcastPTT   StreamDeckActionType = "broadcast_ptt"
	StreamDeckActionTypeMuteToggle     StreamDeckActionType = "mute_toggle"
	StreamDeckActionTypeVolumeDelta    StreamDeckActionType = "volume_delta"
	StreamDeckActionTypePageUp         StreamDeckActionType = "page_up"
	StreamDeckActionTypePageDown       StreamDeckActionType = "page_down"
	StreamDeckActionTypePageJump       StreamDeckActionType = "page_jump"
	StreamDeckActionTypePageHome       StreamDeckActionType = "page_home"
	StreamDeckActionTypePageBack       StreamDeckActionType = "page_back"
)

const (
	StreamDeckPageTypeManual         StreamDeckPageType = "manual"
	StreamDeckPageTypeAllRoles       StreamDeckPageType = "all_roles"
	StreamDeckPageTypeAllPartyLines  StreamDeckPageType = "all_party_lines"
)

const (
	StreamDeckGridColumns = 5
	StreamDeckGridRows    = 3
	StreamDeckButtonCount = StreamDeckGridColumns * StreamDeckGridRows
)

type StreamDeckButtonAction struct {
	Type             StreamDeckActionType `json:"type"`
	RoomID           string               `json:"roomId,omitempty"`
	UserID           string               `json:"userId,omitempty"`
	RoleID           string               `json:"roleId,omitempty"`
	BroadcastGroupID string               `json:"broadcastGroupId,omitempty"`
	VolumeDelta      int                  `json:"volumeDelta,omitempty"`
	TargetPage       int                  `json:"targetPage,omitempty"`
}

type StreamDeckButtonConfig struct {
	Index  int                     `json:"index"`
	Label  string                  `json:"label,omitempty"`
	Color  string                  `json:"color,omitempty"`
	Action *StreamDeckButtonAction `json:"action,omitempty"`
}

type StreamDeckPageConfig struct {
	Page       int                      `json:"page"`
	Title      string                   `json:"title,omitempty"`
	PageType   StreamDeckPageType       `json:"pageType,omitempty"`
	ParentPage *int                     `json:"parentPage,omitempty"`
	Buttons    []StreamDeckButtonConfig `json:"buttons"`
}

type StreamDeckSettings struct {
	Version      int                    `json:"version"`
	GridColumns  int                    `json:"gridColumns"`
	GridRows     int                    `json:"gridRows"`
	SelectedPage int                    `json:"selectedPage"`
	Pages        []StreamDeckPageConfig `json:"pages"`
}

func DefaultStreamDeckSettings() StreamDeckSettings {
	buttons := make([]StreamDeckButtonConfig, 0, StreamDeckButtonCount)
	for i := 0; i < StreamDeckButtonCount; i++ {
		buttons = append(buttons, StreamDeckButtonConfig{Index: i})
	}
	return StreamDeckSettings{
		Version:      1,
		GridColumns:  StreamDeckGridColumns,
		GridRows:     StreamDeckGridRows,
		SelectedPage: 0,
		Pages: []StreamDeckPageConfig{
			{Page: 0, Buttons: buttons},
		},
	}
}

type BootstrapResponse struct {
	Self            User             `json:"self"`
	Roles           []Role           `json:"roles"`
	Rooms           []Room           `json:"rooms"`
	BroadcastGroups []BroadcastGroup `json:"broadcastGroups"`
	Users           []User           `json:"users"`
	AckEnabled      bool             `json:"ackEnabled"`
	AppVersion      VersionInfo      `json:"appVersion"`
}

type PublicBootstrapResponse struct {
	Roles           []Role           `json:"roles"`
	Rooms           []Room           `json:"rooms"`
	BroadcastGroups []BroadcastGroup `json:"broadcastGroups"`
	AckEnabled      bool             `json:"ackEnabled"`
	AppVersion      VersionInfo      `json:"appVersion"`
}

type LoginRequest struct {
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type LoginResponse struct {
	Token                string `json:"token"`
	User                 User   `json:"user"`
	ShowBirthdayGreeting bool   `json:"showBirthdayGreeting,omitempty"`
}

type LoginConflictResponse struct {
	RequiresTakeover bool   `json:"requiresTakeover"`
	ConflictRoleID   string `json:"conflictRoleId"`
	ConflictRoleName string `json:"conflictRoleName,omitempty"`
	ConflictUsername string `json:"conflictUsername,omitempty"`
}

type LoginTakeoverRequest struct {
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type AdminLoginRequest struct {
	PIN string `json:"pin"`
}

type WSInbound struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type WSOutbound struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type SessionRevokedEvent struct {
	Reason    string `json:"reason"`
	Timestamp int64  `json:"timestamp"`
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
	Scope       string `json:"scope"`
	TargetType  string `json:"targetType,omitempty"`
	TargetID    string `json:"targetId"`
	Body        string `json:"body"`
	Source      string `json:"source,omitempty"`
	Signal      string `json:"signal,omitempty"`
	MessageID   string `json:"messageId,omitempty"`
	AckRequired bool   `json:"ackRequired,omitempty"`
	Acked       bool   `json:"acked,omitempty"`
	AckedBy     *User  `json:"ackedBy,omitempty"`
	AckedAt     int64  `json:"ackedAt,omitempty"`
	FromUser    User   `json:"fromUser"`
	Timestamp   int64  `json:"timestamp"`
}

type ChatAckInbound struct {
	MessageID    string `json:"messageId"`
	SenderUserID string `json:"senderUserId"`
}

type ChatAckUpdate struct {
	MessageID    string `json:"messageId"`
	SenderUserID string `json:"senderUserId"`
	AckedBy      User   `json:"ackedBy"`
	AckedAt      int64  `json:"ackedAt"`
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

// NativeAudioEndpoint is sent over the WebSocket to native (Tauri) clients
// that requested the performance transport. It contains the UDP relay address
// the client should send Opus frames to, plus the session token (echoed back
// for the REGISTER packet). Browser clients never receive this message.
type NativeAudioEndpoint struct {
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Token         string `json:"token"`
	TokenHash     uint32 `json:"tokenHash"`
	FrameDuration int    `json:"frameDurationMs"`
	SampleRate    int    `json:"sampleRate"`
	Channels      int    `json:"channels"`
}

// AudioModeInfo tells the client which transport the server expects. "native"
// instructs Tauri clients to skip WebRTC and use the native UDP pipeline;
// "webrtc" is the fallback (browser, or native when relay is unavailable).
type AudioModeInfo struct {
	Mode string `json:"mode"`
}

type CompanionCommand struct {
	CommandID     string   `json:"commandId,omitempty"`
	Command       string   `json:"command"`
	Mode          string   `json:"mode,omitempty"`
	Scope         string   `json:"scope,omitempty"`
	TargetID      string   `json:"targetId,omitempty"`
	State         string   `json:"state,omitempty"`
	Signal        string   `json:"signal,omitempty"`
	ButtonIndex   int      `json:"buttonIndex,omitempty"`
	VolumeDelta   int      `json:"volumeDelta,omitempty"`
	ListenRoomIDs []string `json:"listenRoomIds"`
	TalkRoomIDs   []string `json:"talkRoomIds"`
	Brightness    int      `json:"brightness,omitempty"`
	PageNumber    int      `json:"pageNumber,omitempty"`
}

type CompanionCommandResult struct {
	CommandID string `json:"commandId,omitempty"`
	Command   string `json:"command,omitempty"`
	OK        bool   `json:"ok"`
	Status    string `json:"status,omitempty"`
	Error     string `json:"error,omitempty"`
	Source    string `json:"source,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
}

type CompanionBridgeState struct {
	Username            string         `json:"username"`
	Bound               bool           `json:"bound"`
	Presence            *PresenceState `json:"presence,omitempty"`
	SessionCount        int            `json:"sessionCount,omitempty"`
	MultiSessionWarning bool           `json:"multiSessionWarning,omitempty"`
	ReplyDirectUserID   string         `json:"replyDirectUserId,omitempty"`
	ReplyDirectUsername string         `json:"replyDirectUsername,omitempty"`
	SignalActive        bool           `json:"signalActive"`
	SignalFrom          string         `json:"signalFrom,omitempty"`
	SignalMessage       string         `json:"signalMessage,omitempty"`
	ImageEffectMapJSON  string         `json:"imageEffectMapJson,omitempty"`
	CurrentPageNumber   int            `json:"currentPageNumber,omitempty"`
	ProfileVersion      int            `json:"profileVersion,omitempty"`
	ProfileStatus       string         `json:"profileStatus,omitempty"`
	ProfileUpdatedAt    int64          `json:"profileUpdatedAt,omitempty"`
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

type TelegramAllowlistEntry struct {
	ID                string `json:"id"`
	TelegramUsername  string `json:"telegramUsername"`
	TelegramNumericID string `json:"telegramNumericId,omitempty"`
	KesherUsername    string `json:"kesherUsername"`
	CreatedAt         int64  `json:"createdAt"`
	Status            string `json:"status"`
	IsBound           bool   `json:"isBound"`
}

type TelegramUserMapping struct {
	ID             string `json:"id"`
	TelegramUserID string `json:"telegramUserId"`
	Username       string `json:"username"`
	PrivateChatID  string `json:"privateChatId"`
	CreatedAt      int64  `json:"createdAt"`
}

type TelegramStatusResponse struct {
	BotConfigured bool              `json:"botConfigured"`
	Mode          string            `json:"mode"` // "polling" or "webhook"
	Mappings      []TelegramMapping `json:"mappings"`
}

type TelegramUpdate struct {
	UpdateID      int64                  `json:"update_id"`
	Message       *TelegramMessage       `json:"message,omitempty"`
	CallbackQuery *TelegramCallbackQuery `json:"callback_query,omitempty"`
	InlineQuery   *TelegramInlineQuery   `json:"inline_query,omitempty"`
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

type TelegramCallbackQuery struct {
	ID      string           `json:"id"`
	From    *TelegramUser    `json:"from"`
	Message *TelegramMessage `json:"message,omitempty"`
	Data    string           `json:"data"`
}

type TelegramInlineKeyboardMarkup struct {
	InlineKeyboard [][]TelegramInlineKeyboardButton `json:"inline_keyboard"`
}

type TelegramInlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

type TelegramInlineQuery struct {
	ID     string        `json:"id"`
	From   *TelegramUser `json:"from"`
	Query  string        `json:"query"`
	Offset string        `json:"offset"`
}

type TelegramInlineQueryResultArticle struct {
	Type                string                      `json:"type"`
	ID                  string                      `json:"id"`
	Title               string                      `json:"title"`
	InputMessageContent TelegramInputMessageContent `json:"input_message_content"`
	Description         string                      `json:"description,omitempty"`
}

type TelegramInputMessageContent struct {
	MessageText string `json:"message_text"`
}
