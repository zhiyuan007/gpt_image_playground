import http from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.JOB_SERVER_PORT || 3001)
const HOST = process.env.JOB_SERVER_HOST || '127.0.0.1'
const ACCESS_PASSWORD = process.env.JOB_ACCESS_PASSWORD || ''
const AUTH_SECRET = process.env.JOB_AUTH_SECRET || randomBytes(32).toString('hex')
const AUTH_TTL_MS = Math.max(1, Number(process.env.JOB_AUTH_TTL_HOURS || 168)) * 60 * 60 * 1000
const RESULT_TTL_MS = Math.max(1, Number(process.env.JOB_RESULT_TTL_HOURS || 24)) * 60 * 60 * 1000
const MAX_PENDING = Math.max(1, Number(process.env.JOB_MAX_PENDING || 10))
const CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY || 1))
const MAX_STORAGE_BYTES = Math.max(10 * 1024 * 1024, Number(process.env.JOB_MAX_STORAGE_BYTES || 1024 * 1024 * 1024))
const RESULT_RATE_LIMIT_BYTES = Math.max(64 * 1024, Number(process.env.JOB_RESULT_RATE_LIMIT_BYTES_PER_SECOND || 375 * 1024))
const UPSTREAM_TIMEOUT_MS = Math.max(30, Number(process.env.JOB_UPSTREAM_TIMEOUT_SECONDS || 900)) * 1000
const MAX_IMAGE_INPUT_PAYLOAD_BYTES = Math.max(1024 * 1024, Number(process.env.JOB_MAX_IMAGE_INPUT_PAYLOAD_BYTES || 512 * 1024 * 1024))
const JOB_DATA_DIR = process.env.JOB_DATA_DIR || '/tmp/gpt-image-playground-jobs'
const UPSTREAM_BASE_URL = normalizeBaseUrl(process.env.JOB_UPSTREAM_BASE_URL || '')
const UPSTREAM_API_KEY = (process.env.JOB_UPSTREAM_API_KEY || '').trim()
const UPSTREAM_MODEL = (process.env.JOB_UPSTREAM_MODEL || 'gpt-image-2').trim()
const ALLOWED_BASE_URLS = (process.env.JOB_ALLOWED_BASE_URLS || 'https://api.ciyuanshen.top/v1,https://ciyuanshen.top/v1')
  .split(',')
  .map((item) => normalizeBaseUrl(item))
  .filter(Boolean)

const jobs = new Map()
const queue = []
const loginAttempts = new Map()
let activeCount = 0

await mkdir(JOB_DATA_DIR, { recursive: true })
await loadPersistedJobs()

function now() {
  return Date.now()
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function isAllowedBaseUrl(value) {
  const normalized = normalizeBaseUrl(value)
  return Boolean(normalized && ALLOWED_BASE_URLS.includes(normalized))
}

function formatAllowedBaseUrls() {
  return ALLOWED_BASE_URLS.join('、')
}

function sign(value) {
  return createHmac('sha256', AUTH_SECRET).update(value).digest('base64url')
}

function createAuthCookie() {
  const sessionId = randomBytes(18).toString('base64url')
  const expiresAt = now() + AUTH_TTL_MS
  const payload = `${sessionId}.${expiresAt}`
  return {
    sessionId,
    expiresAt,
    cookie: `${payload}.${sign(payload)}`,
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return null
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
  }).filter(Boolean))
}

function getSession(req) {
  const token = parseCookies(req).image_job_auth
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [sessionId, expiresAtText, signature] = parts
  const expiresAt = Number(expiresAtText)
  if (!sessionId || !Number.isFinite(expiresAt) || expiresAt <= now()) return null
  const payload = `${sessionId}.${expiresAtText}`
  const expected = sign(payload)
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null
  return { sessionId, expiresAt }
}

