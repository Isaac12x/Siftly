import prisma from '@/lib/db'
import { buildImageContext } from '@/lib/image-context'
import { getCliAvailability, claudePrompt, modelNameToCliAlias } from '@/lib/claude-cli-auth'
import { getCodexCliAvailability, codexPrompt } from '@/lib/codex-cli'
import { getActiveModel, getApiKeySettingKey, getProvider } from '@/lib/settings'
import { AIClient, resolveAIClient } from '@/lib/ai-client'

const BATCH_SIZE = 20
const CATEGORIZATION_MIN_TOKENS = 2_048
const CATEGORIZATION_MAX_TOKENS = 8_192
const TAXONOMY_BATCH_SIZE = 80
const TAXONOMY_DISCOVERY_BOOKMARK_LIMIT = 480
const TAXONOMY_CANDIDATE_LIMIT = 120
const TAXONOMY_MAX_CATEGORIES = 32
const TAXONOMY_MAX_TOKENS = 6_144

const DISCOVERED_CATEGORY_COLORS = [
  '#8b5cf6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#3b82f6',
  '#14b8a6',
  '#f97316',
  '#a855f7',
  '#eab308',
  '#ef4444',
  '#6366f1',
]

class CategorizationParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CategorizationParseError'
  }
}

export const DEFAULT_CATEGORIES = [
  {
    name: 'AI & Machine Learning',
    slug: 'ai-resources',
    color: '#8b5cf6',
    description:
      'Artificial intelligence, machine learning, LLMs, ChatGPT, Claude, Gemini, Grok, Midjourney, Sora, AI agents, RAG, fine-tuning, prompts, vector databases, model benchmarks, AI startups, AI safety, multimodal models',
    isAiGenerated: false,
  },
  {
    name: 'Crypto & Web3',
    slug: 'finance-crypto',
    color: '#f59e0b',
    description:
      'Cryptocurrency, Bitcoin, Ethereum, Solana, DeFi protocols, NFTs, on-chain activity, crypto trading, altcoins, airdrops, memecoin, Web3 development, smart contracts, DAOs, Layer 2, Uniswap, pump.fun, wallets, blockchain analytics',
    isAiGenerated: false,
  },
  {
    name: 'Dev Tools & Engineering',
    slug: 'dev-tools',
    color: '#06b6d4',
    description:
      'Software engineering, coding, GitHub, open source, frameworks, APIs, databases, DevOps, CI/CD, terminal tools, debugging, system design, backend, frontend, mobile dev, Rust, Go, TypeScript, Python, Vercel, Supabase, Docker',
    isAiGenerated: false,
  },
  {
    name: 'Finance & Investing',
    slug: 'finance-investing',
    color: '#10b981',
    description:
      'Stock market, equities, options trading, macroeconomics, Federal Reserve, interest rates, hedge funds, venture capital, private equity, earnings reports, portfolio management, real estate investing, commodities, forex, financial charts — NOT crypto',
    isAiGenerated: false,
  },
  {
    name: 'Startups & Business',
    slug: 'startups-business',
    color: '#f97316',
    description:
      'Startups, founders, entrepreneurship, SaaS, product-market fit, fundraising, VC, angel investing, growth hacking, B2B, marketing, sales, revenue, bootstrapping, Y Combinator, acquisition, company building, business strategy',
    isAiGenerated: false,
  },
  {
    name: 'News & Politics',
    slug: 'news',
    color: '#6366f1',
    description:
      'Breaking news, current events, US politics, global politics, geopolitics, government policy, elections, regulation, tech policy, AI regulation, crypto regulation, war and conflict, international relations, journalism, investigative reporting',
    isAiGenerated: false,
  },
  {
    name: 'Design & Product',
    slug: 'design',
    color: '#ec4899',
    description:
      'UI/UX design, product design, visual design, Figma, typography, design systems, motion design, brand identity, user research, product strategy, wireframes, creative tools, color theory, web design, app design',
    isAiGenerated: false,
  },
  {
    name: 'Health & Wellness',
    slug: 'health-wellness',
    color: '#14b8a6',
    description:
      'Fitness, nutrition, longevity, biohacking, sleep, mental health, supplements, workout routines, diet, weight loss, strength training, cognitive performance, stress management, meditation, gut health, lab results, wearables like Whoop and Oura',
    isAiGenerated: false,
  },
  {
    name: 'Security & Privacy',
    slug: 'security-privacy',
    color: '#ef4444',
    description:
      'Cybersecurity, hacking, exploits, vulnerabilities, OPSEC, privacy tools, VPNs, encryption, threat intelligence, social engineering, phishing, malware, zero-days, pen testing, CTF, data breaches, authentication, identity security',
    isAiGenerated: false,
  },
  {
    name: 'Science & Research',
    slug: 'science-research',
    color: '#3b82f6',
    description:
      'Scientific research, papers, discoveries, physics, biology, neuroscience, space exploration, climate, chemistry, medical breakthroughs, academic studies, emerging technology, robotics, quantum computing, energy, materials science',
    isAiGenerated: false,
  },
  {
    name: 'Productivity',
    slug: 'productivity',
    color: '#a855f7',
    description:
      'Productivity systems, time management, habits, focus techniques, note-taking, second brain, deep work, mental models, PKM tools like Obsidian and Notion, life optimization, workflows, automation, delegation',
    isAiGenerated: false,
  },
  {
    name: 'Funny & Memes',
    slug: 'funny-memes',
    color: '#eab308',
    description:
      'Memes, jokes, satire, humor, viral content, relatable posts, shitposts, funny screenshots, comedy threads, parody, ironic takes — content whose primary purpose is to be funny or entertaining',
    isAiGenerated: false,
  },
  {
    name: 'General',
    slug: 'general',
    color: '#64748b',
    description: "Miscellaneous content that doesn't clearly fit any other category — use sparingly, only when no other category applies",
    isAiGenerated: false,
  },
] as const

