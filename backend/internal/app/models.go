package app

import "time"

type Role struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	DefaultRoomID    string `json:"defaultRoomId,omitempty"`
	DefaultVoiceMode string `json:"defaultVoiceMode,omitempty"`
}

type Room struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type BroadcastGroup struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	RoomIDs []string `json:"roomIds"`
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

type ActiveRoomEvent struct {
	RoomID string `json:"roomId"`
}
type PresenceState struct {
	UserID     string `json:"userId"`
	Username   string `json:"username"`
	RoleID     string `json:"roleId"`
	ActiveRoom string `json:"activeRoom"`
	VoiceMode  string `json:"voiceMode"`
	MicEnabled bool   `json:"micEnabled"`
}

type RoutedEvent struct {
	Scope     string `json:"scope"`
	TargetID  string `json:"targetId"`
	Body      string `json:"body"`
	Signal    string `json:"signal,omitempty"`
	FromUser  User   `json:"fromUser"`
	Timestamp int64  `json:"timestamp"`
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
