import { Context } from 'cordis'

export interface IdMusicSignPostData {
  type: 'qq' | '163' | 'kugou' | 'kuwo' | 'migu'
  id: string | number
}

export interface CustomMusicSignPostData {
  type: 'qq' | '163' | 'kugou' | 'kuwo' | 'migu' | 'custom'
  url: string
  audio: string
  title: string
  content?: string
  image?: string
  singer?: string
}

export type MusicSignPostData = IdMusicSignPostData | CustomMusicSignPostData

export class MusicSign {
  private readonly url: string

  constructor(protected ctx: Context, url: string) {
    this.url = url
  }

  async sign(postData: MusicSignPostData): Promise<string> {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postData),
    })
    const data = await resp.text()
    if (!resp.ok) throw new Error(data)
    this.ctx.logger.info('音乐消息生成内容:', data)
    return data
  }
}
