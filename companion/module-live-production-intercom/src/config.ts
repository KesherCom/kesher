import type { SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
	host: string
	port: number
	useTls: boolean
	username: string
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Backend host',
			default: '127.0.0.1',
			width: 8,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Backend port',
			default: 8080,
			min: 1,
			max: 65535,
			width: 4,
		},
		{
			type: 'checkbox',
			id: 'useTls',
			label: 'Use TLS (wss)',
			default: false,
			width: 4,
		},
		{
			type: 'textinput',
			id: 'username',
			label: 'Target username',
			default: '',
			width: 8,
		},
	]
}
