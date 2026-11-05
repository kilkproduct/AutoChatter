/*
 * Narrow TypeScript fallback declarations for the exact Valenced 1.3.0 APIs used here.
 * Source: Valenced/valenced-types commit c67dd726d1ec28b38d8ac93862fdd3b6029b1d29.
 * That upstream package's package.json `files` list omits its .d.ts files when installed from
 * Git, so this file supplies only the declarations needed for local typechecking. It adds no
 * runtime implementation and must be kept aligned with the official declarations.
 */

interface AutoChatterJsonStorage<T extends object> {
	loaded: boolean
	cache?: T | Record<string, unknown>
	get(): Promise<T>
	set(value: Partial<T> | T, replace?: boolean): Promise<void>
	use(): T | undefined
	subscribe(callback: (update: Partial<T>, mode: number) => void): () => void
}

declare module '@valenced/json-storage' {
	export type JsonStorage<T extends object> = AutoChatterJsonStorage<T>
}

declare module '@valenced/discord/types' {
	export namespace DiscordModules {
		namespace Flux {
			type Store<T = object> = T & {
				addChangeListener(callback: () => void): void
				removeChangeListener(callback: () => void): void
			}
		}
	}
}

declare module '@valenced/discord/flux' {
	import type { DiscordModules } from '@valenced/discord/types'

	export const Stores: Record<string, DiscordModules.Flux.Store<object>>
	export function getStore<T>(
		name: string,
		callback: (store: DiscordModules.Flux.Store<T>) => void,
	): () => void
}

declare module '@valenced/plugins/types' {
	import type { FunctionComponent } from 'react'

	export interface PluginApiExtensionsOptions {
		jsonStorage?: object
	}

	export interface PluginApi<O extends PluginApiExtensionsOptions = PluginApiExtensionsOptions> {
		cleanup(...functions: Array<() => unknown>): void
		jsonStorage: AutoChatterJsonStorage<NonNullable<O['jsonStorage']>>
		plugin: { reportError(error: unknown): void }
	}

	export interface PluginSettingsComponent<
		O extends PluginApiExtensionsOptions = PluginApiExtensionsOptions,
	> extends FunctionComponent<{ api: PluginApi<O> }> {}
}

declare module '@valenced/modules/finders' {
	export function getModules<T>(
		filter: unknown,
		callback: (module: T) => void,
	): () => void
}

declare module '@valenced/modules/finders/filters' {
	export function withProps<T>(...properties: string[]): unknown
}

declare module '@valenced/components' {
	import type { ComponentType, ReactNode } from 'react'
	import type { ViewProps } from 'react-native'

	export const Page: ComponentType<ViewProps & { children?: ReactNode }>
}

declare module '@valenced/discord/design' {
	import type { ComponentType, ReactNode } from 'react'
	import type {
		PressableProps,
		StyleProp,
		TextStyle,
		ViewProps,
		ViewStyle,
	} from 'react-native'

	interface ButtonProps extends PressableProps {
		text: string
		size?: 'sm' | 'md' | 'lg'
		variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive'
		disabled?: boolean
	}

	interface CardProps extends ViewProps {
		variant?: 'primary' | 'secondary' | 'transparent'
		border?: 'faint' | 'normal' | 'strong' | 'subtle' | 'none'
		children?: ReactNode
	}

	interface StackProps extends ViewProps {
		spacing?: number
		direction?: 'vertical' | 'horizontal'
	}

	interface TableRowProps {
		label: ReactNode
		subLabel?: ReactNode
		trailing?: ReactNode
		disabled?: boolean
	}

	interface TableSwitchRowProps extends TableRowProps {
		value: boolean
		onValueChange(value: boolean): void
	}

	interface TableRowGroupProps {
		title?: string
		description?: string
		hasIcons?: boolean
		accessibilityLabel?: string
		children?: ReactNode
	}

	interface TableRadioGroupProps<T = string> extends TableRowGroupProps {
		children: ReactNode
		onChange(value: T): void
		value?: T
		defaultValue?: T
	}

	interface TableRadioRowProps<T = string> extends TableRowProps {
		label: string
		value: T
	}

	interface TextInputProps {
		label?: string
		value?: string
		onChange?(value: string): void
		onBlur?(): void
		maxLength?: number
		multiline?: boolean
		placeholder?: string
		description?: string
		status?: 'default' | 'error'
		errorMessage?: string
		editable?: boolean
		style?: StyleProp<ViewStyle>
	}

	interface TextProps {
		variant?: string
		color?: string
		style?: StyleProp<TextStyle>
		children?: ReactNode
	}

	interface DesignApi {
		Button: ComponentType<ButtonProps>
		Card: ComponentType<CardProps>
		Stack: ComponentType<StackProps>
		TableRadioGroup: <T>(props: TableRadioGroupProps<T>) => React.ReactElement
		TableRadioRow: <T>(props: TableRadioRowProps<T>) => React.ReactElement
		TableRow: ComponentType<TableRowProps>
		TableRowGroup: ComponentType<TableRowGroupProps>
		TableSwitchRow: ComponentType<TableSwitchRowProps>
		Text: ComponentType<TextProps>
		TextInput: ComponentType<TextInputProps>
	}

	export const Design: DesignApi
}

declare function plugin<O extends import('@valenced/plugins/types').PluginApiExtensionsOptions>(
	options: {
		jsonStorage?: {
			load?: boolean
			default?: NonNullable<O['jsonStorage']>
		}
		start?: (api: import('@valenced/plugins/types').PluginApi<O>) => unknown
		stop?: (api: import('@valenced/plugins/types').PluginApi<O>) => unknown
		SettingsComponent?: import('@valenced/plugins/types').PluginSettingsComponent<O>
	},
): unknown
