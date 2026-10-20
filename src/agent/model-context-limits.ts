// Official API documentation checked 2026-10-20. These are fallbacks only;
// /models metadata takes precedence. K/M-only specifications use conservative
// decimal counts rather than assuming a larger binary window.
const deepseek: Record<string, number> = {
    // https://api-docs.deepseek.com/api/list-models/
    'deepseek-flash': 1_048_576,
    'deepseek-v4-pro': 1_048_576,
    // https://api-docs.deepseek.com/quick_start/pricing/
    'deepseek-v4-flash': 1_048_576,
    'deepseek-v4-flash-vision-exp': 1_048_576,
}

const minimax: Record<string, number> = {
    // https://platform.minimax.io/docs/api-reference/text-openai-api
    'MiniMax-M3.1-Flash': 1_000_000,
    'MiniMax-M3': 1_000_000,
    // Legacy pay-as-you-go models, scheduled to retire 2026-11-18.
    // https://platform.minimax.io/docs/faq/models
    // https://huggingface.co/MiniMaxAI/MiniMax-M2.7/blob/main/config.json
    'MiniMax-M2.7': 204_800,
    'MiniMax-M2.7-highspeed': 204_800,
    // https://huggingface.co/MiniMaxAI/MiniMax-M2.5/blob/main/config.json
    'MiniMax-M2.5': 196_608,
    'MiniMax-M2.5-highspeed': 196_608,
}

const glm: Record<string, number> = {
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
    'glm-5.3': 1_000_000,
    // https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
    'glm-5.3-flash': 1_000_000,
    'glm-5.3-flashx': 1_000_000,
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2
    'glm-5.2': 1_000_000,
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-5.1
    'glm-5.1': 200_000,
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-5
    'glm-5': 200_000,
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7
    'glm-4.7': 200_000,
    'glm-4.7-flashx': 200_000,
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-4.6
    'glm-4.6': 200_000,
    // https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5
    'glm-4.5': 128_000,
    'glm-4.5-air': 128_000,
    'glm-4.5-airx': 128_000,
    'glm-4.5-x': 128_000,
    'glm-4.5-flash': 128_000,
}

const qwen: Record<string, number> = {
    // https://help.aliyun.com/zh/model-studio/text-generation-model
    'qwen3.8-max': 1_000_000,
    'qwen3.8-max-0902': 1_000_000,
    'qwen3.8-flash': 1_000_000,
    'qwen3.7-plus': 1_000_000,
    'qwen3.7-plus-2026-05-26': 1_000_000,
    'qwen3.7-flash': 1_000_000,
    'qwen3.7-flash-2026-07-15': 1_000_000,
    'qwen3.7-max': 1_000_000,
    'qwen3.7-max-preview': 1_000_000,
    'qwen3.7-max-2026-06-08': 1_000_000,
    'qwen3.7-max-2026-05-20': 1_000_000,
    'qwen3.7-max-2026-05-17': 1_000_000,
    'qwen3.6-plus': 1_000_000,
    'qwen3.6-plus-2026-04-02': 1_000_000,
    'qwen3.6-flash': 1_000_000,
    'qwen3.6-flash-2026-04-16': 1_000_000,
    'qwen3.5-plus': 1_000_000,
    'qwen3.5-plus-2026-02-15': 1_000_000,
    'qwen3.5-plus-2026-04-20': 1_000_000,
    'qwen3.5-flash': 1_000_000,
    'qwen3.5-flash-2026-02-23': 1_000_000,
    'qwen3.5-397b-a17b': 256_000,
    'qwen3.5-122b-a10b': 256_000,
    'qwen3.5-27b': 256_000,
    'qwen3.5-35b-a3b': 256_000,
    'qwen3-coder-flash': 1_000_000,
    'qwen3-coder-flash-2025-07-28': 1_000_000,
    'qwen3-coder-plus': 1_000_000,
    'qwen3-coder-plus-2025-09-23': 1_000_000,
    'qwen3-coder-plus-2025-07-22': 1_000_000,
    // https://help.aliyun.com/zh/model-studio/coding-plan-faq
    'qwen3-coder-next': 262_144,
    'qwen3-max-2026-01-23': 262_144,
    // https://help.aliyun.com/zh/model-studio/model-qwen3-max
    'qwen3-max': 262_144,
    // https://help.aliyun.com/zh/model-studio/qwen-turbo
    'qwen-turbo': 131_072,
    // https://help.aliyun.com/zh/model-studio/text-generation-model
    'qwen-plus': 1_000_000,
    'qwen-flash': 1_000_000,
    'qwen-max': 32_000,
    'qwen-long': 10_000_000,
}

const mimo: Record<string, number> = {
    // https://mimo.mi.com/docs/zh-CN/quick-start/summary/model
    'mimo-v2.6-pro': 1_000_000,
    'mimo-v2.6-flash': 1_000_000,
    'mimo-v2.6-pro-ultraspeed': 1_000_000,
    // Scheduled to retire 2026-10-21 at 10:00 Asia/Shanghai.
    'mimo-v2.5': 1_000_000,
    'mimo-v2.5-pro': 1_000_000,
}

const limitsByHost: Record<string, Record<string, number>> = {
    'api.deepseek.com': deepseek,
    'api.minimax.io': minimax,
    'api.minimax.cn': minimax,
    'api.minimaxi.com': minimax,
    'open.bigmodel.cn': glm,
    'dashscope.aliyuncs.com': qwen,
    'dashscope-intl.aliyuncs.com': qwen,
    'dashscope-us.aliyuncs.com': qwen,
    'coding.dashscope.aliyuncs.com': qwen,
    'api.xiaomimimo.com': mimo,
}

export function getFallbackContextWindow(modelId: string, baseUrl: string): number | undefined {
    try {
        // Exact host and model IDs: proxies, unknown variants and future model
        // versions may impose different limits and must remain unknown.
        const host = new URL(baseUrl).hostname
        const limits = Object.hasOwn(limitsByHost, host) ? limitsByHost[host] : undefined
        return limits && Object.hasOwn(limits, modelId) ? limits[modelId] : undefined
    } catch {
        return undefined
    }
}
