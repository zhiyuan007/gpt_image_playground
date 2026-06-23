import type { TaskRecord } from '../types'

export function getHostedTaskBadgeLabel(task: Pick<TaskRecord, 'hostedJobId' | 'hostedRecoverable'>): string {
  return task.hostedJobId || task.hostedRecoverable ? '后台托管' : ''
}

export function isHostedAuthActionError(message: string | null | undefined): boolean {
  if (!message) return false
  return /后台托管权限|需要后台托管权限密码/.test(message)
}
