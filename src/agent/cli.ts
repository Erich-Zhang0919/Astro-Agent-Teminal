import * as readline from 'readline'
import { runAgentStream } from './agent'

// 历史记录由 agent.js 的 checkpointer 自动持久化，这里只需固定 thread_id
const THREAD_ID = 'user-session-1'

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

function prompt(question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve))
}

async function chat(userInput: string): Promise<void> {
    rl.pause() // 暂停 readline，避免光标错位

    process.stdout.write('\nAI: ')

    await runAgentStream(
        userInput,
        (token: string) => {
            process.stdout.write(token)
        },
        THREAD_ID,
    )

    process.stdout.write('\n\n')
    rl.resume() // 恢复 readline
}

async function main(): Promise<void> {
    console.log('=== Agent 聊天控制台 (输入 "exit" 退出) ===\n')

    while (true) {
        const userInput = await prompt('You: ')

        if (!userInput.trim()) continue
        if (userInput.toLowerCase() === 'exit') {
            console.log('再见！')
            rl.close()
            break
        }

        try {
            await chat(userInput)
        } catch (err) {
            console.error('请求出错:', (err as Error).message)
        }
    }
}

main()