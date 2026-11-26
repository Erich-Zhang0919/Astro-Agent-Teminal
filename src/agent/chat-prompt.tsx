import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import chalk from 'chalk'
import stringWidth from 'string-width'
import { CHAT_ACCENT } from './chat-theme'
import type { ChatCommandDefinition, ChatCommandRegistry } from './chat-commands'

interface ChatPromptProps {
    registry: ChatCommandRegistry
    onSubmit: (value: string) => void
    busy?: boolean
    status?: string
    approval?: { prompt: string; onSubmit: (value: string) => void }
    columns: number
    maxSuggestionRows?: number
    showHelp?: boolean
    showRules?: boolean
    footerHint?: string
}

const graphemes = new Intl.Segmenter()
const emptyDraft = { value: '', cursor: 0 }
const inverseCaret = chalk.level > 0 && !process.env.NO_COLOR

function completionFor(command: ChatCommandDefinition): string {
    return `/${command.name}${command.usage.includes(' ') ? ' ' : ''}`
}

function displayText(text: string): string {
    return text.replace(/\r\n|[\r\n]/g, '↵').replace(/\t/g, '⇥')
}

function DraftLine({ value, cursor, columns }: { value: string; cursor: number; columns: number }): JSX.Element {
    const segments = graphemes.segment(value)
    const character = segments.containing(cursor)?.segment
    const caret = inverseCaret ? displayText(character ?? ' ') : `▏${displayText(character ?? '')}`
    const afterCursor = cursor + (character?.length ?? 0)
    const available = Math.max(0, columns - stringWidth(caret))
    const rightWidth = stringWidth(displayText(value.slice(afterCursor)))
    const leftLimit = Math.max(Math.floor(available / 2), available - rightWidth)

    let left = ''
    let leftWidth = 0
    let start = cursor
    while (start > 0) {
        const segment = segments.containing(start - 1)!
        const text = displayText(segment.segment)
        const width = stringWidth(text)
        if (leftWidth + width + Number(segment.index > 0) > leftLimit) break
        left = text + left
        leftWidth += width
        start = segment.index
    }
    if (start > 0 && leftLimit > leftWidth) {
        left = '…' + left
        leftWidth++
    }

    const rightLimit = available - leftWidth
    let right = ''
    let visibleRightWidth = 0
    let end = afterCursor
    while (end < value.length) {
        const segment = segments.containing(end)!
        const text = displayText(segment.segment)
        const width = stringWidth(text)
        const next = end + segment.segment.length
        if (visibleRightWidth + width + Number(next < value.length) > rightLimit) break
        right += text
        visibleRightWidth += width
        end = next
    }
    if (end < value.length && visibleRightWidth < rightLimit) right += '…'

    return <Text wrap="truncate-end">{left}<Text inverse={inverseCaret}>{caret}</Text>{right}</Text>
}

export function ChatPrompt(props: ChatPromptProps): JSX.Element {
    return <Composer key={props.approval ? 'approval' : 'chat'} {...props} />
}

