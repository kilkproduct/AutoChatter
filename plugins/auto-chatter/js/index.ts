import {
	getCurrentChannel,
	inspectChannelForSend,
	subscribeToChannelStores,
} from './channels'
import { isAppForegrounded, subscribeToAppState } from './lifecycle'
import { discordMessaging } from './messaging'
import { AutoChatterScheduler, setActiveScheduler } from './scheduler'
import SettingsComponent from './settings'
import { settingsStore } from './storage'
import { createRuntimeSessionId, DEFAULT_SETTINGS } from './validation'
import type { AutoChatterSettings, SchedulerClock } from './types'

let sessionSequence = 0

export default plugin<{ jsonStorage: AutoChatterSettings }>({
	jsonStorage: {
		load: true,
		default: DEFAULT_SETTINGS,
	},

	start({ cleanup, jsonStorage, plugin: pluginInstance }) {
		let scheduler: AutoChatterScheduler | undefined
		let disposed = false
		let foreground = isAppForegrounded()
		const clock: SchedulerClock = {
			now: () => Date.now(),
			setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimeout: handle => clearTimeout(handle),
		}

		const unsubscribeAppState = subscribeToAppState(active => {
			foreground = active
			scheduler?.onAppStateChange(active)
		})
		const unsubscribeChannels = subscribeToChannelStores(() => {
			scheduler?.onChannelContextChanged()
		})
		const unsubscribeSettings = settingsStore.subscribe(
			(settings, source) => {
				if (source === 'user') scheduler?.updateSettings(settings)
			},
		)

		settingsStore.setStorageErrorHandler(error => {
			const message =
				error instanceof Error ? error.message : String(error)
			pluginInstance.reportError(
				new Error(`[AutoChatter] Storage error: ${message}`),
			)
		})

		cleanup(() => {
			disposed = true
			scheduler?.stop()
			setActiveScheduler(undefined)
			discordMessaging.stop()
			settingsStore.setStorageErrorHandler(undefined)
		})
		cleanup(unsubscribeSettings, unsubscribeChannels, unsubscribeAppState)

		void settingsStore
			.load(jsonStorage, Date.now())
			.then(settings => {
				if (disposed) return

				const clockSessionId = createRuntimeSessionId(Date.now())
				const sessionId = `${clockSessionId}:${++sessionSequence}`
				scheduler = new AutoChatterScheduler(settings, {
					clock,
					isForeground: () => foreground,
					getCurrentChannel,
					inspectChannel: inspectChannelForSend,
					getMessageLimit: () => discordMessaging.maxMessageLength(),
					isSendApiAvailable: () => discordMessaging.isAvailable(),
					sendMessage: (channelId, message) =>
						discordMessaging.send(channelId, message),
					persist: snapshot =>
						settingsStore.replace(snapshot, 'scheduler'),
					newAttemptId: () =>
						`${Date.now().toString(36)}-${++sessionSequence}`,
					log: (level, message) => {
						if (level === 'error')
							console.error(`[AutoChatter] ${message}`)
						else console.warn(`[AutoChatter] ${message}`)
					},
				})
				setActiveScheduler(scheduler)
				cleanup(
					discordMessaging.start(() =>
						scheduler?.onMessagingAvailable(),
					),
				)
				scheduler.start(sessionId, foreground)
			})
			.catch(error => {
				const message =
					error instanceof Error ? error.message : String(error)
				pluginInstance.reportError(
					new Error(
						`[AutoChatter] Could not load settings: ${message}`,
					),
				)
			})
	},

	SettingsComponent,
})