// Default slugs only used for seeding — all runtime categorization uses DB slugs
const DEFAULT_SLUGS = DEFAULT_CATEGORIES.map((c) => c.slug)
const DEFAULT_SLUG_SET = new Set<string>(DEFAULT_SLUGS)

interface BookmarkForCategorization {
  tweetId: string
  text: string
  articleContent?: string
  imageTags?: string
  semanticTags?: string[]
  hashtags?: string[]
  tools?: string[]
}

interface CategoryAssignment {
  category: string
  confidence: number
}

interface CategorizationResult {
  tweetId: string
  assignments: CategoryAssignment[]
}

export interface DiscoveredCategory {
  name: string
  slug: string
  color: string
  description: string
}

function generateCategorySlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function seedDefaultCategories(): Promise<void> {
  const existing = await prisma.category.findMany({
    select: { slug: true, name: true, color: true, description: true },
  })
  const existingBySlug = new Map(existing.map((c) => [c.slug, c]))

  for (const cat of DEFAULT_CATEGORIES) {
    const existingCategory = existingBySlug.get(cat.slug)
    if (existingCategory) {
      // Sync name, color, and description so renames/updates propagate to existing DBs
      if (
        existingCategory.name !== cat.name ||
        existingCategory.color !== cat.color ||
        existingCategory.description !== cat.description
      ) {
        await prisma.category.update({
          where: { slug: cat.slug },
          data: { name: cat.name, color: cat.color, description: cat.description },
        })
      }
    } else {
      await prisma.category.create({ data: { ...cat } })
    }
  }
}

function buildCategorizationPrompt(
  bookmarks: BookmarkForCategorization[],
  categoryDescriptions: Record<string, string>,
  allSlugs: string[],
): string {
  const categoriesList = allSlugs.map(
    (slug) => `- ${slug}: ${categoryDescriptions[slug] ?? slug.replace(/-/g, ' ')}`,
  ).join('\n')

  const tweetData = bookmarks.map((b) => {
    const entry: Record<string, unknown> = { id: b.tweetId, text: b.text.slice(0, 400) }
    if (b.articleContent) entry.article = b.articleContent.slice(0, 1_800)
    const imgCtx = buildImageContext(b.imageTags)
    if (imgCtx) entry.images = imgCtx
    if (b.semanticTags?.length) entry.aiTags = b.semanticTags.slice(0, 20).join(', ')
    if (b.hashtags?.length) entry.hashtags = b.hashtags.slice(0, 10).join(', ')
    if (b.tools?.length) entry.tools = b.tools.join(', ')
    return entry
  })

  return `You are an expert librarian categorizing Twitter/X bookmarks into a personal knowledge base. Your categorizations directly power search and discovery — accuracy is critical.

AVAILABLE CATEGORIES:
${categoriesList}

CATEGORIZATION RULES:
- Assign 1-3 categories per bookmark — only what CLEARLY applies
- Confidence 0.5-1.0: use 0.9+ for obvious fits, 0.6-0.8 for plausible, 0.5 for borderline
- Priority: specific categories beat "general" — only use "general" when truly nothing else fits
- Use ALL signals: tweet text, linked article content, image analysis, OCR text inside images, hashtags, detected tools, semantic AI tags

SIGNAL WEIGHTING (use all, not just text):
- Image shows financial chart, price action, wallet UI → finance-crypto (even if tweet text is vague)
- Image shows code, terminal, GitHub, a dev tool UI → dev-tools
- Image is clearly a meme format or labeled as humor/satire → funny-memes with high confidence
- Tools field mentions GitHub/Vercel/React/etc → dev-tools likely applies
- aiTags field is pre-computed context — trust it heavily for category signals
- Hashtags like #bitcoin #eth → finance-crypto; #buildinpublic #saas → dev-tools/productivity

AVOID:
- Over-assigning "general" — it's a catch-all, not a default
- Conflating news about AI with AI resources (a news thread about OpenAI is "news", not "ai-resources")
- Assigning categories based only on passing mentions (a dev tweet that mentions a price = dev-tools, not finance)

Return ONLY valid JSON — no markdown, no explanation:
[{
  "tweetId": "123",
  "assignments": [
    {"category": "ai-resources", "confidence": 0.92},
    {"category": "dev-tools", "confidence": 0.71}
  ]
}]

CRITICAL JSON FORMATTING:
- Return one JSON array and nothing else
- Separate every object and property with commas
- Do not use comments, markdown fences, or trailing text

BOOKMARKS:
${JSON.stringify(tweetData, null, 1)}`
}

