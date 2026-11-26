import React, { useEffect, useState } from 'react'
import { Box, Static, Text, render, useInput, useStdout } from 'ink'
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { ChatPrompt } from './chat-prompt'
import { CHAT_ACCENT } from './chat-theme'
import type { ChatCommandRegistry } from './chat-commands'

type TranscriptTone = 'info' | 'error' | 'warning' | 'user' | 'reply'

interface TranscriptEntry {
    id: number
    lines: string[]
    tone: TranscriptTone
    columns: number
}

interface ChatHeaderInfo {
    id: number
    version: string
    modelId?: string
    cwd: string
    showLogo: boolean
}

interface Activity {
    label: string
    startedAt: number
}

interface ChatScreenProps {
    registry: ChatCommandRegistry
    entries: (ChatHeaderInfo | TranscriptEntry)[]
    transcriptHeight: number
    reply?: string
    activity?: Activity
    context?: string
    approval?: { prompt: string; onSubmit: (value: string) => void }
    onSubmit: (value: string) => void
    onCancel: (exit: boolean) => void
    canCancel: boolean
    acceptingInput: boolean
    closing: boolean
}

const SPINNER = ['◰', '◳', '◲', '◱']
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Each terminal cell packs a pair of pixels from the Astro triangle and orbit.
const ASTRO_MARK = [
    '.........aa.........',
    '.........aa.........',
    '........aa.a........',
    '........a..a........',
    '.......a.aa.aoooooo.',
    '.......a.aaoa....ooo',
    '......aoaaaa.a....oo',
    '.....ooaaaaaaa...oo.',
    '...ooa.aaaaaa.a.oo..',
    '..oo.a........oo....',
    '.o..a.......oo.a....',
    'oo..a.....oo...aa...',
    'oooa..oooo......a...',
    '.ooooooaaaaaaaaaaa..',
] as const
const MARK_COLORS: Record<string, string | undefined> = { a: 'whiteBright', o: CHAT_ACCENT }

function AstroMark(): JSX.Element {
    return (
        <Box flexDirection="column" width={ASTRO_MARK[0].length} marginRight={3} flexShrink={0}>
            {ASTRO_MARK.filter((_, index) => index % 2 === 0).map((top, row) => (
                <Text key={row} wrap="truncate-end">
                    {Array.from(top, (pixel, column) => {
                        const upper = MARK_COLORS[pixel]
                        const lower = MARK_COLORS[ASTRO_MARK[row * 2 + 1][column]]
                        const glyph = upper && lower === upper ? '█' : upper ? '▀' : lower ? '▄' : ' '
                        return (
                            <Text key={column} color={upper ?? lower} backgroundColor={upper !== lower && upper ? lower : undefined}>
                                {glyph}
                            </Text>
                        )
                    })}
                </Text>
            ))}
        </Box>
    )
}

function ChatHeader({ version, modelId, cwd, showLogo }: ChatHeaderInfo): JSX.Element {
    return (
        <Box paddingX={2} marginY={1} alignItems="center">
            {showLogo && <AstroMark />}
            <Box flexDirection="column" flexShrink={1}>
                <Text wrap="truncate-end">
                    <Text color={CHAT_ACCENT} bold>{showLogo ? 'Astro Agent' : '△ Astro Agent'}</Text>
                    <Text dimColor>  v{version}</Text>
                </Text>
                {modelId && <Text dimColor wrap="truncate-end">Model  ·  {modelId}</Text>}
                <Text dimColor wrap="truncate-middle">{cwd}</Text>
            </Box>
        </Box>
    )
}

function transcriptWidth(columns: number): number {
    return Math.max(1, columns - (columns < 12 ? 0 : 4) - 2)
}

function wrapTranscript(text: string, width: number): string[] {
    const clean = stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    return clean.split('\n').flatMap((line) => {
        const rows: string[] = []
        let row = ''
        let occupied = 0
        for (const { segment } of GRAPHEMES.segment(line)) {
            const size = stringWidth(segment)
            if (occupied + size > width && row) {
                rows.push(row)
                row = ''
                occupied = 0
            }
            row += segment
            occupied += size
        }
        rows.push(row)
        return rows
    })
}

