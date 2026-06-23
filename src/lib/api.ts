import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { createHostedImageJob, ensureHostedJobsAuthenticated, normalizeHostedJobError, waitForHostedImageJob } from './hostedImageJobs'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (opts.settings.backgroundHostedGeneration) {
    if (profile.provider !== 'openai' || profile.apiMode !== 'images') {
      throw new Error('后台托管生成第一版仅支持 OpenAI 兼容 Images API 配置。')
    }
    if (profile.streamImages) {
      throw new Error('后台托管生成第一版暂不支持流式生成，请关闭流式传输后重试。')
    }

    await ensureHostedJobsAuthenticated()
    let jobId: string
    try {
      const job = await createHostedImageJob({
        profile,
        prompt: opts.prompt,
        params: opts.params,
        inputImageDataUrls: opts.inputImageDataUrls,
        maskDataUrl: opts.maskDataUrl,
      })
      jobId = job.jobId
    } catch (err) {
      throw normalizeHostedJobError(err)
    }
    opts.onHostedJobCreated?.({ jobId })
    return waitForHostedImageJob(jobId)
  }

  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
