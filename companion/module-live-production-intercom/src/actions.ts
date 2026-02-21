import type { CompanionActionDefinitions } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

function scopedChoices(self: ModuleInstance): Array<{ id: string; label: string }> {
	return [
		{ id: 'room', label: 'Room' },
		{ id: 'direct', label: 'Direct' },
		{ id: 'broadcast', label: 'Broadcast' },
	]
}

export function UpdateActions(self: ModuleInstance): void {
	const talkRooms = self.getRoomChoices('talk')
	const allRooms = self.getRoomChoices('all')
	const users = self.getUserChoices()
	const groups = self.getBroadcastChoices()

	const actions: CompanionActionDefinitions = {
		set_voice_mode: {
			name: 'Set voice mode',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'ptt',
					choices: [
						{ id: 'always_on', label: 'Always on' },
						{ id: 'ptt', label: 'PTT' },
					],
				},
			],
			callback: async (event) => {
				await self.sendBridgeCommand({
					command: 'set_voice_mode',
					mode: String(event.options.mode) as 'always_on' | 'ptt',
				})
			},
		},
		set_room_selection: {
			name: 'Set room selection',
			options: [
				{
					id: 'matrix',
					type: 'dropdown',
					label: 'Matrix',
					default: 'listen',
					choices: [
						{ id: 'listen', label: 'Listen' },
						{ id: 'talk', label: 'Talk' },
					],
				},
				{
					id: 'roomId',
					type: 'dropdown',
					label: 'Room',
					default: allRooms[0]?.id ?? '',
					choices: allRooms,
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Selection mode',
					default: 'toggle',
					choices: [
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async (event) => {
				const matrix = String(event.options.matrix)
				const roomId = String(event.options.roomId || '').trim()
				const mode = String(event.options.mode)
				if (!roomId) throw new Error('roomId is required')
				const current = matrix === 'listen' ? [...self.listenRooms] : [...self.talkRooms]
				const has = current.includes(roomId)
				const wantOn = mode === 'on' || (mode === 'toggle' && !has)
				const next =
					matrix === 'talk'
						? wantOn
							? [roomId]
							: current.filter((v) => v !== roomId)
						: wantOn
							? Array.from(new Set([...current, roomId]))
							: current.filter((v) => v !== roomId)
				const nextListen = matrix === 'listen' ? next : [...self.listenRooms]
				const nextTalk = matrix === 'talk' ? next : [...self.talkRooms]
				await self.sendBridgeCommand({
					command: 'set_room_matrix',
					activeRoomId: self.activeRoom,
					listenRoomIds: nextListen,
					talkRoomIds: nextTalk,
				})
			},
		},
		set_ptt_active_room: {
			name: 'Set PTT state (active room)',
			options: [
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'ptt_start',
					choices: [
						{ id: 'ptt_start', label: 'Start' },
						{ id: 'ptt_stop', label: 'Stop' },
					],
				},
			],
			callback: async (event) => {
				const targetId = self.activeRoom
				if (!targetId) throw new Error('No active room selected')
				await self.sendBridgeCommand({
					command: 'ptt',
					scope: 'room',
					targetId,
					state: String(event.options.state) as 'ptt_start' | 'ptt_stop',
				})
			},
		},
		set_ptt_target: {
			name: 'Set PTT state (target)',
			options: [
				{
					id: 'scope',
					type: 'dropdown',
					label: 'Scope',
					default: 'room',
					choices: scopedChoices(self),
				},
				{
					id: 'roomTargetId',
					type: 'dropdown',
					label: 'Room target',
					default: talkRooms[0]?.id ?? '',
					choices: talkRooms,
					isVisible: (options) => options.scope === 'room',
				},
				{
					id: 'directTargetId',
					type: 'dropdown',
					label: 'Direct target',
					default: users[0]?.id ?? '',
					choices: users,
					isVisible: (options) => options.scope === 'direct',
				},
				{
					id: 'broadcastTargetId',
					type: 'dropdown',
					label: 'Broadcast target',
					default: groups[0]?.id ?? '',
					choices: groups,
					isVisible: (options) => options.scope === 'broadcast',
				},
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'ptt_start',
					choices: [
						{ id: 'ptt_start', label: 'Start' },
						{ id: 'ptt_stop', label: 'Stop' },
					],
				},
			],
			callback: async (event) => {
				const scope = String(event.options.scope) as 'direct' | 'room' | 'broadcast'
				const targetId =
					scope === 'room'
						? String(event.options.roomTargetId || '')
						: scope === 'direct'
							? String(event.options.directTargetId || '')
							: String(event.options.broadcastTargetId || '')
				await self.sendBridgeCommand({
					command: 'ptt',
					scope,
					targetId: targetId || undefined,
					state: String(event.options.state) as 'ptt_start' | 'ptt_stop',
				})
			},
		},
		reply_to_caller_ptt: {
			name: 'Reply to caller PTT',
			options: [
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'ptt_start',
					choices: [
						{ id: 'ptt_start', label: 'Start' },
						{ id: 'ptt_stop', label: 'Stop' },
					],
				},
			],
			callback: async (event) => {
				const targetId = self.replyDirectUserId
				if (!targetId) throw new Error('No recent direct caller to reply to')
				await self.sendBridgeCommand({
					command: 'ptt',
					scope: 'direct',
					targetId,
					state: String(event.options.state) as 'ptt_start' | 'ptt_stop',
				})
			},
		},
		send_signal: {
			name: 'Send signal',
			options: [
				{
					id: 'scope',
					type: 'dropdown',
					label: 'Scope',
					default: 'room',
					choices: scopedChoices(self),
				},
				{
					id: 'roomTargetId',
					type: 'dropdown',
					label: 'Room target',
					default: talkRooms[0]?.id ?? '',
					choices: talkRooms,
					isVisible: (options) => options.scope === 'room',
				},
				{
					id: 'directTargetId',
					type: 'dropdown',
					label: 'Direct target',
					default: users[0]?.id ?? '',
					choices: users,
					isVisible: (options) => options.scope === 'direct',
				},
				{
					id: 'broadcastTargetId',
					type: 'dropdown',
					label: 'Broadcast target',
					default: groups[0]?.id ?? '',
					choices: groups,
					isVisible: (options) => options.scope === 'broadcast',
				},
				{
					id: 'signal',
					type: 'textinput',
					label: 'Signal',
					default: 'call',
				},
			],
			callback: async (event) => {
				const scope = String(event.options.scope) as 'direct' | 'room' | 'broadcast'
				const targetId =
					scope === 'room'
						? String(event.options.roomTargetId || '')
						: scope === 'direct'
							? String(event.options.directTargetId || '')
							: String(event.options.broadcastTargetId || '')
				if (!targetId) throw new Error('targetId is required')
				await self.sendBridgeCommand({
					command: 'signal',
					scope,
					targetId,
					signal: String(event.options.signal || '').trim(),
				})
			},
		},
	}
	self.setActionDefinitions(actions)
}