function categorizationMaxTokens(bookmarkCount: number): number {
  return Math.min(
    CATEGORIZATION_MAX_TOKENS,
    Math.max(CATEGORIZATION_MIN_TOKENS, bookmarkCount * 220),
  )
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
}

function sanitizeModelText(text: string): string {
  return stripMarkdownFences(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
}

function extractFirstJsonArray(text: string): string | null {
  const cleaned = sanitizeModelText(text)
  const start = cleaned.indexOf('[')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '[') {
      depth++
    } else if (char === ']') {
      depth--
      if (depth === 0) return cleaned.slice(start, index + 1)
    }
  }

  return cleaned.slice(start)
}

function repairJsonishArray(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/}\s*{/g, '},{')
    .replace(
      /("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null|\]|\})\s*\n\s*("[^"]+"\s*:)/g,
      '$1,\n$2',
    )
}

function normalizeCategorizationResults(
  parsed: unknown,
  validSlugs: Set<string>,
): CategorizationResult[] {
  if (!Array.isArray(parsed)) {
    throw new CategorizationParseError('AI response is not a JSON array')
  }

  return (parsed as Record<string, unknown>[]).map((item): CategorizationResult => {
    const tweetId = String(item.tweetId ?? '')
    const rawAssignments = Array.isArray(item.assignments) ? item.assignments : []

    const assignments: CategoryAssignment[] = (rawAssignments as Record<string, unknown>[])
      .map((a) => ({
        category: String(a.category ?? ''),
        confidence: typeof a.confidence === 'number' ? Math.min(1, Math.max(0.5, a.confidence)) : 0.8,
      }))
      .filter((a) => validSlugs.has(a.category))

    return { tweetId, assignments }
  }).filter((result) => result.tweetId && result.assignments.length > 0)
}

function parseJsonArrayCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate)
  } catch {
    return JSON.parse(repairJsonishArray(candidate))
  }
}

function parseBalancedObjects(text: string): unknown[] {
  const cleaned = sanitizeModelText(text)
  const objects: unknown[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < cleaned.length; index++) {
    const char = cleaned[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = index
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const candidate = cleaned.slice(start, index + 1)
        if (candidate.includes('"tweetId"')) {
          try {
            objects.push(JSON.parse(repairJsonishArray(candidate)))
          } catch {
            // Ignore malformed individual objects. Regex salvage below may still recover them.
          }
        }
        start = -1
      }
    }
  }

  return objects
}

