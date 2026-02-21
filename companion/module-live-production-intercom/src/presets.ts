import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

export function UpdatePresets(self: ModuleInstance): void {
	const firstTalkRoom = self.getRoomChoices('talk')[0]?.id ?? ''
	const firstDirectUser = self.getUserChoices()[0]?.id ?? ''
	const firstBroadcast = self.getBroadcastChoices()[0]?.id ?? ''

	const presets: CompanionPresetDefinitions = {
		always_on: {
			type: 'button',
			category: 'Voice',
			name: 'Set always on',
			style: {
				text: 'ALWAYS\\nON',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [{ down: [{ actionId: 'set_voice_mode', options: { mode: 'always_on' } }], up: [] }],
			feedbacks: [{ feedbackId: 'voice_mode_is', options: { mode: 'always_on' } }],
		},
		ptt_mode: {
			type: 'button',
			category: 'Voice',
			name: 'Set PTT mode',
			style: {
				text: 'PTT\\nMODE',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [{ down: [{ actionId: 'set_voice_mode', options: { mode: 'ptt' } }], up: [] }],
			feedbacks: [{ feedbackId: 'voice_mode_is', options: { mode: 'ptt' } }],
		},
		room_ptt: {
			type: 'button',
			category: 'Voice',
			name: 'Room PTT (first talk room)',
			style: {
				text: 'ROOM\\nPTT',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [
				{
					down: [{ actionId: 'set_ptt', options: { scope: 'room', roomTargetId: firstTalkRoom, state: 'ptt_start' } }],
					up: [{ actionId: 'set_ptt', options: { scope: 'room', roomTargetId: firstTalkRoom, state: 'ptt_stop' } }],
				},
			],
			feedbacks: [{ feedbackId: 'mic_live', options: {} }],
		},
		direct_ptt: {
			type: 'button',
			category: 'Voice',
			name: 'Direct PTT (first user)',
			style: {
				text: 'DIRECT\\nPTT',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [
				{
					down: [{ actionId: 'set_ptt', options: { scope: 'direct', directTargetId: firstDirectUser, state: 'ptt_start' } }],
					up: [{ actionId: 'set_ptt', options: { scope: 'direct', directTargetId: firstDirectUser, state: 'ptt_stop' } }],
				},
			],
			feedbacks: [{ feedbackId: 'mic_live', options: {} }],
		},
		broadcast_ptt: {
			type: 'button',
			category: 'Voice',
			name: 'Broadcast PTT (first group)',
			style: {
				text: 'BCAST\\nPTT',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [
				{
					down: [
						{
							actionId: 'set_ptt',
							options: { scope: 'broadcast', broadcastTargetId: firstBroadcast, state: 'ptt_start' },
						},
					],
					up: [
						{
							actionId: 'set_ptt',
							options: { scope: 'broadcast', broadcastTargetId: firstBroadcast, state: 'ptt_stop' },
						},
					],
				},
			],
			feedbacks: [{ feedbackId: 'mic_live', options: {} }],
		},
		room_signal_call: {
			type: 'button',
			category: 'Signal',
			name: 'Room signal: call',
			style: {
				text: 'ROOM\\nCALL',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [
				{
					down: [
						{ actionId: 'send_signal', options: { scope: 'room', roomTargetId: firstTalkRoom, signal: 'call' } },
					],
					up: [],
				},
			],
			feedbacks: [],
		},
		command_error: {
			type: 'button',
			category: 'Status',
			name: 'Last command failed',
			style: {
				text: 'CMD\\nERROR',
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				show_topbar: false,
			},
			steps: [],
			feedbacks: [{ feedbackId: 'last_command_failed', options: {} }],
		},
	}
	self.setPresetDefinitions(presets)
}
