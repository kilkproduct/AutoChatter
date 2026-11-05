import { getStore, Stores } from '@valenced/discord/flux'
import type { DiscordModules } from '@valenced/discord/types'
import type {
	AutoChatterSettings,
	ChannelEligibility,
	ChannelEligibilityReason,
	CurrentChannel,
} from './types'

const GUILD_TEXT = 0
const GUILD_VOICE = 2
const GUILD_ANNOUNCEMENT = 5
const PUBLIC_THREAD = 11
const PRIVATE_THREAD = 12
const NEWS_THREAD = 10
const DM = 1
const GROUP_DM = 3

// Discord permission bits: VIEW_CHANNEL=1<<10, SEND_MESSAGES=1<<11,
// SEND_MESSAGES_IN_THREADS=1<<38. PermissionStore.can is the client-side permission check.
const VIEW_CHANNEL = 1n << 10n
const SEND_MESSAGES = 1n << 11n
const SEND_MESSAGES_IN_THREADS = 1n << 38n

type FluxStore<T> = DiscordModules.Flux.Store<T>

type ChannelLike = {
	id?: string | number
	name?: string | null
	type?: number
	guild_id?: string | null
	recipients?: unknown
	isPrivate?: () => boolean
	thread_metadata?: { archived?: boolean; locked?: boolean }
	threadMetadata?: { archived?: boolean; locked?: boolean }
}

type ChannelStoreApi = {
	getChannel?(id: string): unknown
	getSortedPrivateChannels?(): unknown
}

type GuildStoreApi = {
	getGuilds?(): unknown
}

type ChannelListStoreApi = {
	getGuild?(guildId: string): unknown
}

type PermissionStoreApi = {
	can?(permission: bigint, channel: unknown): boolean
}

type UserStoreApi = {
	getUser?(id: string): unknown
}

export interface AccessibleChannel {
	id: string
	name: string
	guildId: string | null
	guildName: string
	kind: 'guild' | 'dm'
}

export interface ChannelGroup {
	id: string
	title: string
	kind: 'guild' | 'dm'
	channels: AccessibleChannel[]
}

