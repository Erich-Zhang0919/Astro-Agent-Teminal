import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, render, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { Instance } from 'ink'
import type { ChatCommandDefinition, ChatCommandRegistry } from './chat-commands'

interface ChatPromptProps {
    registry: ChatCommandRegistry
    onSubmit: (value: string) => void
}

export function ChatPrompt({ registry, onSubmit }: ChatPromptProps): JSX.Element {
    const [value, setValue] = useState('')
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
    const suggestions = useMemo(() => registry.suggest(value), [registry, value])
    const visibleSuggestions = suggestionsDismissed ? [] : suggestions

    useEffect(() => {
        setSelectedIndex(0)
    }, [value])

    const updateValue = (nextValue: string) => {
        setValue(nextValue)
        setSuggestionsDismissed(false)
    }

    const completeCommand = (command: ChatCommandDefinition) => {
        updateValue(command.usage.includes(' ') ? `/${command.name} ` : `/${command.name}`)
    }

    useInput((_input, key) => {
        if (visibleSuggestions.length === 0) return

        if (key.upArrow) {
            setSelectedIndex((current) =>
                current === 0 ? visibleSuggestions.length - 1 : current - 1,
            )
            return
        }

        if (key.downArrow) {
            setSelectedIndex((current) => (current + 1) % visibleSuggestions.length)
            return
        }

        if (key.tab) {
            const command = visibleSuggestions[selectedIndex] ?? visibleSuggestions[0]
            if (command) completeCommand(command)
            return
        }

        if (key.escape) {
            setSuggestionsDismissed(true)
        }
    })

    const submitValue = (submittedValue: string) => {
        const command = visibleSuggestions[selectedIndex] ?? visibleSuggestions[0]
        if (command) {
            const completion = command.usage.includes(' ')
                ? `/${command.name} `
                : `/${command.name}`

            if (completion.endsWith(' ')) {
                updateValue(completion)
                return
            }

            onSubmit(completion)
            return
        }

        onSubmit(submittedValue)
    }

    const usageWidth = visibleSuggestions.reduce(
        (width, command) => Math.max(width, command.usage.length),
        0,
    )

    return (
        <Box flexDirection="column">
            {visibleSuggestions.length > 0 && (
                <Box
                    flexDirection="column"
                    borderStyle="single"
                    borderColor="cyan"
                    paddingX={1}
                >
                    {visibleSuggestions.map((command, index) => {
                        const selected = index === selectedIndex
                        return (
                            <Text key={command.name} color={selected ? 'cyan' : undefined} bold={selected}>
                                {selected ? '› ' : '  '}
                                {command.usage.padEnd(usageWidth)}  {command.description}
                            </Text>
                        )
                    })}
                </Box>
            )}

            <Box>
                <Text color="green" bold>You: </Text>
                <TextInput
                    value={value}
                    onChange={updateValue}
                    onSubmit={submitValue}
                    placeholder="Type a message or / for commands"
                />
            </Box>

            {visibleSuggestions.length > 0 && (
                <Text dimColor>↑/↓ select · Tab complete · Enter confirm · Esc close</Text>
            )}
        </Box>
    )
}

export function promptWithSuggestions(registry: ChatCommandRegistry): Promise<string> {
    return new Promise((resolve) => {
        let instance: Instance

        const submit = (value: string) => {
            instance.clear()
            instance.unmount()
            resolve(value)
        }

        instance = render(
            <ChatPrompt registry={registry} onSubmit={submit} />,
            { exitOnCtrlC: true, patchConsole: false },
        )
    })
}
