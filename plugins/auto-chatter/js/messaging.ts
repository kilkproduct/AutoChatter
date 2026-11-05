import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import {
	DEFAULT_DISCORD_MESSAGE_LIMIT,
	OBSERVED_MAX_DISCORD_MESSAGE_LIMIT,
} from './validation'
import type { SendOutcome } from './types'

interface DiscordMessageLengthHelper {
	getMaxMessageLength(): number
}

function resolveLengthHelper(
	value: unknown,
): DiscordMessageLengthHelper | undefined {
	if (value === null || typeof value !== 'object') return undefined
	const record = value as Record<string, unknown>
	if (typeof record.getMaxMessageLength === 'function') {
		return record as unknown as DiscordMessageLengthHelper
	}
	const defaultExport = record.default
	if (defaultExport !== null && typeof defaultExport === 'object') {
		const nested = defaultExport as Record<string, unknown>
		if (typeof nested.getMaxMessageLength === 'function') {
			return nested as unknown as DiscordMessageLengthHelper
		}
	}
	return undefined
}

/**
 * Messaging is intentionally fail-closed. Current Valenced public API declarations and source do
 * not expose a supported Discord message-send interface. Discord's private
 * MessageActionCreators.sendMessage is deliberately not imported or called here.
 *
 * The read-only maximum-length helper is discovered for parity with Discord's composer; if it is
 * absent, AutoChatter falls back to the ordinary 2,000-character limit. This helper is not a send
 * API and does not enable the sender.
 */
class MessagingAdapter {
	private maxLengthHelper: DiscordMessageLengthHelper | undefined
	private unsubscribe: (() => void) | undefined
	private onLimitChange: (() => void) | undefined

	start(onLimitChange: () => void): () => void {
		this.stop()
		this.onLimitChange = onLimitChange
		this.unsubscribe = getModules(
			withProps<DiscordMessageLengthHelper>('getMaxMessageLength'),
			module => {
				const helper = resolveLengthHelper(module)
				if (!helper) return
				this.maxLengthHelper = helper
				this.onLimitChange?.()
			},
		)
		return () => this.stop()
	}

	stop(): void {
		this.unsubscribe?.()
		this.unsubscribe = undefined
		this.maxLengthHelper = undefined
		this.onLimitChange = undefined
	}

	isAvailable(): boolean {
		return false
	}

	maxMessageLength(): number {
		try {
			const value = this.maxLengthHelper?.getMaxMessageLength()
			if (
				typeof value === 'number' &&
				Number.isSafeInteger(value) &&
				value > 0 &&
				value <= OBSERVED_MAX_DISCORD_MESSAGE_LIMIT
			) {
				return value
			}
		} catch {
			// Discord's helper is version-specific; use the conservative standard limit.
		}
		return DEFAULT_DISCORD_MESSAGE_LIMIT
	}

	async send(_channelId: string, _content: string): Promise<SendOutcome> {
		return {
			kind: 'unavailable',
			reason: 'Valenced does not currently document or expose a supported message-send API for plugins.',
		}
	}
}

export const discordMessaging = new MessagingAdapter()