export interface ChannelDiscovery {
	available: boolean
	groups: ChannelGroup[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function store<T>(name: string): FluxStore<T> | undefined {
	try {
		const value = (Stores as unknown as Record<string, unknown>)[name]
		return value && typeof value === 'object'
			? (value as FluxStore<T>)
			: undefined
	} catch {
		return undefined
	}
}

function snowflake(value: unknown): string | undefined {
	return typeof value === 'string' && /^\d{1,22}$/.test(value)
		? value
		: undefined
}

function channelObject(value: unknown): ChannelLike | undefined {
	const record = asRecord(value)
	if (!record) return undefined
	return record as ChannelLike
}

function channelStore(): FluxStore<ChannelStoreApi> | undefined {
	return store<ChannelStoreApi>('ChannelStore')
}

function channelById(id: string): ChannelLike | undefined {
	try {
		const raw = channelStore()?.getChannel?.(id)
		const channel = channelObject(raw)
		return snowflake(channel?.id) ? channel : undefined
	} catch {
		return undefined
	}
}

function channelType(channel: ChannelLike): number | undefined {
	return typeof channel.type === 'number' && Number.isInteger(channel.type)
		? channel.type
		: undefined
}

function isPrivateChannel(channel: ChannelLike): boolean {
	try {
		if (typeof channel.isPrivate === 'function') return channel.isPrivate()
	} catch {
		return false
	}
	const type = channelType(channel)
	return type === DM || type === GROUP_DM
}

function isSupportedChannelType(channel: ChannelLike): boolean {
	const type = channelType(channel)
	return (
		type === GUILD_TEXT ||
		type === GUILD_VOICE ||
		type === GUILD_ANNOUNCEMENT ||
		type === NEWS_THREAD ||
		type === PUBLIC_THREAD ||
		type === PRIVATE_THREAD ||
		type === DM ||
		type === GROUP_DM
	)
}

function isThread(channel: ChannelLike): boolean {
	const type = channelType(channel)
	return (
		type === NEWS_THREAD ||
		type === PUBLIC_THREAD ||
		type === PRIVATE_THREAD
	)
}

function threadIsLocked(channel: ChannelLike): boolean {
	const meta = channel.thread_metadata ?? channel.threadMetadata
	return meta?.archived === true || meta?.locked === true
}

function isListedPrivateChannel(channelId: string): boolean {
	try {
		const privateChannels = channelStore()?.getSortedPrivateChannels?.()
		return (
			Array.isArray(privateChannels) &&
			privateChannels.some(
				value => snowflake(asRecord(value)?.id) === channelId,
			)
		)
	} catch {
		return false
	}
}

function canSendToChannel(channel: ChannelLike): ChannelEligibility {
	if (!isSupportedChannelType(channel)) {
		return { allowed: false, reason: 'unsupported-channel' }
	}
	if (threadIsLocked(channel)) {
		return { allowed: false, reason: 'no-send-permission' }
	}

	const permissions = store<PermissionStoreApi>('PermissionStore')
	if (typeof permissions?.can !== 'function') {
		return { allowed: false, reason: 'no-send-permission' }
	}

	try {
		if (isPrivateChannel(channel)) {
			const channelId = snowflake(channel.id)
			if (!channelId || !isListedPrivateChannel(channelId)) {
				return { allowed: false, reason: 'inaccessible' }
			}
			return permissions.can(SEND_MESSAGES, channel)
				? { allowed: true, reason: 'eligible' }
				: { allowed: false, reason: 'no-send-permission' }
		}

		if (!permissions.can(VIEW_CHANNEL, channel)) {
			return { allowed: false, reason: 'inaccessible' }
		}
		const canSend = permissions.can(SEND_MESSAGES, channel)
		const canSendInThread = isThread(channel)
			? permissions.can(SEND_MESSAGES_IN_THREADS, channel)
			: false
		return canSend || canSendInThread
			? { allowed: true, reason: 'eligible' }
			: { allowed: false, reason: 'no-send-permission' }
	} catch {
		return { allowed: false, reason: 'no-send-permission' }
	}
}

function channelLabel(channel: ChannelLike): string {
	const name =
		typeof channel.name === 'string' && channel.name.length > 0
			? channel.name
			: undefined
	const type = channelType(channel)
	if (type === DM || type === GROUP_DM) {
		if (name) return name
		if (type === DM) {
			const recipientIds = Array.isArray(channel.recipients)
				? channel.recipients
						.map(snowflake)
						.filter((id): id is string => id !== undefined)
				: []
			if (recipientIds.length > 0) {
				try {
					const user = store<UserStoreApi>('UserStore')?.getUser?.(
						recipientIds[0]!,
					)
					const username = asRecord(user)?.username
					if (typeof username === 'string' && username.length > 0)
						return `DM with ${username}`
				} catch {
					// Fall through to the non-identifying label.
				}
			}
			return 'Direct message'
		}
		return 'Group DM'
	}
	return name ? `#${name}` : 'Unnamed channel'
}

function categoryValues(value: unknown): unknown[] {
	if (value instanceof Map) return [...value.values()]
	if (Array.isArray(value)) return value
	const record = asRecord(value)
	return record ? Object.values(record) : []
}

function channelIdsFromGuildList(result: unknown): string[] {
	const root = asRecord(result)
	const list = asRecord(root?.guildChannels) ?? root
	if (!list) return []

	const categories = [
		...categoryValues(list.categories),
		list.noParentCategory,
		list.favoritesCategory,
		list.recentsCategory,
		list.voiceChannelsCategory,
	].filter(value => value !== undefined && value !== null)

	const ids = new Set<string>()
	for (const category of categories) {
		const channels = asRecord(category)?.channels
		for (const item of categoryValues(channels)) {
			const wrapper = asRecord(item)
			const rawChannel = asRecord(wrapper?.record) ?? wrapper
			const id = snowflake(rawChannel?.id)
			if (id) ids.add(id)
		}
	}
	return [...ids]
}

function guildEntries(): Array<{ id: string; name: string }> {
	let value: unknown
	try {
		value = store<GuildStoreApi>('GuildStore')?.getGuilds?.()
	} catch {
		return []
	}
	const record = asRecord(value)
	if (!record) return []
	const output: Array<{ id: string; name: string }> = []
	for (const guildValue of Object.values(record)) {
		const guild = asRecord(guildValue)
		const id = snowflake(guild?.id)
		if (!id) continue
		output.push({
			id,
			name:
				typeof guild?.name === 'string' && guild.name.length > 0
					? guild.name
					: 'Server',
		})
	}
	return output
}

function makeAccessibleChannel(
	id: string,
	guildId: string | null,
	guildTitle: string,
	kind: AccessibleChannel['kind'],
): AccessibleChannel | undefined {
	const channel = channelById(id)
	if (!channel || !canSendToChannel(channel).allowed) return undefined
	return {
		id,
		name: channelLabel(channel),
		guildId,
		guildName: guildTitle,
		kind,
	}
}

/**
 * Uses ChannelListStore's server channel tree, then re-reads each ID from ChannelStore and
 * checks VIEW_CHANNEL/SEND_MESSAGES. DMs must still be listed in Discord's current sorted
 * private-channel list and pass the current SEND_MESSAGES permission check.
 */
export function discoverAccessibleChannels(): ChannelDiscovery {
	const channelListStore = store<ChannelListStoreApi>('ChannelListStore')
	const guilds = guildEntries()
	const groups: ChannelGroup[] = []
	let discoveryAvailable = typeof channelListStore?.getGuild === 'function'

	for (const guild of guilds) {
		let channelList: unknown
		try {
			channelList = channelListStore?.getGuild?.(guild.id)
		} catch {
			channelList = undefined
		}
		if (channelList !== undefined) discoveryAvailable = true
		const channels = channelIdsFromGuildList(channelList)
			.map(id => makeAccessibleChannel(id, guild.id, guild.name, 'guild'))
			.filter(
				(channel): channel is AccessibleChannel =>
					channel !== undefined,
			)
			.sort((left, right) => left.name.localeCompare(right.name))
		if (channels.length > 0) {
			groups.push({
				id: guild.id,
				title: guild.name,
				kind: 'guild',
				channels,
			})
		}
	}

	const privateChannels: unknown[] = (() => {
		try {
			const value = channelStore()?.getSortedPrivateChannels?.()
			return Array.isArray(value) ? value : []
		} catch {
			return []
		}
	})()
	if (privateChannels.length > 0) discoveryAvailable = true
	const directMessages = new Map<string, AccessibleChannel>()
	for (const value of privateChannels) {
		const id = snowflake(asRecord(value)?.id)
		if (!id) continue
		const channel = makeAccessibleChannel(id, null, 'Direct Messages', 'dm')
		if (channel) directMessages.set(id, channel)
	}
	if (directMessages.size > 0) {
		groups.push({
			id: 'direct-messages',
			title: 'Direct Messages',
			kind: 'dm',
			channels: [...directMessages.values()],
		})
	}

	return { available: discoveryAvailable, groups }
}

export function getCurrentChannel(): CurrentChannel | null {
	try {
		const selected = store<{ getChannelId?(): unknown }>(
			'SelectedChannelStore',
		)
		const id = snowflake(selected?.getChannelId?.())
		if (!id) return null
		const channel = channelById(id)
		if (!channel) return { id, label: 'Unavailable channel' }
		return { id, label: channelLabel(channel) }
	} catch {
		return null
	}
}

export function inspectChannelForSend(
	channelId: string,
	selectedChannels: readonly string[],
): ChannelEligibility {
	if (!selectedChannels.includes(channelId)) {
		return { allowed: false, reason: 'not-selected' }
	}
	const channel = channelById(channelId)
	if (!channel) return { allowed: false, reason: 'inaccessible' }
	return canSendToChannel(channel)
}

export function selectedChannelCount(settings: AutoChatterSettings): number {
	return settings.selectedChannels.length
}

function watchNamedStore(name: string, onChange: () => void): () => void {
	let removeListener: (() => void) | undefined
	const stopWaiting = getStore<Record<string, unknown>>(
		name,
		storeInstance => {
			const listener = () => onChange()
			storeInstance.addChangeListener(listener)
			removeListener = () => storeInstance.removeChangeListener(listener)
		},
	)
	return () => {
		stopWaiting()
		removeListener?.()
	}
}

/** Change listeners used by both the scheduler and the channel picker; caller owns cleanup. */
export function subscribeToChannelStores(onChange: () => void): () => void {
	const unsubscribers = [
		watchNamedStore('SelectedChannelStore', onChange),
		watchNamedStore('ChannelStore', onChange),
		watchNamedStore('ChannelListStore', onChange),
		watchNamedStore('GuildStore', onChange),
		watchNamedStore('PermissionStore', onChange),
	]
	return () => {
		for (const unsubscribe of unsubscribers.reverse()) unsubscribe()
	}
}

export function channelEligibilityMessage(
	reason: ChannelEligibilityReason,
): string {
	switch (reason) {
		case 'eligible':
			return 'Selected and sendable'
		case 'no-channel':
			return 'No channel is open'
		case 'not-selected':
			return 'The current channel is not selected'
		case 'inaccessible':
			return 'The current channel is no longer accessible'
		case 'no-send-permission':
			return 'Discord does not currently allow sending here'
		case 'unsupported-channel':
			return 'This channel type does not support plain-text sends'
	}
}