function Composer({
    registry, onSubmit, busy = false, status, approval, columns: width, maxSuggestionRows = 4,
    showHelp = true, showRules = true, footerHint,
}: ChatPromptProps): JSX.Element {
    const [draft, setDraft] = useState(emptyDraft)
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
    const enabled = !busy || Boolean(approval)
    const suggestions = useMemo(() => registry.suggest(draft.value), [registry, draft.value])
    const showSuggestions = enabled && !approval && !suggestionsDismissed && maxSuggestionRows > 0 && suggestions.length > 0
    const suggestionStart = Math.max(0, selectedIndex - maxSuggestionRows + 1)
    const selected = suggestions[selectedIndex] ?? suggestions[0]

    const updateDraft = (value: string, cursor = value.length) => {
        const segment = graphemes.segment(value).containing(cursor)
        const nextCursor = segment && segment.index < cursor ? segment.index + segment.segment.length : cursor
        setDraft({ value, cursor: nextCursor })
        setSelectedIndex(0)
        setSuggestionsDismissed(false)
    }

    useInput((input, key) => {
        if (key.upArrow || key.downArrow) {
            if (showSuggestions) {
                const step = key.upArrow ? -1 : 1
                setSelectedIndex(index => (index + step + suggestions.length) % suggestions.length)
            }
            return
        }
        if (key.tab) {
            if (showSuggestions && selected) updateDraft(completionFor(selected))
            return
        }
        if (key.escape) {
            if (showSuggestions) setSuggestionsDismissed(true)
            return
        }
        if (key.return) {
            const answer = showSuggestions && selected ? completionFor(selected) : draft.value
            if (showSuggestions && answer.endsWith(' ')) {
                updateDraft(answer)
            } else if (approval || answer.trim()) {
                updateDraft('')
                const submit = approval?.onSubmit ?? onSubmit
                submit(answer)
            }
            return
        }
        const { value, cursor } = draft
        if (key.leftArrow || key.rightArrow || key.backspace || key.delete) {
            const segments = graphemes.segment(value)
            const previous = segments.containing(cursor - 1)?.index ?? 0
            const next = cursor + (segments.containing(cursor)?.segment.length ?? 0)
            if (key.leftArrow) setDraft({ value, cursor: previous })
            else if (key.rightArrow) setDraft({ value, cursor: next })
            else if (cursor > 0) updateDraft(value.slice(0, previous) + value.slice(cursor), previous)
            return
        }
        if (key.ctrl || key.meta || key.pageUp || key.pageDown) return
        const pasted = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
        if (pasted) updateDraft(value.slice(0, cursor) + pasted + value.slice(cursor), cursor + pasted.length)
    }, { isActive: enabled })

    const compact = width < 42
    const inset = width < 12 ? 0 : 2
    const contentWidth = Math.max(0, width - inset * 2)
    const rule = '┄'.repeat(contentWidth)
    const marker = approval ? '? ' : '▷ '
    const commandHint = width < 54 ? '↑/↓ · Tab · Enter · Esc' : '↑/↓ select · Tab complete · Enter run · Esc close'
    const chatHint = width < 39 ? 'Enter send · /' : 'Enter send · / commands · exit quit'
    const hint = approval
        ? 'Enter confirm · Esc deny'
        : busy
            ? footerHint ?? 'Esc cancel'
            : showSuggestions ? commandHint : chatHint
    const hintWidth = stringWidth(hint)

    return (
        <Box flexDirection="column" flexShrink={0}>
            {showSuggestions && suggestions.slice(suggestionStart, suggestionStart + maxSuggestionRows).map((command, index) => {
                const active = index + suggestionStart === selectedIndex
                return (
                    <Box key={command.name} paddingX={inset}>
                        <Text wrap="truncate-end">
                            <Text color={active ? CHAT_ACCENT : undefined} bold={active}>
                                {active ? '▸ ' : '  '}{command.usage}
                            </Text>
                            {!compact && <Text dimColor>{'  '}{command.description}</Text>}
                        </Text>
                    </Box>
                )
            })}
            <Box flexDirection="column" paddingX={inset} height={showRules ? 3 : 1}>
                {showRules && <Text color={CHAT_ACCENT} wrap="truncate-end">{rule}</Text>}
                <Box height={1}>
                    <Box flexShrink={0}>
                        <Text color={CHAT_ACCENT} bold dimColor={!enabled}>{marker}</Text>
                    </Box>
                    {enabled && (draft.value ? (
                        <DraftLine {...draft} columns={Math.max(1, contentWidth - stringWidth(marker))} />
                    ) : (
                        <Text wrap={approval ? 'truncate-middle' : 'truncate-end'}>
                            <Text inverse={inverseCaret}>{inverseCaret ? ' ' : '▏'}</Text>
                            <Text dimColor> {approval?.prompt.trimEnd() ?? 'Message Astro'}</Text>
                        </Text>
                    ))}
                </Box>
                {showRules && <Text color={CHAT_ACCENT} wrap="truncate-end">{rule}</Text>}
            </Box>
            {showHelp && (
                <Box height={1} paddingX={inset} justifyContent="space-between">
                    <Box flexShrink={0} width={Math.min(contentWidth, hintWidth)}>
                        <Text wrap="truncate-end" dimColor>{hint}</Text>
                    </Box>
                    {status && contentWidth - hintWidth >= 12 && (
                        <Box marginLeft={2} flexShrink={1}>
                            <Text wrap="truncate-start" dimColor>{status}</Text>
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    )
}
