import type { ApiProfile, TaskParams } from '../types'
import type { CallApiResult } from './imageApiShared'

const JOB_STATUS_POLL_MS = 3000

export type HostedJobState = 'queued' | 'running' | 'done' | 'error' | 'expired'

export interface HostedJobStatus {
  id: string
  state: HostedJobState
  queuePosition?: number
  error?: string
  createdAt?: number
  startedAt?: number | null
  finishedAt?: number | null
  expiresAt?: number | null
}

export interface HostedJobAuthStatus {
  authenticated: boolean
  expiresAt?: number | null
}

export interface HostedJobServiceHealth {
  ok: boolean
  authConfigured: boolean
  queue: {
    active: number
    queued: number
    concurrency: number
    maxPending: number
    availableSlots: number
  }
}

const HOSTED_JOB_AUTH_REQUIRED_MESSAGE = '后台托管权限已失效，请到设置里重新输入权限密码并开启后台托管生成。'
const HOSTED_JOB_SERVICE_UNAVAILABLE_MESSAGE = '后台托管服务不可达，请确认部署已启动后台托管服务，并且 /api/job-auth 与 /api/image-jobs 已正确代理。'
const HOSTED_JOB_SERVICE_NOT_FOUND_MESSAGE = '后台托管健康检查接口不存在，请确认部署已更新，并且 /api/image-jobs 已正确代理。'
const HOSTED_JOB_AUTH_NOT_CONFIGURED_MESSAGE = '服务器未配置 JOB_ACCESS_PASSWORD，后台托管生成功能不可用。'

function createHostedJobError(message: string, statusCode?: number): Error {
  return Object.assign(new Error(message), statusCode ? { statusCode } : {})
}

function getErrorStatusCode(err: unknown): number | undefined {
  return err && typeof err === 'object' && 'statusCode' in err && typeof (err as { statusCode?: unknown }).statusCode === 'number'
    ? (err as { statusCode: number }).statusCode
    : undefined
}

function isHostedJobNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof SyntaxError) return true
  const message = err instanceof Error ? err.message : String(err)
  return /failed to fetch|fetch failed|load failed|networkerror|body is unusable|unexpected token|json/i.test(message)
}

function isHostedJobServiceStatus(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 405 || statusCode === 502 || statusCode === 504
}

export function isHostedJobAuthError(err: unknown): boolean {
  const statusCode = getErrorStatusCode(err)
  return statusCode === 401 || statusCode === 403
}

export function normalizeHostedJobError(err: unknown): Error {
  if (isHostedJobAuthError(err)) return createHostedJobError(HOSTED_JOB_AUTH_REQUIRED_MESSAGE, getErrorStatusCode(err))
  const statusCode = getErrorStatusCode(err)
  if (statusCode === 404 || statusCode === 405) return createHostedJobError(HOSTED_JOB_SERVICE_NOT_FOUND_MESSAGE, statusCode)
  if (isHostedJobServiceStatus(statusCode) || isHostedJobNetworkFailure(err)) {
    return createHostedJobError(HOSTED_JOB_SERVICE_UNAVAILABLE_MESSAGE, statusCode)
  }
  return err instanceof Error ? err : new Error(String(err))
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const payload = text ? JSON.parse(text) as unknown : null
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error || `HTTP ${response.status}`)
      : `HTTP ${response.status}`
    throw Object.assign(new Error(message), { statusCode: response.status })
  }
  return payload as T
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  return readJsonResponse<T>(response)
}

export function getHostedJobAuthStatus(): Promise<HostedJobAuthStatus> {
  return requestJson<HostedJobAuthStatus>('/api/job-auth/status')
}

export function getHostedJobServiceHealth(): Promise<HostedJobServiceHealth> {
  return requestJson<HostedJobServiceHealth>('/api/image-jobs/health')
}

export async function ensureHostedJobsAuthenticated(): Promise<void> {
  let health: HostedJobServiceHealth
  try {
    health = await getHostedJobServiceHealth()
  } catch (err) {
    throw normalizeHostedJobError(err)
  }
  if (!health.authConfigured) throw createHostedJobError(HOSTED_JOB_AUTH_NOT_CONFIGURED_MESSAGE, 503)

  let status: HostedJobAuthStatus
  try {
    status = await getHostedJobAuthStatus()
  } catch (err) {
    throw normalizeHostedJobError(err)
  }
  if (!status.authenticated) throw createHostedJobError(HOSTED_JOB_AUTH_REQUIRED_MESSAGE, 401)
}

export function authenticateHostedJobs(password: string): Promise<HostedJobAuthStatus> {
  return requestJson<HostedJobAuthStatus>('/api/job-auth', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export function createHostedImageJob(opts: {
  profile: ApiProfile
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
}): Promise<{ jobId: string; status: HostedJobStatus }> {
  return requestJson<{ jobId: string; status: HostedJobStatus }>('/api/image-jobs', {
    method: 'POST',
    body: JSON.stringify({
      prompt: opts.prompt,
      params: opts.params,
      inputImageDataUrls: opts.inputImageDataUrls,
      maskDataUrl: opts.maskDataUrl,
      responseFormatB64Json: opts.profile.responseFormatB64Json,
    }),
  })
}

export function getHostedImageJobStatus(jobId: string): Promise<HostedJobStatus> {
  return requestJson<HostedJobStatus>(`/api/image-jobs/${encodeURIComponent(jobId)}`)
}

export function getHostedImageJobResult(jobId: string): Promise<CallApiResult> {
  return requestJson<CallApiResult>(`/api/image-jobs/${encodeURIComponent(jobId)}/result`)
}

export async function deleteHostedImageJob(jobId: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/image-jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  })
}

export async function waitForHostedImageJob(
  jobId: string,
  opts?: { onResultDownloading?: (job: { jobId: string }) => void },
): Promise<CallApiResult> {
  while (true) {
    const status = await getHostedImageJobStatus(jobId)
    if (status.state === 'done') {
      opts?.onResultDownloading?.({ jobId })
      return getHostedImageJobResult(jobId)
    }
    if (status.state === 'error') throw new Error(status.error || '后台托管任务失败')
    if (status.state === 'expired') throw new Error('后台托管任务结果已过期，请重新生成')
    await new Promise((resolve) => setTimeout(resolve, JOB_STATUS_POLL_MS))
  }
}