function isLoginRateLimited(req) {
  const key = req.socket.remoteAddress || 'unknown'
  const current = now()
  const record = loginAttempts.get(key) || { count: 0, resetAt: current + 60_000 }
  if (record.resetAt <= current) {
    record.count = 0
    record.resetAt = current + 60_000
  }
  record.count += 1
  loginAttempts.set(key, record)
  return record.count > 5
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function readRequestJson(req, maxBytes = 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? safeJsonParse(text) : {}
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

function requireAuth(req, res) {
  const session = getSession(req)
  if (!session) {
    sendError(res, 401, '需要后台托管权限密码')
    return null
  }
  return session
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    queuePosition: job.state === 'queued' ? queue.indexOf(job.id) + 1 : undefined,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
  }
}

function createJobId() {
  return `job_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
}

function resultPathFor(jobId) {
  return path.join(JOB_DATA_DIR, `${jobId}.json`)
}

function metadataPathFor(jobId) {
  return path.join(JOB_DATA_DIR, `${jobId}.meta.json`)
}

function getPersistableJob(job) {
  return {
    id: job.id,
    ownerSessionId: job.ownerSessionId,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
    error: job.error,
    resultFile: job.resultFile,
  }
}

async function persistJob(job) {
  await writeFile(metadataPathFor(job.id), JSON.stringify(getPersistableJob(job)), 'utf8')
}

async function safePersistJob(job) {
  try {
    await persistJob(job)
  } catch (error) {
    console.warn('后台托管任务状态持久化失败', error)
  }
}

async function removeJob(jobId) {
  const job = jobs.get(jobId)
  if (job?.resultFile) await rm(job.resultFile, { force: true })
  await rm(metadataPathFor(jobId), { force: true })
  jobs.delete(jobId)
  const queueIndex = queue.indexOf(jobId)
  if (queueIndex >= 0) queue.splice(queueIndex, 1)
}

async function loadPersistedJobs() {
  let names = []
  try {
    names = await readdir(JOB_DATA_DIR)
  } catch {
    return
  }

  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue
    const filePath = path.join(JOB_DATA_DIR, name)
    const payload = safeJsonParse(await readFile(filePath, 'utf8'))
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || typeof payload.ownerSessionId !== 'string') {
      await rm(filePath, { force: true })
      continue
    }

    const job = {
      id: payload.id,
      ownerSessionId: payload.ownerSessionId,
      state: ['queued', 'running', 'done', 'error', 'expired'].includes(payload.state) ? payload.state : 'error',
      createdAt: Number(payload.createdAt) || now(),
      startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : null,
      finishedAt: typeof payload.finishedAt === 'number' ? payload.finishedAt : null,
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : null,
      error: typeof payload.error === 'string' ? payload.error : undefined,
      resultFile: typeof payload.resultFile === 'string' ? payload.resultFile : undefined,
    }

    if (job.state === 'queued' || job.state === 'running') {
      job.state = 'error'
      job.error = '后台托管服务已重启，未完成的任务无法继续，请重新生成。'
      job.finishedAt = now()
      job.expiresAt = job.finishedAt + RESULT_TTL_MS
    }
    if (job.state === 'done' && job.resultFile) {
      try {
        await stat(job.resultFile)
      } catch {
        job.state = 'expired'
        job.error = '后台托管任务结果已过期，请重新生成。'
        job.resultFile = undefined
      }
    }
    jobs.set(job.id, job)
    await safePersistJob(job)
  }
}

async function fetchImageUrlAsDataUrl(url, fallbackMime) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMime
  const buffer = Buffer.from(await response.arrayBuffer())
  return `data:${contentType || fallbackMime};base64,${buffer.toString('base64')}`
}

async function extractResult(payload, fallbackMime) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  const images = []
  const actualParamsList = []
  const revisedPrompts = []
  const rawImageUrls = []
  for (const item of data) {
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      images.push(`data:${fallbackMime};base64,${item.b64_json}`)
    } else if (typeof item?.url === 'string' && item.url) {
      images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime))
      rawImageUrls.push(item.url)
    }
    actualParamsList.push(pickActualParams(item))
    revisedPrompts.push(typeof item?.revised_prompt === 'string' ? item.revised_prompt : undefined)
  }
  return {
    images,
    actualParams: pickActualParams(payload),
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function pickActualParams(source) {
  const params = {}
  if (!source || typeof source !== 'object') return params
  if (typeof source.size === 'string') params.size = source.size
  if (['auto', 'low', 'medium', 'high'].includes(source.quality)) params.quality = source.quality
  if (['png', 'jpeg', 'webp'].includes(source.output_format)) params.output_format = source.output_format
  if (typeof source.output_compression === 'number') params.output_compression = source.output_compression
  if (['auto', 'low'].includes(source.moderation)) params.moderation = source.moderation
  if (typeof source.n === 'number') params.n = source.n
  return params
}

function getMime(format) {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function dataUrlToBlobFile(dataUrl, fallbackName) {
  if (typeof dataUrl !== 'string') throw new Error('图片数据格式无效')
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) throw new Error('图片必须是 data URL')
  const mime = match[1] || 'image/png'
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''
  const buffer = isBase64 ? Buffer.from(payload.replace(/\s/g, ''), 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  return {
    blob: new Blob([buffer], { type: mime }),
    bytes: buffer.length,
    filename: `${fallbackName}.${ext}`,
  }
}

function appendImageApiFormField(form, key, value) {
  if (value === undefined || value === null) return
  form.append(key, String(value))
}

function createImageEditFormData(job) {
  const form = new FormData()
  appendImageApiFormField(form, 'model', job.model)
  appendImageApiFormField(form, 'prompt', job.prompt)
  appendImageApiFormField(form, 'size', job.params.size)
  appendImageApiFormField(form, 'quality', job.params.quality)
  appendImageApiFormField(form, 'output_format', job.params.output_format)
  appendImageApiFormField(form, 'moderation', job.params.moderation)
  if (job.params.output_compression != null && job.params.output_format !== 'png') {
    appendImageApiFormField(form, 'output_compression', job.params.output_compression)
  }
  if (job.params.n > 1) appendImageApiFormField(form, 'n', job.params.n)
  if (job.responseFormatB64Json) appendImageApiFormField(form, 'response_format', 'b64_json')

  for (let i = 0; i < job.inputImageDataUrls.length; i++) {
    const file = dataUrlToBlobFile(job.inputImageDataUrls[i], `input-${i + 1}`)
    form.append('image[]', file.blob, file.filename)
  }
  if (job.maskDataUrl) {
    const mask = dataUrlToBlobFile(job.maskDataUrl, 'mask')
    form.append('mask', mask.blob, mask.filename)
  }
  return form
}

async function runJob(job) {
  activeCount += 1
  job.state = 'running'
  job.startedAt = now()
  await safePersistJob(job)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const isEdit = job.inputImageDataUrls.length > 0 || Boolean(job.maskDataUrl)
    const response = isEdit
      ? await fetch(`${job.baseUrl}/images/edits`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${job.apiKey}`,
          },
          body: createImageEditFormData(job),
          signal: controller.signal,
        })
      : await fetch(`${job.baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${job.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: job.model,
            prompt: job.prompt,
            size: job.params.size,
            quality: job.params.quality,
            output_format: job.params.output_format,
            moderation: job.params.moderation,
            ...(job.params.output_compression != null && job.params.output_format !== 'png' ? { output_compression: job.params.output_compression } : {}),
            ...(job.params.n > 1 ? { n: job.params.n } : {}),
            ...(job.responseFormatB64Json ? { response_format: 'b64_json' } : {}),
          }),
          signal: controller.signal,
        })
    const text = await response.text()
    const payload = text ? safeJsonParse(text) : null
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || text || `HTTP ${response.status}`
      throw new Error(String(message))
    }
    const result = await extractResult(payload, getMime(job.params.output_format))
    if (!result.images.length) throw new Error('接口未返回可识别的图片数据')

    await writeFile(resultPathFor(job.id), JSON.stringify(result), 'utf8')
    job.state = 'done'
    job.resultFile = resultPathFor(job.id)
    job.finishedAt = now()
    job.expiresAt = job.finishedAt + RESULT_TTL_MS
  } catch (error) {
    job.state = 'error'
    job.error = error?.name === 'AbortError' ? '后台托管任务请求超时' : String(error?.message || error)
    job.finishedAt = now()
    job.expiresAt = job.finishedAt + RESULT_TTL_MS
  } finally {
    clearTimeout(timer)
    job.apiKey = ''
    job.inputImageDataUrls = []
    job.maskDataUrl = undefined
    await safePersistJob(job)
    activeCount -= 1
    processQueue()
    void cleanupExpiredJobs()
  }
}

function processQueue() {
  while (activeCount < CONCURRENCY && queue.length > 0) {
    const jobId = queue.shift()
    const job = jobs.get(jobId)
    if (!job || job.state !== 'queued') continue
    void runJob(job)
  }
}

async function cleanupExpiredJobs() {
  const current = now()
  for (const job of jobs.values()) {
    if ((job.state === 'done' || job.state === 'error' || job.state === 'expired') && job.expiresAt && job.expiresAt <= current) {
      await removeJob(job.id)
    }
  }

  let entries = []
  try {
    entries = await Promise.all((await readdir(JOB_DATA_DIR)).filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json')).map(async (name) => {
      const filePath = path.join(JOB_DATA_DIR, name)
      const info = await stat(filePath)
      return { filePath, mtimeMs: info.mtimeMs, size: info.size }
    }))
  } catch {
    return
  }
  let total = entries.reduce((sum, item) => sum + item.size, 0)
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= MAX_STORAGE_BYTES) break
    await rm(entry.filePath, { force: true })
    for (const job of jobs.values()) {
      if (job.resultFile !== entry.filePath) continue
      job.state = 'expired'
      job.error = '后台托管任务结果已过期，请重新生成。'
      job.resultFile = undefined
      await safePersistJob(job)
      break
    }
    total -= entry.size
  }
}

function validateHostedServerConfigPayload(payload) {
  if (!payload || typeof payload !== 'object') throw Object.assign(new Error('请求格式无效'), { statusCode: 400 })
  if (!UPSTREAM_BASE_URL) throw Object.assign(new Error('服务器未配置 JOB_UPSTREAM_BASE_URL'), { statusCode: 503 })
  if (!isAllowedBaseUrl(UPSTREAM_BASE_URL)) throw Object.assign(new Error(`后台托管服务器配置的 API URL 不在白名单内；当前允许：${formatAllowedBaseUrls()}`), { statusCode: 503 })
  if (!UPSTREAM_API_KEY) throw Object.assign(new Error('服务器未配置 JOB_UPSTREAM_API_KEY'), { statusCode: 503 })
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw Object.assign(new Error('缺少提示词'), { statusCode: 400 })
  if (!UPSTREAM_MODEL) throw Object.assign(new Error('服务器未配置 JOB_UPSTREAM_MODEL'), { statusCode: 503 })
  if (!/^gpt-image-2(?:-(?:1k|2k|4k))?$/.test(UPSTREAM_MODEL)) throw Object.assign(new Error('后台托管第一版仅允许 gpt-image-2 系列模型'), { statusCode: 503 })
  const inputImageDataUrls = Array.isArray(payload.inputImageDataUrls)
    ? payload.inputImageDataUrls.filter((item) => typeof item === 'string' && item.startsWith('data:'))
    : []
  if (inputImageDataUrls.length > 16) throw Object.assign(new Error('后台托管最多支持 16 张参考图'), { statusCode: 400 })
  const maskDataUrl = typeof payload.maskDataUrl === 'string' && payload.maskDataUrl.startsWith('data:') ? payload.maskDataUrl : undefined
  if (maskDataUrl && inputImageDataUrls.length === 0) throw Object.assign(new Error('遮罩任务必须包含主图'), { statusCode: 400 })
  const inputPayloadBytes = inputImageDataUrls.reduce((sum, item) => sum + item.length, 0) + (maskDataUrl?.length || 0)
  if (inputPayloadBytes > MAX_IMAGE_INPUT_PAYLOAD_BYTES) throw Object.assign(new Error('参考图或遮罩数据过大'), { statusCode: 413 })
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {}
  return {
    baseUrl: UPSTREAM_BASE_URL,
    apiKey: UPSTREAM_API_KEY,
    model: UPSTREAM_MODEL,
    prompt: payload.prompt.trim(),
    responseFormatB64Json: payload.responseFormatB64Json === true,
    inputImageDataUrls,
    maskDataUrl,
    params: {
      size: typeof params.size === 'string' && params.size ? params.size : 'auto',
      quality: ['auto', 'low', 'medium', 'high'].includes(params.quality) ? params.quality : 'auto',
      output_format: ['png', 'jpeg', 'webp'].includes(params.output_format) ? params.output_format : 'png',
      output_compression: typeof params.output_compression === 'number' ? params.output_compression : null,
      moderation: ['auto', 'low'].includes(params.moderation) ? params.moderation : 'auto',
      n: Number.isFinite(Number(params.n)) ? Math.max(1, Math.min(10, Math.trunc(Number(params.n)))) : 1,
    },
  }
}

function validateCreatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw Object.assign(new Error('请求格式无效'), { statusCode: 400 })
  if (!UPSTREAM_BASE_URL) throw Object.assign(new Error('服务器未配置 JOB_UPSTREAM_BASE_URL'), { statusCode: 503 })
  if (!isAllowedBaseUrl(UPSTREAM_BASE_URL)) throw Object.assign(new Error(`后台托管服务器配置的 API URL 不在白名单内；当前允许：${formatAllowedBaseUrls()}`), { statusCode: 503 })
  if (!UPSTREAM_API_KEY) throw Object.assign(new Error('服务器未配置 JOB_UPSTREAM_API_KEY'), { statusCode: 503 })
  if (!isAllowedBaseUrl(baseUrl)) throw Object.assign(new Error(`后台托管不允许请求此 API URL。请填写完整 /v1 地址；当前允许：${formatAllowedBaseUrls()}`), { statusCode: 400 })
  if (typeof payload.apiKey !== 'string' || !payload.apiKey.trim()) throw Object.assign(new Error('缺少 API Key'), { statusCode: 400 })
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw Object.assign(new Error('缺少提示词'), { statusCode: 400 })
  if (typeof payload.model !== 'string' || !payload.model.trim()) throw Object.assign(new Error('缺少模型名称'), { statusCode: 400 })
  if (!/^gpt-image-2(?:-(?:1k|2k|4k))?$/.test(payload.model.trim())) throw Object.assign(new Error('后台托管第一版仅允许 gpt-image-2 系列模型'), { statusCode: 400 })
  const inputImageDataUrls = Array.isArray(payload.inputImageDataUrls)
    ? payload.inputImageDataUrls.filter((item) => typeof item === 'string' && item.startsWith('data:'))
    : []
  if (inputImageDataUrls.length > 16) throw Object.assign(new Error('后台托管最多支持 16 张参考图'), { statusCode: 400 })
  const maskDataUrl = typeof payload.maskDataUrl === 'string' && payload.maskDataUrl.startsWith('data:') ? payload.maskDataUrl : undefined
  if (maskDataUrl && inputImageDataUrls.length === 0) throw Object.assign(new Error('遮罩任务必须包含主图'), { statusCode: 400 })
  const inputPayloadBytes = inputImageDataUrls.reduce((sum, item) => sum + item.length, 0) + (maskDataUrl?.length || 0)
  if (inputPayloadBytes > MAX_IMAGE_INPUT_PAYLOAD_BYTES) throw Object.assign(new Error('参考图或遮罩数据过大'), { statusCode: 413 })
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {}
  return {
    baseUrl,
    apiKey: payload.apiKey.trim(),
    model: payload.model.trim(),
    prompt: payload.prompt.trim(),
    responseFormatB64Json: payload.responseFormatB64Json === true,
    inputImageDataUrls,
    maskDataUrl,
    params: {
      size: typeof params.size === 'string' && params.size ? params.size : 'auto',
      quality: ['auto', 'low', 'medium', 'high'].includes(params.quality) ? params.quality : 'auto',
      output_format: ['png', 'jpeg', 'webp'].includes(params.output_format) ? params.output_format : 'png',
      output_compression: typeof params.output_compression === 'number' ? params.output_compression : null,
      moderation: ['auto', 'low'].includes(params.moderation) ? params.moderation : 'auto',
      n: Number.isFinite(Number(params.n)) ? Math.max(1, Math.min(10, Math.trunc(Number(params.n)))) : 1,
    },
  }
}

async function sendThrottledFile(res, filePath) {
  const stream = createReadStream(filePath, { highWaterMark: Math.min(64 * 1024, RESULT_RATE_LIMIT_BYTES) })
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  for await (const chunk of stream) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
    const delayMs = Math.ceil((chunk.length / RESULT_RATE_LIMIT_BYTES) * 1000)
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  res.end()
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')

  if (url.pathname === '/api/image-jobs/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      authConfigured: Boolean(ACCESS_PASSWORD),
      queue: {
        active: activeCount,
        queued: queue.length,
        concurrency: CONCURRENCY,
        maxPending: MAX_PENDING,
        availableSlots: Math.max(0, MAX_PENDING + CONCURRENCY - activeCount - queue.length),
      },
    })
    return
  }

  if (url.pathname === '/api/job-auth/status' && req.method === 'GET') {
    const session = getSession(req)
    sendJson(res, 200, { authenticated: Boolean(session), expiresAt: session?.expiresAt ?? null })
    return
  }

  if (url.pathname === '/api/job-auth' && req.method === 'POST') {
    if (!ACCESS_PASSWORD) {
      sendError(res, 503, '服务器未配置 JOB_ACCESS_PASSWORD')
      return
    }
    if (isLoginRateLimited(req)) {
      sendError(res, 429, '尝试次数过多，请稍后再试')
      return
    }
    const payload = await readRequestJson(req, 16 * 1024)
    if (typeof payload?.password !== 'string' || payload.password !== ACCESS_PASSWORD) {
      sendError(res, 401, '权限密码错误')
      return
    }
    const auth = createAuthCookie()
    sendJson(res, 200, { authenticated: true, expiresAt: auth.expiresAt }, {
      'Set-Cookie': `image_job_auth=${encodeURIComponent(auth.cookie)}; Path=/; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`,
    })
    return
  }

  if (url.pathname === '/api/image-jobs' && req.method === 'POST') {
    const session = requireAuth(req, res)
    if (!session) return
    if (queue.length + activeCount >= MAX_PENDING + CONCURRENCY) {
      sendError(res, 429, '后台托管队列已满，请稍后再试')
      return
    }
    const payload = validateHostedServerConfigPayload(await readRequestJson(req, MAX_IMAGE_INPUT_PAYLOAD_BYTES + 1024 * 1024))
    const id = createJobId()
    const job = {
      id,
      ownerSessionId: session.sessionId,
      state: 'queued',
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      expiresAt: null,
      error: undefined,
      resultFile: undefined,
      ...payload,
    }
    jobs.set(id, job)
    await safePersistJob(job)
    queue.push(id)
    processQueue()
    sendJson(res, 202, { jobId: id, status: publicJob(job) })
    return
  }

  const jobMatch = url.pathname.match(/^\/api\/image-jobs\/([^/]+)(?:\/(result|ack))?$/)
  if (jobMatch && ['GET', 'POST', 'DELETE'].includes(req.method || '')) {
    const session = requireAuth(req, res)
    if (!session) return
    const jobId = decodeURIComponent(jobMatch[1])
    const action = jobMatch[2] || ''
    const job = jobs.get(jobId)
    if (!job || job.ownerSessionId !== session.sessionId) {
      sendError(res, 404, '后台托管任务不存在或已过期')
      return
    }

    if (action === 'ack') {
      if (req.method !== 'POST') {
        sendError(res, 405, 'Method not allowed')
        return
      }
      await removeJob(jobId)
      sendJson(res, 200, { ok: true })
      return
    }

    if (action === 'result' && req.method !== 'GET') {
      sendError(res, 405, 'Method not allowed')
      return
    }

    if (req.method === 'DELETE') {
      await removeJob(jobId)
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname.endsWith('/result')) {
      if (job.state !== 'done' || !job.resultFile) {
        sendError(res, job.state === 'expired' ? 410 : 409, job.error || '任务尚未完成')
        return
      }
      await sendThrottledFile(res, job.resultFile)
      return
    }

    sendJson(res, 200, publicJob(job))
    return
  }

  sendError(res, 404, 'Not found')
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error?.statusCode || 500
    sendError(res, status, status >= 500 ? '后台托管服务错误' : String(error.message || error))
  })
})

setInterval(() => {
  void cleanupExpiredJobs()
}, 10 * 60 * 1000).unref()

server.listen(PORT, HOST, () => {
  console.log(`Image job server listening at http://${HOST}:${PORT}`)
})