function parseRegexSalvage(text: string, validSlugs: Set<string>): CategorizationResult[] {
  const cleaned = sanitizeModelText(text)
  const chunks = cleaned
    .split(/(?=\{\s*"tweetId"\s*:)/g)
    .filter((chunk) => chunk.includes('"tweetId"'))

  return chunks.map((chunk): CategorizationResult | null => {
    const tweetId = chunk.match(/"tweetId"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)?.[1]
    if (!tweetId) return null

    const assignments: CategoryAssignment[] = []
    const assignmentMatches = chunk.matchAll(
      /"category"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"(?:(?!\{)[\s\S]){0,160}?"confidence"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?|0?\.\d+)/g,
    )

    for (const match of assignmentMatches) {
      const category = match[1]
      const confidence = Number(match[2])
      if (!validSlugs.has(category) || !Number.isFinite(confidence)) continue
      assignments.push({ category, confidence: Math.min(1, Math.max(0.5, confidence)) })
    }

    return assignments.length > 0 ? { tweetId, assignments } : null
  }).filter((result): result is CategorizationResult => result !== null)
}

function parseCategorizationResponse(text: string, validSlugs: Set<string>): CategorizationResult[] {
  const jsonArray = extractFirstJsonArray(text)
  if (jsonArray) {
    try {
      const results = normalizeCategorizationResults(parseJsonArrayCandidate(jsonArray), validSlugs)
      if (results.length > 0) return results
    } catch {
      // Fall through to per-object and regex salvage.
    }
  }

  const objectResults = normalizeCategorizationResults(parseBalancedObjects(text), validSlugs)
  if (objectResults.length > 0) return objectResults

  const salvaged = parseRegexSalvage(text, validSlugs)
  if (salvaged.length > 0) return salvaged

  throw new CategorizationParseError('Could not parse categorization JSON from AI response')
}

function parseCategorizationBatchResponse(
  text: string,
  validSlugs: Set<string>,
  expectedCount: number,
): CategorizationResult[] {
  const results = parseCategorizationResponse(text, validSlugs)
  if (expectedCount > 0 && results.length === 0) {
    throw new CategorizationParseError('AI response did not include any bookmark categorization results')
  }
  return results
}

function normalizeDiscoveredCategory(
  item: Record<string, unknown>,
  index: number,
  seenSlugs: Set<string>,
): DiscoveredCategory | null {
  const name = String(item.name ?? '').trim().replace(/\s+/g, ' ')
  if (name.length < 3 || name.length > 64) return null

  const slug = generateCategorySlug(String(item.slug ?? '').trim() || name)
  if (!slug || slug === 'general' || DEFAULT_SLUG_SET.has(slug) || seenSlugs.has(slug)) return null

  const rawDescription = String(item.description ?? '').trim().replace(/\s+/g, ' ')
  const description = (rawDescription || name).slice(0, 360)
  seenSlugs.add(slug)

  return {
    name,
    slug,
    color: DISCOVERED_CATEGORY_COLORS[index % DISCOVERED_CATEGORY_COLORS.length],
    description,
  }
}

export function parseDiscoveredCategories(text: string): DiscoveredCategory[] {
  const jsonArray = extractFirstJsonArray(text)
  if (!jsonArray) throw new CategorizationParseError('No discovered category JSON array found')

  const parsed = parseJsonArrayCandidate(jsonArray)
  if (!Array.isArray(parsed)) throw new CategorizationParseError('Discovered category response is not an array')

  const seenSlugs = new Set<string>()
  return (parsed as Record<string, unknown>[])
    .map((item, index) => normalizeDiscoveredCategory(item, index, seenSlugs))
    .filter((category): category is DiscoveredCategory => category !== null)
    .slice(0, TAXONOMY_MAX_CATEGORIES)
}

export function buildCategoryDiscoveryPrompt(bookmarks: BookmarkForCategorization[]): string {
  const broadDefaults = DEFAULT_CATEGORIES
    .filter((category) => category.slug !== 'general')
    .map((category) => `- ${category.name}: ${category.description}`)
    .join('\n')

  const bookmarkData = bookmarks.map((bookmark) => {
    const entry: Record<string, unknown> = {
      id: bookmark.tweetId,
      text: bookmark.text.slice(0, 500),
    }
    if (bookmark.articleContent) entry.article = bookmark.articleContent.slice(0, 900)
    if (bookmark.semanticTags?.length) entry.aiTags = bookmark.semanticTags.slice(0, 20).join(', ')
    if (bookmark.hashtags?.length) entry.hashtags = bookmark.hashtags.slice(0, 12).join(', ')
    if (bookmark.tools?.length) entry.tools = bookmark.tools.slice(0, 12).join(', ')
    const imageContext = buildImageContext(bookmark.imageTags)
    if (imageContext) entry.images = imageContext.slice(0, 900)
    return entry
  })

  return `You are designing collections for a personal Twitter/X bookmark library.

Look at the actual bookmarks below and propose specific recurring collections that are missing from the broad fallback taxonomy.

BROAD FALLBACK CATEGORIES ALREADY EXIST:
${broadDefaults}

DISCOVERY RULES:
- Generate categories from repeated evidence in the bookmarks, not from a generic taxonomy.
- Prefer specific personal-interest collections over broad buckets. Examples: "Watches & Horology", "Products & Gear", "Restaurants", "Architecture", "Parenting", "Photography".
- Do not return "General", "Misc", or duplicates of the broad fallback categories.
- Each category needs a concise name and a description with include/exclude guidance for later categorization.
- Return only categories that would help organize multiple bookmarks.

Return ONLY valid JSON, no markdown:
[
  {
    "name": "Collection Name",
    "slug": "collection-name",
    "description": "What belongs here, with specific examples and boundaries."
  }
]

BOOKMARKS:
${JSON.stringify(bookmarkData, null, 1)}`
}

export function planTaxonomyDiscoveryBatches(total: number): Array<{ skip: number; take: number }> {
  if (total <= 0) return []

  if (total <= TAXONOMY_DISCOVERY_BOOKMARK_LIMIT) {
    const batches: Array<{ skip: number; take: number }> = []
    for (let skip = 0; skip < total; skip += TAXONOMY_BATCH_SIZE) {
      batches.push({ skip, take: Math.min(TAXONOMY_BATCH_SIZE, total - skip) })
    }
    return batches
  }

  const batchCount = Math.ceil(TAXONOMY_DISCOVERY_BOOKMARK_LIMIT / TAXONOMY_BATCH_SIZE)
  const maxSkip = Math.max(0, total - TAXONOMY_BATCH_SIZE)

  return Array.from({ length: batchCount }, (_, index) => ({
    skip: Math.floor((maxSkip * index) / Math.max(1, batchCount - 1)),
    take: TAXONOMY_BATCH_SIZE,
  }))
}

function buildCategoryConsolidationPrompt(candidates: DiscoveredCategory[]): string {
  return `Consolidate these candidate bookmark collections into a final taxonomy.

Rules:
- Merge near-duplicates.
- Keep specific recurring interests.
- Remove broad fallback categories, General, Misc, and one-off topics.
- Return 8-${TAXONOMY_MAX_CATEGORIES} categories when enough evidence exists.
- Preserve useful niche categories even if they are not business/tech topics.

Return ONLY valid JSON, no markdown:
[
  {
    "name": "Collection Name",
    "slug": "collection-name",
    "description": "What belongs here, with specific examples and boundaries."
  }
]

CANDIDATES:
${JSON.stringify(candidates.map(({ name, slug, description }) => ({ name, slug, description })), null, 1)}`
}

async function requestTextCompletion(
  prompt: string,
  client: AIClient | null,
  maxTokens: number,
  timeoutMs = 90_000,
): Promise<string> {
  const provider = await getProvider()

  if (provider === 'openai') {
    if (await getCodexCliAvailability()) {
      const result = await codexPrompt(prompt, { timeoutMs })
      if (result.success && result.data) return result.data
      console.warn('[categorize] Codex CLI failed, falling back to SDK:', result.error)
    }
  } else if (provider === 'anthropic') {
    if (await getCliAvailability()) {
      const model = await getActiveModel()
      const cliModel = modelNameToCliAlias(model)
      const result = await claudePrompt(prompt, { model: cliModel, timeoutMs })
      if (result.success && result.data) return result.data
      console.warn('[categorize] Claude CLI failed, falling back to SDK:', result.error)
    }
  }

  if (!client) {
    throw new Error('No AI client available. Configure an API key, CLI auth, or a local model endpoint.')
  }

  const model = await getActiveModel()
  const response = await client.createMessage({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  if (!response.text) throw new Error('No text content in AI response')
  return response.text
}

async function persistDiscoveredCategories(
  categories: DiscoveredCategory[],
  options: { pruneMissing?: boolean } = {},
): Promise<DiscoveredCategory[]> {
  const slugs = categories.map((category) => category.slug)
  const existing = await prisma.category.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true, isAiGenerated: true },
  })
  const existingBySlug = new Map(existing.map((category) => [category.slug, category]))

  const writeOps = categories.flatMap((category) => {
    const existingCategory = existingBySlug.get(category.slug)
    if (existingCategory && !existingCategory.isAiGenerated) return []

    return prisma.category.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        color: category.color,
        description: category.description,
        isAiGenerated: true,
      },
      create: {
        name: category.name,
        slug: category.slug,
        color: category.color,
        description: category.description,
        isAiGenerated: true,
      },
    })
  })

  const ops = options.pruneMissing === false
    ? writeOps
    : [
        prisma.category.deleteMany({
          where: {
            isAiGenerated: true,
            slug: { notIn: slugs },
          },
        }),
        ...writeOps,
      ]

  if (ops.length > 0) {
    await prisma.$transaction(ops)
  }

  return categories
}

