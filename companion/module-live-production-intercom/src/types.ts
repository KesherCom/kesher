export type CompanionState = {
	username: string
	bound: boolean
	replyDirectUserId?: string
	replyDirectUsername?: string
	presence?: {
		activeRoom: string
		listenRooms: string[]
		talkRooms: string[]
		voiceMode: string
		micEnabled: boolean
	}
}

export type DiscoveryRoom = {
	id: string
	name: string
	canTalk: boolean
	canListen: boolean
}

export type DiscoveryResponse = {
	username: string
	roleId: string
	rooms: DiscoveryRoom[]
	users: Array<{ id: string; username: string; roleId: string }>
	broadcastGroups: Array<{ id: string; name: string }>
}

export type CompanionInbound =
	| { type: 'companion_state'; data: CompanionState }
	| { type: 'companion_command_result'; data: { ok: boolean; error?: string; commandId?: string } }

export type CommandPayload = {
	commandId?: string
	command: string
	mode?: 'always_on' | 'ptt'
	scope?: 'direct' | 'room' | 'broadcast'
	targetId?: string
	state?: 'ptt_start' | 'ptt_stop'
	signal?: string
	roomId?: string
	activeRoomId?: string
	listenRoomIds?: string[]
	talkRoomIds?: string[]
}