function TranscriptBlock({ lines, tone, columns }: Omit<TranscriptEntry, 'id'>): JSX.Element {
    const color = tone === 'reply' ? CHAT_ACCENT
        : tone === 'user' ? 'whiteBright'
        : tone === 'error' ? 'redBright'
        : tone === 'warning' ? 'yellow'
            : undefined
    const marker = tone === 'user' ? '▷ ' : tone === 'reply' ? '✧ ' : '  '
    const width = transcriptWidth(columns)
    return (
        <Box flexDirection="column" paddingX={columns < 12 ? 0 : 2} marginBottom={1}>
            {lines.map((line, index) => (
                <Text key={index} color={color} backgroundColor={tone === 'user' ? '#233235' : undefined}
                    dimColor={tone === 'info'} wrap="truncate-end">
                    <Text color={tone === 'user' ? CHAT_ACCENT : undefined}>{index === 0 ? marker : '  '}</Text>
                    {line}
                    {tone === 'user' && ' '.repeat(Math.max(0, width - stringWidth(line)))}
                </Text>
            ))}
        </Box>
    )
}

function elapsedSeconds(startedAt: number): number {
    return Math.max(0, Math.floor((performance.now() - startedAt) / 1000))
}

function ActivityIndicator({ label, startedAt }: Activity): JSX.Element {
    const [frame, setFrame] = useState(0)
    useEffect(() => {
        const interval = setInterval(() => setFrame((value) => value + 1), 120)
        return () => clearInterval(interval)
    }, [])

    return (
        <Box paddingX={2}>
            <Text wrap="truncate-end">
                <Text color={CHAT_ACCENT} bold>{SPINNER[frame % SPINNER.length]}  {label}</Text>
                <Text dimColor> · {elapsedSeconds(startedAt)}s</Text>
            </Text>
        </Box>
    )
}

function ChatScreen(props: ChatScreenProps): JSX.Element {
    const { stdout = process.stdout } = useStdout()
    const [size, setSize] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }))
    useEffect(() => {
        const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 })
        // Update the viewport before Ink redraws against the new terminal dimensions.
        stdout.prependListener('resize', resize)
        return () => { stdout.off('resize', resize) }
    }, [stdout])

    useInput((input, key) => {
        if (key.escape && !props.acceptingInput) props.onCancel(false)
        if (key.ctrl && (input === 'c' || (input === 'd' && props.acceptingInput))) props.onCancel(true)
    })

    const frameHeight = size.rows - 1
    const showRules = size.rows >= 6
    const showHelp = size.rows > 6
    const composerHeight = (showRules ? 3 : 1) + Number(showHelp)
    const showActivity = frameHeight > composerHeight && Boolean(props.activity && !props.approval)
    const previewHeight = Math.max(0, frameHeight - composerHeight - Number(showActivity) - 1)
    const replyLines = props.reply === undefined || !previewHeight
        ? []
        : wrapTranscript(props.reply, transcriptWidth(size.columns)).slice(-previewHeight)
    const maxSuggestionRows = Math.max(0, Math.min(4, frameHeight - composerHeight))
    // Once the transcript fills the screen, the menu and spinner use the space above the composer.
    const minHeight = Math.max(frameHeight - props.transcriptHeight, composerHeight + Math.max(Number(showActivity), maxSuggestionRows))

    return (
        <>
            <Static items={props.entries}>
                {(entry) => 'lines' in entry
                    ? <TranscriptBlock key={entry.id} {...entry} />
                    : <ChatHeader key={entry.id} {...entry} />}
            </Static>
            {!props.closing && frameHeight > 0 && (
                <Box flexDirection="column" minHeight={minHeight}>
                    {replyLines.length > 0 && <TranscriptBlock tone="reply" lines={replyLines} columns={size.columns} />}
                    <Box flexGrow={1} />
                    {props.activity && showActivity && <ActivityIndicator {...props.activity} />}
                    <ChatPrompt
                        registry={props.registry}
                        onSubmit={props.onSubmit}
                        busy={!props.acceptingInput}
                        status={props.context}
                        approval={props.approval}
                        columns={size.columns}
                        maxSuggestionRows={maxSuggestionRows}
                        showHelp={showHelp}
                        showRules={showRules}
                        footerHint={props.canCancel ? undefined : ''}
                    />
                </Box>
            )}
        </>
    )
}

