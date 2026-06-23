import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { TaskRecord } from '../types'
import { getHostedTaskBadgeLabel, isHostedAuthActionError } from './hostedJobUi'

describe('hosted job UI helpers', () => {
  const baseTask = {
    id: 'task-1',
    prompt: 'prompt',
    status: 'done',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    createdAt: Date.now(),
    error: '',
    finishedAt: null,
    elapsed: null,
  } as TaskRecord

  it('labels hosted tasks when they have a hosted job id or recoverable hosted state', () => {
    expect(getHostedTaskBadgeLabel(baseTask)).toBe('')
    expect(getHostedTaskBadgeLabel({ ...baseTask, hostedJobId: 'job-1' })).toBe('后台托管')
    expect(getHostedTaskBadgeLabel({ ...baseTask, hostedRecoverable: true })).toBe('后台托管')
  })

  it('detects hosted auth errors that should show the settings action', () => {
    expect(isHostedAuthActionError('后台托管权限已失效，请到设置里重新输入权限密码并开启后台托管生成。')).toBe(true)
    expect(isHostedAuthActionError('需要后台托管权限密码')).toBe(true)
    expect(isHostedAuthActionError('后台托管服务不可达')).toBe(false)
    expect(isHostedAuthActionError('Failed to fetch')).toBe(false)
  })
})