export async function discoverCategoriesFromBookmarks(
  client: AIClient | null,
  options: {
    bookmarkIds?: string[]
    onProgress?: (done: number, total: number) => void
    shouldAbort?: () => boolean
  } = {},
): Promise<DiscoveredCategory[]> {
  const bookmarkWhere = options.bookmarkIds?.length ? { id: { in: options.bookmarkIds } } : {}
  const total = await prisma.bookmark.count({ where: bookmarkWhere })
  const pruneMissing = !options.bookmarkIds?.length && total <= TAXONOMY_DISCOVERY_BOOKMARK_LIMIT
  if (total === 0) {
    await persistDiscoveredCategories([], { pruneMissing })
    return []
  }

  const candidates: DiscoveredCategory[] = []
  let done = 0
  const batches = planTaxonomyDiscoveryBatches(total)
  const plannedTotal = batches.reduce((sum, batch) => sum + batch.take, 0)

  for (const batchPlan of batches) {
    if (options.shouldAbort?.()) break

    const rows = await prisma.bookmark.findMany({
      where: bookmarkWhere,
      orderBy: { id: 'asc' },
      skip: batchPlan.skip,
      take: batchPlan.take,
      select: BOOKMARK_SELECT,
    })

    if (rows.length === 0) break

    try {
      const prompt = buildCategoryDiscoveryPrompt(rows.map(mapBookmarkForCategorization))
      const response = await requestTextCompletion(prompt, client, TAXONOMY_MAX_TOKENS)
      candidates.push(...parseDiscoveredCategories(response))
      if (candidates.length > TAXONOMY_CANDIDATE_LIMIT) {
        candidates.splice(TAXONOMY_CANDIDATE_LIMIT)
      }
    } catch (err) {
      console.warn('[taxonomy] category discovery batch failed:', err)
    }

    done += rows.length
    options.onProgress?.(Math.min(done, plannedTotal), plannedTotal)
  }

  if (options.shouldAbort?.()) return []
  if (candidates.length === 0) {
    await persistDiscoveredCategories([], { pruneMissing })
    return []
  }

  let discovered = candidates
  if (candidates.length > TAXONOMY_MAX_CATEGORIES) {
    const response = await requestTextCompletion(
      buildCategoryConsolidationPrompt(candidates),
      client,
      TAXONOMY_MAX_TOKENS,
      120_000,
    )
    discovered = parseDiscoveredCategories(response)
  }

  return persistDiscoveredCategories(discovered, { pruneMissing })
}

