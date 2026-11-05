import { Page } from '@valenced/components'
import { Design } from '@valenced/discord/design'
import { useEffect, useState } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import {
	discoverAccessibleChannels,
	subscribeToChannelStores,
} from './channels'
import { discordMessaging } from './messaging'
import {
	getSchedulerSnapshot,
	retryPendingSend,
	subscribeToScheduler,
} from './scheduler'
import { settingsStore } from './storage'
import {
	DEFAULT_MESSAGE,
	DEFAULT_SETTINGS,
	formatInterval,
	formatTimeRemaining,
	formatTimestamp,
	parseIntervalSeconds,
	validateMessage,
} from './validation'
import type { PluginSettingsComponent } from '@valenced/plugins/types'
import type { ComponentProps } from 'react'
import type { AutoChatterSettings, SchedulerSnapshot } from './types'

const {
	Button,
	Card,
	Stack,
	TableRadioGroup,
	TableRadioRow,
	TableRow,
	TableRowGroup,
	TableSwitchRow,
	Text,
	TextInput,
} = Design

type Props = ComponentProps<
	PluginSettingsComponent<{ jsonStorage: AutoChatterSettings }>
>

function statusLabel(snapshot: SchedulerSnapshot): string {
	switch (snapshot.status) {
		case 'disabled':
			return 'Disabled'
		case 'waiting-interval':
			return 'Waiting for interval'
		case 'waiting-activity':
			return 'Waiting for user activity'
		case 'grace-period':
			return '10-minute foreground grace period'
		case 'waiting-channel':
			return 'Waiting for selected channel'
		case 'ready':
			return 'Ready to send'
		case 'sending':
			return 'Sending'
		case 'send-failed':
			return 'Send failed — held safely'
		case 'send-unavailable':
			return 'Supported Valenced send API unavailable'
		case 'invalid-message':
			return 'Message needs attention'
	}
}

function destinationDetail(snapshot: SchedulerSnapshot): string {
	if (!snapshot.currentChannel) return 'No channel is currently open.'
	switch (snapshot.currentChannelEligibility.reason) {
		case 'eligible':
			return 'Selected and currently sendable.'
		case 'no-channel':
			return 'No channel is currently open.'
		case 'not-selected':
			return 'Not selected. AutoChatter will not send here.'
		case 'inaccessible':
			return 'No longer accessible. No other channel will be used.'
		case 'no-send-permission':
			return 'Discord currently denies sending in this channel.'
		case 'unsupported-channel':
			return 'This channel type does not support plain-text messages.'
	}
}

function nextMessageLabel(snapshot: SchedulerSnapshot, now: number): string {
	if (snapshot.status === 'disabled')
		return 'Paused while AutoChatter is disabled.'
	if (snapshot.status === 'grace-period' && snapshot.graceEndsAt !== null) {
		return `Grace period ends ${formatTimeRemaining(snapshot.graceEndsAt - now).replace(/^In /, 'in ')}.`
	}
	if (snapshot.pendingSend)
		return 'One message is overdue; no missed messages are queued.'
	if (snapshot.nextSendAt === null)
		return 'The interval starts when AutoChatter is enabled.'
	if (snapshot.nextSendAt <= now)
		return 'Overdue; waiting for the current channel to be eligible.'
	return formatTimeRemaining(snapshot.nextSendAt - now)
}

function removeSelection(
	settings: AutoChatterSettings,
	channelId: string,
): string[] {
	return settings.selectedChannels.filter(id => id !== channelId)
}

