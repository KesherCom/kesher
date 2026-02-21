import type { CompanionVariableDefinition } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const defs: CompanionVariableDefinition[] = [
		{ variableId: 'bridge_connected', name: 'Bridge connected (true/false)' },
		{ variableId: 'browser_bound', name: 'Browser bound (true/false)' },
		{ variableId: 'voice_mode', name: 'Voice mode' },
		{ variableId: 'mic_live', name: 'Mic live (true/false)' },
		{ variableId: 'active_room', name: 'Active room ID' },
		{ variableId: 'listen_rooms', name: 'Selected listen room IDs (comma-separated)' },
		{ variableId: 'talk_rooms', name: 'Selected talk room IDs (comma-separated)' },
		{ variableId: 'reply_direct_user_id', name: 'Reply-to-caller direct user ID' },
		{ variableId: 'reply_direct_username', name: 'Reply-to-caller username' },
		{ variableId: 'last_command_ok', name: 'Last command successful (true/false)' },
		{ variableId: 'last_command_error', name: 'Last command error message' },
	]
	self.setVariableDefinitions(defs)
}