async function requestCategorizationBatch(
  bookmarks: BookmarkForCategorization[],
  client: AIClient | null,
  categoryDescriptions: Record<string, string> = {},
  allSlugs: string[] = DEFAULT_SLUGS,
): Promise<CategorizationResult[]> {
  if (bookmarks.length === 0) return []

  const prompt = buildCategorizationPrompt(bookmarks, categoryDescriptions, allSlugs)
  const provider = await getProvider()

  // Prefer CLI over SDK (avoids OAuth token extraction, uses CLI directly)
  if (provider === 'openai') {
    if (await getCodexCliAvailability()) {
      const result = await codexPrompt(prompt, { timeoutMs: 60_000 })
      if (result.success && result.data) {
        try {
          return parseCategorizationBatchResponse(result.data, new Set(allSlugs), bookmarks.length)
        } catch (parseErr) {
          console.warn('[categorize] Codex CLI response parse failed, falling back to SDK:', parseErr)
        }
      } else {
        console.warn('[categorize] Codex CLI failed, falling back to SDK:', result.error)
      }
    }
  } else if (provider === 'anthropic') {
    if (await getCliAvailability()) {
      const model = await getActiveModel()
      const cliModel = modelNameToCliAlias(model)

      const result = await claudePrompt(prompt, { model: cliModel, timeoutMs: 60_000 })
      if (result.success && result.data) {
        try {
          return parseCategorizationBatchResponse(result.data, new Set(allSlugs), bookmarks.length)
        } catch (parseErr) {
          console.warn('[categorize] CLI response parse failed, falling back to SDK:', parseErr)
        }
      } else {
        console.warn('[categorize] CLI failed, falling back to SDK:', result.error)
      }
    }
  }

  // Fallback to SDK (requires API key)
  if (!client) {
    throw new Error('No AI client available. Configure an API key, CLI auth, or a local model endpoint.')
  }

  const model = await getActiveModel()
  const response = await client.createMessage({
    model,
    max_tokens: categorizationMaxTokens(bookmarks.length),
    messages: [{ role: 'user', content: prompt }],
  })

  if (!response.text) throw new Error('No text content in AI response')

  return parseCategorizationBatchResponse(response.text, new Set(allSlugs), bookmarks.length)
}