export default function Settings({ api }: Props) {
	const persisted = api.jsonStorage.use()
	const settings = persisted ?? DEFAULT_SETTINGS
	const maxMessageLength = discordMessaging.maxMessageLength()
	const [messageDraft, setMessageDraft] = useState(settings.message)
	const [messageError, setMessageError] = useState<string | undefined>()
	const [intervalDraft, setIntervalDraft] = useState(
		String(settings.intervalSeconds),
	)
	const [intervalError, setIntervalError] = useState<string | undefined>()
	const [snapshot, setSnapshot] = useState(getSchedulerSnapshot())
	const [ready, setReady] = useState(settingsStore.isReady)
	const [, setChannelRevision] = useState(0)

	useEffect(() => {
		setMessageDraft(settings.message)
		setMessageError(undefined)
	}, [settings.message])

	useEffect(() => {
		setIntervalDraft(String(settings.intervalSeconds))
		setIntervalError(undefined)
	}, [settings.intervalSeconds])

	useEffect(() => subscribeToScheduler(setSnapshot), [])
	useEffect(
		() =>
			settingsStore.subscribe((_settings, source) => {
				if (source === 'load' || settingsStore.isReady) setReady(true)
			}),
		[],
	)
	useEffect(
		() =>
			subscribeToChannelStores(() =>
				setChannelRevision(value => value + 1),
			),
		[],
	)

	const discovery = discoverAccessibleChannels()
	const availableIds = new Set(
		discovery.groups.flatMap(group =>
			group.channels.map(channel => channel.id),
		),
	)
	const staleSelected = discovery.available
		? settings.selectedChannels.filter(id => !availableIds.has(id))
		: []
	const messageValidation = validateMessage(messageDraft, maxMessageLength)
	const now = Date.now()

	const saveMessageDraft = (value: string) => {
		setMessageDraft(value)
		const validation = validateMessage(value, maxMessageLength)
		if (!validation.valid) {
			setMessageError(validation.error)
			return
		}
		setMessageError(undefined)
		void settingsStore
			.update({ message: value, messagePreset: 'custom' }, 'user')
			.catch(() => setMessageError('Could not save this message.'))
	}

	const commitInterval = () => {
		const validation = parseIntervalSeconds(intervalDraft)
		if (!validation.valid || validation.value === undefined) {
			setIntervalError(validation.error ?? 'Enter a valid interval.')
			return
		}
		setIntervalError(undefined)
		void settingsStore
			.update({ intervalSeconds: validation.value }, 'user')
			.catch(() => {
				setIntervalError('Could not save this interval.')
			})
	}

	const toggleChannel = (channelId: string, selected: boolean) => {
		const next = new Set(settings.selectedChannels)
		if (selected) next.add(channelId)
		else next.delete(channelId)
		void settingsStore.update({ selectedChannels: [...next] }, 'user')
	}

	const retry = () => {
		if (snapshot.sendAttemptState === 'uncertain') {
			Alert.alert(
				'Delivery could not be confirmed',
				'The message may already have been delivered. Retrying can create a duplicate. Retry once anyway?',
				[
					{ text: 'Cancel', style: 'cancel' },
					{
						text: 'Retry anyway',
						style: 'destructive',
						onPress: () => retryPendingSend(true),
					},
				],
			)
			return
		}
		retryPendingSend(false)
	}

	return (
		<Page>
			<ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
				<Stack spacing={20}>
					<Card variant="secondary" border="none">
						<View
							style={{
								paddingHorizontal: 16,
								paddingVertical: 14,
							}}
						>
							<Text
								variant="heading-md/semibold"
								color="text-default"
							>
								AutoChatter
							</Text>
							<Text
								variant="text-sm/normal"
								color="text-muted"
								style={{ marginTop: 6 }}
							>
								Schedules your configured plain-text message for
								only the channel you are viewing, and only after
								you select it here. Delivery stays disabled
								until Valenced confirms a supported send API.
							</Text>
						</View>
					</Card>

					<TableRowGroup title="Status" hasIcons>
						<TableRow
							label="Messaging capability"
							subLabel="Sending is disabled: the current Valenced public API does not confirm a supported message-send method. No private Discord sender is used."
						/>
						<TableSwitchRow
							label="Enable AutoChatter"
							subLabel="The first interval starts when you enable it. No channel is selected by default."
							value={settings.enabled}
							disabled={!ready}
							onValueChange={enabled => {
								void settingsStore.update({ enabled }, 'user')
							}}
						/>
						<TableRow
							label="Scheduler"
							subLabel={
								snapshot.statusDetail || statusLabel(snapshot)
							}
							trailing={
								<Text variant="text-sm/semibold">
									{statusLabel(snapshot)}
								</Text>
							}
						/>
						<TableRow
							label="Current channel"
							subLabel={destinationDetail(snapshot)}
							trailing={
								<Text variant="text-sm/medium">
									{snapshot.currentChannel?.label ?? 'None'}
								</Text>
							}
						/>
						<TableRow
							label="Selected channels"
							subLabel="AutoChatter never chooses a destination on its own."
							trailing={
								<Text variant="text-sm/medium">
									{settings.selectedChannels.length}
								</Text>
							}
						/>
						<TableRow
							label="Next message"
							subLabel={nextMessageLabel(snapshot, now)}
							trailing={
								snapshot.nextSendAt !== null &&
								snapshot.nextSendAt > now ? (
									<Text variant="text-sm/medium">
										{new Date(
											snapshot.nextSendAt,
										).toLocaleString()}
									</Text>
								) : undefined
							}
						/>
						<TableRow
							label="Last successful send"
							subLabel={formatTimestamp(
								settings.lastSuccessfulSendAt,
							)}
						/>
						{snapshot.status === 'send-failed' ||
						snapshot.status === 'ready' ? (
							<View
								style={{
									paddingHorizontal: 16,
									paddingVertical: 8,
								}}
							>
								<Button
									text={
										snapshot.status === 'ready'
											? 'Send pending message now'
											: 'Retry pending message'
									}
									disabled={!ready || !snapshot.appActive}
									size="sm"
									variant="secondary"
									onPress={retry}
								/>
							</View>
						) : null}
					</TableRowGroup>

					<TableRowGroup
						title="Message"
						description="Only this exact text is sent. AutoChatter does not append or format anything."
						hasIcons
					>
						<TableRadioGroup
							value={settings.messagePreset}
							onChange={(preset: string) => {
								if (!ready) return
								if (preset === 'meow') {
									setMessageDraft(DEFAULT_MESSAGE)
									setMessageError(undefined)
									void settingsStore.update(
										{
											message: DEFAULT_MESSAGE,
											messagePreset: 'meow',
										},
										'user',
									)
								} else {
									void settingsStore.update(
										{ messagePreset: 'custom' },
										'user',
									)
								}
							}}
						>
							<TableRadioRow
								label="Meow preset"
								subLabel="Meow, a blank line, then mrrrp meow meow"
								value="meow"
							/>
							<TableRadioRow
								label="Custom message"
								subLabel="Write and save your own plain-text message."
								value="custom"
							/>
						</TableRadioGroup>
						<View
							style={{
								paddingHorizontal: 16,
								paddingVertical: 8,
							}}
						>
							<TextInput
								label="Message"
								value={messageDraft}
								onChange={saveMessageDraft}
								multiline
								maxLength={maxMessageLength}
								editable={ready}
								style={{ minHeight: 112 }}
								placeholder="Enter the exact message to send"
								description={`${messageDraft.length} / ${maxMessageLength} characters`}
								status={messageError ? 'error' : 'default'}
								errorMessage={messageError}
							/>
						</View>
						<TableRow
							label="Preview"
							subLabel={
								messageDraft.length > 0
									? messageDraft
									: 'The message cannot be empty.'
							}
						/>
						{!messageValidation.valid && !messageError ? (
							<TableRow
								label="Message validation"
								subLabel={messageValidation.error}
							/>
						) : null}
					</TableRowGroup>

					<TableRowGroup
						title="Interval"
						description="Integer seconds. The absolute minimum is 600 seconds (10 minutes). There is no app-imposed upper limit."
						hasIcons
					>
						<View
							style={{
								paddingHorizontal: 16,
								paddingVertical: 8,
							}}
						>
							<TextInput
								label="Interval in seconds"
								value={intervalDraft}
								editable={ready}
								onChange={setIntervalDraft}
								onBlur={commitInterval}
								placeholder="7200"
								description={`Current interval: ${formatInterval(settings.intervalSeconds)}. Changes are saved when you leave the field.`}
								status={intervalError ? 'error' : 'default'}
								errorMessage={intervalError}
							/>
						</View>
					</TableRowGroup>

					<TableRowGroup
						title="Channel selection"
						description="Only accessible channels with a current send-permission check are listed. Select each channel explicitly; zero are selected initially."
						hasIcons
					>
						{!discovery.available ? (
							<TableRow
								label="Channel list unavailable"
								subLabel="Discord has not exposed its channel list to this screen yet. Reopen settings after the channel list loads."
							/>
						) : null}
						{discovery.available &&
						discovery.groups.length === 0 ? (
							<TableRow
								label="No sendable channels found"
								subLabel="Channels without view or send permission are intentionally omitted."
							/>
						) : null}
						{discovery.groups.flatMap(group =>
							group.channels.map(channel => (
								<TableSwitchRow
									key={channel.id}
									label={channel.name}
									subLabel={
										group.kind === 'dm'
											? 'Direct Messages'
											: group.title
									}
									disabled={!ready}
									value={settings.selectedChannels.includes(
										channel.id,
									)}
									onValueChange={selected =>
										toggleChannel(channel.id, selected)
									}
								/>
							)),
						)}
						{staleSelected.length > 0 ? (
							<TableRow
								label="Unavailable selections"
								subLabel="These channel IDs are no longer accessible and will never be used as fallbacks. Turn off each row to remove it."
							/>
						) : null}
						{staleSelected.map(channelId => (
							<TableSwitchRow
								key={channelId}
								label="Unavailable channel"
								subLabel={channelId}
								disabled={!ready}
								value
								onValueChange={selected => {
									if (!selected) {
										void settingsStore.update(
											{
												selectedChannels:
													removeSelection(
														settings,
														channelId,
													),
											},
											'user',
										)
									}
								}}
							/>
						))}
					</TableRowGroup>
				</Stack>
			</ScrollView>
		</Page>
	)
}
