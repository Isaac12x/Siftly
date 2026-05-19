import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { resolveAnthropicClient } from './claude-cli-auth'
import { resolveMiniMaxClient } from './minimax-auth'
import { resolveLocalOpenAIClient, resolveOpenAIClient } from './openai-auth'
import { createLocalChatCompletion } from './local-ai'
import { getLocalBaseUrl, getProvider } from './settings'

export interface AIContentBlock {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | AIContentBlock[]
}

export interface AIResponse {
  text: string
}

export interface AIClient {
  provider: 'anthropic' | 'openai' | 'minimax' | 'local'
  createMessage(params: {
    model: string
    max_tokens: number
    messages: AIMessage[]
  }): Promise<AIResponse>
}

// Wrap Anthropic SDK
export class AnthropicAIClient implements AIClient {
  provider = 'anthropic' as const
  constructor(private sdk: Anthropic) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const messages = params.messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content }
      }
      const blocks = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: b.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: b.source.data,
            },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      return { role: m.role as 'user' | 'assistant', content: blocks }
    })

    const msg = await this.sdk.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    const textBlock = msg.content.find(b => b.type === 'text')
    return { text: textBlock && 'text' in textBlock ? textBlock.text : '' }
  }
}

// Wrap OpenAI SDK
export class OpenAIAIClient implements AIClient {
  constructor(
    private sdk: OpenAI,
    public provider: 'openai' | 'local' = 'openai',
    private localConfig?: { baseURL: string; apiKey: string },
  ) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    if (this.provider === 'local') {
      if (!this.localConfig) throw new Error('Missing local endpoint configuration')

      const localMessages = params.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => {
              if (b.type === 'image' && b.source) {
                return {
                  type: 'image_url' as const,
                  image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
                }
              }
              return { type: 'text' as const, text: b.text ?? '' }
            }),
      }))

      const completion = await createLocalChatCompletion({
        baseUrl: this.localConfig.baseURL,
        apiKey: this.localConfig.apiKey,
        model: params.model,
        maxTokens: params.max_tokens,
        messages: localMessages,
      })

      return { text: completion.text }
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = params.messages.map((m): OpenAI.ChatCompletionMessageParam => {
      if (typeof m.content === 'string') {
        if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content }
        return { role: 'user' as const, content: m.content }
      }
      const parts: OpenAI.ChatCompletionContentPart[] = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      if (m.role === 'assistant') return { role: 'assistant' as const, content: parts.map(p => p.type === 'text' ? p : p).filter((p): p is OpenAI.ChatCompletionContentPartText => p.type === 'text') }
      return { role: 'user' as const, content: parts }
    })

    const completion = await this.sdk.chat.completions.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    return { text: completion.choices[0]?.message?.content ?? '' }
  }
}

// Wrap MiniMax via OpenAI-compatible SDK (temperature clamped to (0, 1])
export class MiniMaxAIClient implements AIClient {
  provider = 'minimax' as const
  constructor(private sdk: OpenAI) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = params.messages.map((m): OpenAI.ChatCompletionMessageParam => {
      if (typeof m.content === 'string') {
        if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content }
        return { role: 'user' as const, content: m.content }
      }
      const parts: OpenAI.ChatCompletionContentPart[] = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      if (m.role === 'assistant') return { role: 'assistant' as const, content: parts.filter((p): p is OpenAI.ChatCompletionContentPartText => p.type === 'text') }
      return { role: 'user' as const, content: parts }
    })

    const completion = await this.sdk.chat.completions.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    let text = completion.choices[0]?.message?.content ?? ''
    // Strip thinking tags that MiniMax M2.5+ may include
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    return { text }
  }
}

export async function resolveAIClient(options: {
  overrideKey?: string
  dbKey?: string
} = {}): Promise<AIClient> {
  const provider = await getProvider()

  if (provider === 'minimax') {
    const client = resolveMiniMaxClient(options)
    return new MiniMaxAIClient(client)
  }

  if (provider === 'openai') {
    const client = resolveOpenAIClient(options)
    return new OpenAIAIClient(client, 'openai')
  }

  if (provider === 'local') {
    const baseURL = await getLocalBaseUrl()
    const client = resolveLocalOpenAIClient({ ...options, baseURL })
    const apiKey =
      options.overrideKey?.trim() ||
      options.dbKey?.trim() ||
      process.env.LOCAL_AI_API_KEY?.trim() ||
      'local'
    return new OpenAIAIClient(client, 'local', { baseURL, apiKey })
  }

  const client = resolveAnthropicClient(options)
  return new AnthropicAIClient(client)
}