export function fallbackCategorization(
  bookmark: BookmarkForCategorization,
  allSlugs: string[],
): CategorizationResult {
  const validSlugs = new Set(allSlugs)
  const haystack = [
    bookmark.text,
    bookmark.articleContent,
    bookmark.imageTags,
    bookmark.semanticTags?.join(' '),
    bookmark.hashtags?.join(' '),
    bookmark.tools?.join(' '),
  ].filter(Boolean).join(' ').toLowerCase()

  const rules: Array<[string, RegExp]> = [
    ['ai-resources', /\b(ai|llm|gpt|claude|gemini|openai|anthropic|agent|rag|prompt|model)\b/],
    ['finance-crypto', /\b(crypto|bitcoin|btc|ethereum|eth|solana|defi|token|wallet|nft|web3)\b/],
    ['dev-tools', /\b(code|github|api|typescript|python|react|next\.?js|docker|database|terminal|vercel)\b/],
    ['finance-investing', /\b(stocks?|market|trading|fed|rates?|earnings|portfolio|equity|options)\b/],
    ['startups-business', /\b(startup|founder|saas|business|sales|marketing|revenue|fundraising|vc)\b/],
    ['design', /\b(design|ux|ui|figma|typography|brand|interface|wireframe|prototype|design system)\b/],
    ['health-wellness', /\b(health|fitness|sleep|diet|nutrition|longevity|workout|mental)\b/],
    ['security-privacy', /\b(security|privacy|hack|exploit|malware|vulnerability|encryption|vpn)\b/],
    ['funny-memes', /\b(meme|joke|funny|lol|lmao|satire|humor)\b/],
    ['news', /\b(news|election|politics|government|war|policy|geopolitics)\b/],
    ['science-research', /\b(research|paper|science|study|physics|biology|space|robotics)\b/],
    ['productivity', /\b(productivity|workflow|habit|focus|notion|obsidian|automation)\b/],
  ]

  const matched = rules.find(([slug, pattern]) => validSlugs.has(slug) && pattern.test(haystack))
  const category = matched?.[0] ?? (validSlugs.has('general') ? 'general' : allSlugs[0])
  return {
    tweetId: bookmark.tweetId,
    assignments: [{ category, confidence: matched ? 0.62 : 0.5 }],
  }
}

function isLocalModelRetryableFailure(err: unknown): boolean {
  if (err instanceof CategorizationParseError) return true
  if (!(err instanceof Error)) return false

  const name = err.name.toLowerCase()
  const message = err.message.toLowerCase()
  return (
    name.includes('timeout') ||
    message.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
  )
}

export async function categorizeBatch(
  bookmarks: BookmarkForCategorization[],
  client: AIClient | null,
  categoryDescriptions: Record<string, string> = {},
  allSlugs: string[] = DEFAULT_SLUGS,
): Promise<CategorizationResult[]> {
  if (bookmarks.length === 0) return []

  try {
    return await requestCategorizationBatch(bookmarks, client, categoryDescriptions, allSlugs)
  } catch (err) {
    if (!isLocalModelRetryableFailure(err)) throw err

    if (bookmarks.length === 1) {
      console.warn('[categorize] local model failed for one bookmark, using heuristic fallback')
      return [fallbackCategorization(bookmarks[0], allSlugs)]
    }

    console.warn(
      `[categorize] local model failed for ${bookmarks.length} bookmarks, retrying smaller batches`,
    )
    const midpoint = Math.ceil(bookmarks.length / 2)
    const left = await categorizeBatch(
      bookmarks.slice(0, midpoint),
      client,
      categoryDescriptions,
      allSlugs,
    )
    const right = await categorizeBatch(
      bookmarks.slice(midpoint),
      client,
      categoryDescriptions,
      allSlugs,
    )
    return [...left, ...right]
  }
}

export async function writeCategoryResults(results: CategorizationResult[]): Promise<number> {
  if (results.length === 0) return 0

  const tweetIds = results.map((r) => r.tweetId).filter(Boolean)
  if (tweetIds.length === 0) return 0

  // Batch-fetch all categories and bookmarks at once (eliminates N+1 queries)
  const [categories, bookmarks] = await Promise.all([
    prisma.category.findMany({ select: { id: true, slug: true } }),
    prisma.bookmark.findMany({
      where: { tweetId: { in: tweetIds } },
      select: { id: true, tweetId: true },
    }),
  ])

  const categoryBySlug = new Map(categories.map((c) => [c.slug, c.id]))
  const bookmarkByTweetId = new Map(bookmarks.map((b) => [b.tweetId, b.id]))
  const now = new Date()

  // Replace category assignments for every successfully parsed bookmark result.
  // Reprocessing should not leave stale categories that the model no longer chose.
  const upsertOps: ReturnType<typeof prisma.bookmarkCategory.upsert>[] = []
  const bookmarkIdsToUpdate: string[] = []

  for (const result of results) {
    if (!result.tweetId || result.assignments.length === 0) continue
    const bookmarkId = bookmarkByTweetId.get(result.tweetId)
    if (!bookmarkId) continue

    for (const { category: slug, confidence } of result.assignments) {
      const categoryId = categoryBySlug.get(slug)
      if (!categoryId) continue
      upsertOps.push(
        prisma.bookmarkCategory.upsert({
          where: { bookmarkId_categoryId: { bookmarkId, categoryId } },
          update: { confidence },
          create: { bookmarkId, categoryId, confidence },
        }),
      )
    }
    bookmarkIdsToUpdate.push(bookmarkId)
  }

  if (bookmarkIdsToUpdate.length === 0) return 0

  await prisma.$transaction([
    prisma.bookmarkCategory.deleteMany({
      where: { bookmarkId: { in: bookmarkIdsToUpdate } },
    }),
    ...upsertOps,
    prisma.bookmark.updateMany({
      where: { id: { in: bookmarkIdsToUpdate } },
      data: { enrichedAt: now },
    }),
  ])

  return bookmarkIdsToUpdate.length
}