export function openChatTerminal(registry: ChatCommandRegistry, version: string, modelId?: string) {
    const showLogo = (process.stdout.columns || 80) >= 46 && (process.stdout.rows || 24) >= 14
    const cleanMetadata = (text: string) => stripVTControlCharacters(text).replace(/[\r\n\t]/g, ' ')
    const header: ChatHeaderInfo = {
        id: 0,
        version,
        cwd: cleanMetadata(process.cwd()),
        modelId: modelId && cleanMetadata(modelId),
        showLogo,
    }
    let entries: (ChatHeaderInfo | TranscriptEntry)[] = [header]
    let transcriptHeight = 2 + (showLogo ? ASTRO_MARK.length / 2 : modelId ? 3 : 2)
    let reply: string | undefined
    let activity: Activity | undefined
    let context: string | undefined
    let resolveInput: ((value: string) => void) | undefined
    let approval: ChatScreenProps['approval']
    let resolveApproval: ((value: string | undefined) => void) | undefined
    let cancelTurn: (() => void) | undefined
    let closing = false
    let exitRequested = false
    let renderError: Error | undefined
    let renderTimer: ReturnType<typeof setTimeout> | undefined

    const settleInput = (text: string) => {
        const resolve = resolveInput
        resolveInput = undefined
        resolve?.(text)
    }
    const settleApproval = (text: string | undefined) => {
        const resolve = resolveApproval
        resolveApproval = undefined
        approval = undefined
        resolve?.(text)
    }

    const onSubmit = (text: string) => {
        if (text.trim()) settleInput(text)
    }
    const onCancel = (exit: boolean) => {
        if (!exit && approval) {
            settleApproval(undefined)
        } else if (cancelTurn) {
            cancelTurn()
            settleApproval(undefined)
        } else if (exit) {
            exitRequested = true
            settleInput('exit')
        }
    }

    const appendEntry = (text: string, tone: TranscriptTone) => {
        const columns = process.stdout.columns || 80
        const lines = wrapTranscript(text, transcriptWidth(columns))
        transcriptHeight += lines.length + 1
        entries = [...entries, { id: entries.length, lines, tone, columns }]
    }

    const screen = () => (
        <ChatScreen
            {...{ registry, entries, transcriptHeight, reply, activity, context, approval, onSubmit, onCancel, closing }}
            acceptingInput={Boolean(resolveInput)}
            canCancel={Boolean(cancelTurn)}
        />
    )
    // Clear the visible screen and return to row one, keeping the scrollback buffer.
    process.stdout.write('\x1b[2J\x1b[H')
    const instance = render(screen(), { exitOnCtrlC: false })
    const redraw = () => {
        clearTimeout(renderTimer)
        renderTimer = undefined
        if (!renderError) instance.rerender(screen())
    }
    void instance.waitUntilExit().catch((error: Error) => {
        renderError = error
        cancelTurn?.()
        settleApproval(undefined)
        settleInput('exit')
    })

    return {
        readInput: async () => {
            if (renderError) throw renderError
            if (exitRequested) return 'exit'
            activity = undefined
            cancelTurn = undefined
            const text = await new Promise<string>((resolve) => {
                resolveInput = resolve
                redraw()
            })
            if (renderError) throw renderError
            return text
        },
        readApproval: (prompt: string) => new Promise<string | undefined>((resolve) => {
            if (renderError) return resolve(undefined)
            resolveApproval = resolve
            approval = {
                prompt,
                onSubmit: (text) => { settleApproval(text); redraw() },
            }
            redraw()
        }),
        setActivity: (label: string | undefined, cancel?: () => void) => {
            activity = label ? { label, startedAt: activity?.startedAt ?? performance.now() } : undefined
            cancelTurn = cancel
            redraw()
        },
        completeTurn: () => {
            if (!activity) return
            appendEntry(`✓  Completed in ${elapsedSeconds(activity.startedAt)}s`, 'info')
            activity = undefined
            cancelTurn = undefined
            redraw()
        },
        setContext: (text: string | undefined) => {
            context = text
            redraw()
        },
        write: (text: string, tone: TranscriptTone = 'info') => {
            const message = text.replace(/^\n+|\n+$/g, '')
            if (!message) return
            appendEntry(message, tone)
            redraw()
        },
        startReply: () => { reply = '' },
        appendReply: (text: string) => {
            reply = (reply ?? '') + text
            if (!renderTimer) renderTimer = setTimeout(redraw, 32)
        },
        finishReply: () => {
            if (reply) appendEntry(reply.replace(/\n+$/, ''), 'reply')
            reply = undefined
            redraw()
        },
        close: () => {
            closing = true
            redraw()
            instance.unmount()
        },
    }
}
