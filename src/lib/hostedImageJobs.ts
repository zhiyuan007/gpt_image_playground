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
}): Promise<{ jobId: string; status: HostedJobStatus }> {
  return requestJson<{ jobId: string; status: HostedJobStatus }>('/api/image-jobs', {
    method: 'POST',
    body: JSON.stringify({
      baseUrl: opts.profile.baseUrl,
      apiKey: opts.profile.apiKey,
      model: opts.profile.model,
      prompt: opts.prompt,
      params: opts.params,
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

export async function waitForHostedImageJob(jobId: string): Promise<CallApiResult> {
  while (true) {
    const status = await getHostedImageJobStatus(jobId)
    if (status.state === 'done') return getHostedImageJobResult(jobId)
    if (status.state === 'error') throw new Error(status.error || '后台托管任务失败')
    if (status.state === 'expired') throw new Error('后台托管任务结果已过期，请重新生成')
    await new Promise((resolve) => setTimeout(resolve, JOB_STATUS_POLL_MS))
  }
}
