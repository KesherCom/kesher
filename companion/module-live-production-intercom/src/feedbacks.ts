import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

export function UpdateFeedbacks(self: ModuleInstance): void {
	const roomChoices = self.getRoomChoices('all')
	const feedbacks: CompanionFeedbackDefinitions = {
		bridge_connected: {
			name: 'Bridge connected',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 120, 0),
			},
			options: [],
			callback: () => self.bridgeConnected,
		},
		browser_bound: {
			name: 'Browser bound',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 90, 170),
			},
			options: [],
			callback: () => self.bound,
		},
		mic_live: {
			name: 'Mic live',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(180, 0, 0),
			},
			options: [],
			callback: () => self.micEnabled,
		},
		last_command_failed: {
			name: 'Last command failed',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(160, 0, 0),
			},
			options: [],
			callback: () => !self.lastCommandOK,
		},
		voice_mode_is: {
			name: 'Voice mode equals',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(230, 180, 0),
			},
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'always_on',
					choices: [
						{ id: 'always_on', label: 'Always on' },
						{ id: 'ptt', label: 'PTT' },
					],
				},
			],
			callback: (feedback) => self.voiceMode === String(feedback.options.mode),
		},
		active_room_is: {
			name: 'Active room equals',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(100, 0, 130),
			},
			options: [
				{
					id: 'roomId',
					type: 'dropdown',
					label: 'Room',
					default: roomChoices[0]?.id ?? '',
					choices: roomChoices,
				},
			],
			callback: (feedback) => self.activeRoom === String(feedback.options.roomId || ''),
		},
		listen_room_selected: {
			name: 'Listen room selected',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 100, 170),
			},
			options: [
				{
					id: 'roomId',
					type: 'dropdown',
					label: 'Room',
					default: roomChoices[0]?.id ?? '',
					choices: roomChoices,
				},
			],
			callback: (feedback) => self.listenRooms.includes(String(feedback.options.roomId || '')),
		},
		talk_room_selected: {
			name: 'Talk room selected',
			type: 'boolean',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(170, 60, 0),
			},
			options: [
				{
					id: 'roomId',
					type: 'dropdown',
					label: 'Room',
					default: roomChoices[0]?.id ?? '',
					choices: roomChoices,
				},
			],
			callback: (feedback) => self.talkRooms.includes(String(feedback.options.roomId || '')),
		},
	}
	self.setFeedbackDefinitions(feedbacks)
}
