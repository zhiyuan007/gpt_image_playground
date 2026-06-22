import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { createHostedImageJob, waitForHostedImageJob } from './hostedImageJobs'
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
    if (opts.inputImageDataUrls.length > 0 || opts.maskDataUrl) {
      throw new Error('后台托管生成第一版仅支持文生图，暂不支持参考图、改图或遮罩。')
    }
    if (profile.streamImages) {
      throw new Error('后台托管生成第一版暂不支持流式生成，请关闭流式传输后重试。')
    }

    const { jobId } = await createHostedImageJob({
      profile,
      prompt: opts.prompt,
      params: opts.params,
    })
    opts.onHostedJobCreated?.({ jobId })
    return waitForHostedImageJob(jobId)
  }

  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