export function mapBookmarkForCategorization(b: {
  tweetId: string
  text: string
  articleContent: string | null
  semanticTags: string | null
  entities: string | null
  mediaItems: { imageTags: string | null }[]
}): BookmarkForCategorization {
  const allImageTags = b.mediaItems
    .map((m) => m.imageTags)
    .filter((t): t is string => t !== null && t !== '')
    .join(' | ')

  let semanticTags: string[] | undefined
  if (b.semanticTags) {
    try { semanticTags = JSON.parse(b.semanticTags) as string[] } catch { /* ignore */ }
  }

  let hashtags: string[] | undefined
  let tools: string[] | undefined
  if (b.entities) {
    try {
      const ent = JSON.parse(b.entities) as { hashtags?: string[]; tools?: string[] }
      hashtags = ent.hashtags
      tools = ent.tools
    } catch { /* ignore */ }
  }

  return {
    tweetId: b.tweetId,
    text: b.text,
    articleContent: b.articleContent ?? undefined,
    imageTags: allImageTags || undefined,
    semanticTags,
    hashtags,
    tools,
  }
}

export const BOOKMARK_SELECT = {
  id: true,
  tweetId: true,
  text: true,
  articleContent: true,
  semanticTags: true,
  entities: true,
  mediaItems: { select: { imageTags: true } },
} as const

export async function categorizeAll(
  bookmarkIds: string[],
  onProgress?: (done: number, total: number) => void,
  force = false,
  shouldAbort?: () => boolean,
): Promise<void> {
  await seedDefaultCategories()

  // Resolve auth once — avoids re-resolving inside every batch call
  const provider = await getProvider()
  const keyName = getApiKeySettingKey(provider)
  const apiKeySetting = await prisma.setting.findUnique({ where: { key: keyName } })
  let client: AIClient | null = null
  try {
    client = await resolveAIClient({ dbKey: apiKeySetting?.value })
  } catch {
    // CLI might still work — client stays null
  }

  // Load ALL categories (default + custom) for the prompt
  const dbCategories = await prisma.category.findMany({ select: { slug: true, name: true, description: true } })
  const allSlugs = dbCategories.map((c) => c.slug)
  const categoryDescriptions = Object.fromEntries(
    dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
  )

  // Get total count for progress reporting (without loading all rows)
  let total = 0
  if (bookmarkIds.length > 0) {
    total = bookmarkIds.length
  } else if (force) {
    total = await prisma.bookmark.count()
  } else {
    total = await prisma.bookmark.count({ where: { enrichedAt: null } })
  }

  let done = 0

  if (bookmarkIds.length > 0) {
    // Specific bookmark IDs — fetch in BATCH_SIZE chunks
    for (let i = 0; i < bookmarkIds.length; i += BATCH_SIZE) {
      if (shouldAbort?.()) break
      const batchIds = bookmarkIds.slice(i, i + BATCH_SIZE)
      const rows = await prisma.bookmark.findMany({
        where: { id: { in: batchIds } },
        select: BOOKMARK_SELECT,
      })
      const batch = rows.map(mapBookmarkForCategorization)
      try {
        const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
        await writeCategoryResults(results)
      } catch (err) {
        console.error(`Error categorizing batch at index ${i}:`, err)
      }
      done = Math.min(i + BATCH_SIZE, total)
      onProgress?.(done, total)
    }
  } else {
    // Cursor-based pagination — never loads all bookmarks into memory
    let cursor: string | undefined
    const where = force ? {} : { enrichedAt: null }

    while (true) {
      if (shouldAbort?.()) break

      const rows = await prisma.bookmark.findMany({
        where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: BOOKMARK_SELECT,
      })

      if (rows.length === 0) break
      cursor = rows[rows.length - 1].id

      const batch = rows.map(mapBookmarkForCategorization)
      try {
        const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
        await writeCategoryResults(results)
      } catch (err) {
        console.error('Error categorizing batch:', err)
      }

      done += rows.length
      onProgress?.(Math.min(done, total), total)

      if (rows.length < BATCH_SIZE) break
    }
  }
}
