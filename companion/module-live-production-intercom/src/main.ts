import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import type { CommandPayload, CompanionInbound, DiscoveryResponse } from './types.js'

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig
	private ws: WebSocket | null = null
	private reconnectTimer: NodeJS.Timeout | null = null
	private reconnectAttempts = 0
	private commandSeq = 0
	private pendingCommands = new Map<
		string,
		{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>()

	public bridgeConnected = false
	public bound = false
	public micEnabled = false
	public voiceMode = 'ptt'
	public activeRoom = ''
	public listenRooms: string[] = []
	public talkRooms: string[] = []
	public replyDirectUserId = ''
	public replyDirectUsername = ''
	public lastCommandOK = true
	public lastCommandError = ''
	public discovery: DiscoveryResponse = {
		username: '',
		roleId: '',
		rooms: [],
		users: [],
		broadcastGroups: [],
	}

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		await this.refreshDiscovery()
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()
		this.connectBridge()
	}

	async destroy(): Promise<void> {
		this.clearReconnectTimer()
		this.ws?.close()
		this.ws = null
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		await this.refreshDiscovery()
		this.connectBridge()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
		this.updateVariableValues()
	}

	getRoomChoices(filter: 'all' | 'talk' | 'listen' = 'all'): Array<{ id: string; label: string }> {
		return this.discovery.rooms
			.filter((room) => {
				if (filter === 'talk') return room.canTalk
				if (filter === 'listen') return room.canListen
				return true
			})
			.map((room) => ({ id: room.id, label: room.name }))
	}

	getUserChoices(): Array<{ id: string; label: string }> {
		const me = this.discovery.username
		return this.discovery.users
			.filter((u) => u.username !== me)
			.map((u) => ({ id: u.id, label: `${u.username} (${u.roleId})` }))
	}

	getBroadcastChoices(): Array<{ id: string; label: string }> {
		return this.discovery.broadcastGroups.map((g) => ({ id: g.id, label: g.name }))
	}

	private baseHttpURL(): string {
		const protocol = this.config.useTls ? 'https' : 'http'
		return `${protocol}://${this.config.host}:${this.config.port}`
	}

	async refreshDiscovery(): Promise<void> {
		const host = (this.config.host || '').trim()
		const username = (this.config.username || '').trim()
		if (!host || !username) return
		const url = `${this.baseHttpURL()}/api/companion/discovery?username=${encodeURIComponent(username)}`
		try {
			const res = await fetch(url)
			if (!res.ok) {
				throw new Error(`discovery failed (${res.status})`)
			}
			const data = (await res.json()) as DiscoveryResponse
			this.discovery = data
			this.updateActions()
			this.updateFeedbacks()
		} catch (err) {
			this.log('warn', `Discovery refresh failed: ${err instanceof Error ? err.message : 'unknown error'}`)
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	private scheduleReconnect(): void {
		this.clearReconnectTimer()
		this.reconnectAttempts += 1
		const delayMs = Math.min(8000, 500 * 2 ** Math.min(5, this.reconnectAttempts))
		this.reconnectTimer = setTimeout(() => this.connectBridge(), delayMs)
	}

	private connectBridge(): void {
		this.clearReconnectTimer()
		this.ws?.close()
		this.ws = null

		const host = (this.config.host || '').trim()
		const username = (this.config.username || '').trim()
		if (!host || !username) {
			this.updateStatus(InstanceStatus.BadConfig, 'host and username are required')
			this.bridgeConnected = false
			this.bound = false
			this.micEnabled = false
			this.listenRooms = []
			this.talkRooms = []
			this.replyDirectUserId = ''
			this.replyDirectUsername = ''
			this.lastCommandOK = false
			this.lastCommandError = 'bridge not configured'
			this.updateVariableValues()
			this.checkFeedbacks()
			return
		}

		const wsProtocol = this.config.useTls ? 'wss' : 'ws'
		const url = `${wsProtocol}://${host}:${this.config.port}/api/companion/ws?username=${encodeURIComponent(username)}`
		this.updateStatus(InstanceStatus.Connecting)
		const ws = new WebSocket(url)
		this.ws = ws

		ws.onopen = () => {
			this.reconnectAttempts = 0
			this.bridgeConnected = true
			this.updateStatus(InstanceStatus.Ok)
			void this.refreshDiscovery()
			this.updateVariableValues()
			this.checkFeedbacks()
		}

		ws.onmessage = (event: MessageEvent<string>) => {
			const payload = JSON.parse(event.data) as CompanionInbound
			if (payload.type === 'companion_command_result') {
				const commandID = String(payload.data.commandId || '')
				const pending = this.pendingCommands.get(commandID)
				if (pending) {
					clearTimeout(pending.timer)
					this.pendingCommands.delete(commandID)
					if (payload.data.ok) {
						this.lastCommandOK = true
						this.lastCommandError = ''
						pending.resolve()
					} else {
						const errorMsg = payload.data.error || 'command failed'
						this.lastCommandOK = false
						this.lastCommandError = errorMsg
						pending.reject(new Error(errorMsg))
					}
				} else if (!payload.data.ok) {
					this.lastCommandOK = false
					this.lastCommandError = payload.data.error || 'command failed'
				}
				this.updateVariableValues()
				this.checkFeedbacks()
				return
			}
			if (payload.type !== 'companion_state') return
			this.bound = payload.data.bound
			this.voiceMode = payload.data.presence?.voiceMode || 'ptt'
			this.micEnabled = !!payload.data.presence?.micEnabled
			this.activeRoom = payload.data.presence?.activeRoom || ''
			this.listenRooms = payload.data.presence?.listenRooms || []
			this.talkRooms = payload.data.presence?.talkRooms || []
			this.replyDirectUserId = payload.data.replyDirectUserId || ''
			this.replyDirectUsername = payload.data.replyDirectUsername || ''
			this.updateVariableValues()
			this.checkFeedbacks()
		}

		ws.onclose = () => {
			this.bridgeConnected = false
			this.bound = false
			this.micEnabled = false
			this.listenRooms = []
			this.talkRooms = []
			this.replyDirectUserId = ''
			this.replyDirectUsername = ''
			this.lastCommandOK = false
			this.lastCommandError = 'bridge disconnected'
			for (const pending of this.pendingCommands.values()) {
				clearTimeout(pending.timer)
				pending.reject(new Error('bridge disconnected'))
			}
			this.pendingCommands.clear()
			this.updateStatus(InstanceStatus.ConnectionFailure)
			this.updateVariableValues()
			this.checkFeedbacks()
			this.scheduleReconnect()
		}

		ws.onerror = () => {
			ws.close()
		}
	}

	private updateVariableValues(): void {
		this.setVariableValues({
			bridge_connected: this.bridgeConnected ? 'true' : 'false',
			browser_bound: this.bound ? 'true' : 'false',
			voice_mode: this.voiceMode,
			mic_live: this.micEnabled ? 'true' : 'false',
			active_room: this.activeRoom,
			listen_rooms: this.listenRooms.join(','),
			talk_rooms: this.talkRooms.join(','),
			reply_direct_user_id: this.replyDirectUserId,
			reply_direct_username: this.replyDirectUsername,
			last_command_ok: this.lastCommandOK ? 'true' : 'false',
			last_command_error: this.lastCommandError,
		})
	}

	async sendBridgeCommand(payload: CommandPayload): Promise<void> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.lastCommandOK = false
			this.lastCommandError = 'bridge is disconnected'
			this.updateVariableValues()
			this.checkFeedbacks()
			throw new Error('bridge is disconnected')
		}
		this.commandSeq += 1
		const commandID = `cmd-${Date.now()}-${this.commandSeq}`
		const payloadWithID: CommandPayload = { ...payload, commandId: commandID }
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(commandID)
				this.lastCommandOK = false
				this.lastCommandError = 'command timeout'
				this.updateVariableValues()
				this.checkFeedbacks()
				reject(new Error('command timeout'))
			}, 5000)
			this.pendingCommands.set(commandID, { resolve, reject, timer })
			this.ws?.send(
				JSON.stringify({
					type: 'command',
					data: payloadWithID,
				}),
			)
		})
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
