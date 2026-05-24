import { assert, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { prepareMediaItemsForImport } from '../lib/media-downloader'

function binaryResponse(bytes: number[], contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType },
  })
}

test('downloads imported photo and video media into local cache paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'siftly-media-cache-'))
  const requested: string[] = []
  const fetchMedia = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    requested.push(url)
    if (url.includes('clip.mp4')) return binaryResponse([0, 1, 2, 3], 'video/mp4')
    return binaryResponse([4, 5, 6], 'image/jpeg')
  }

  try {
    const media = await prepareMediaItemsForImport(
      [
        {
          type: 'photo',
          url: 'https://pbs.twimg.com/media/photo?format=jpg&name=large',
          thumbnailUrl: 'https://pbs.twimg.com/media/photo?format=jpg&name=small',
        },
        {
          type: 'video',
          url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/clip.mp4',
          thumbnailUrl: 'https://pbs.twimg.com/media/thumb.jpg',
        },
      ],
      {
        tweetId: '1234567890',
        storageDir: dir,
        publicBasePath: '/media-cache-test',
        fetch: fetchMedia,
      },
    )

    assert.deepEqual(requested, [
      'https://pbs.twimg.com/media/photo?format=jpg&name=large',
      'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/clip.mp4',
    ])
    assert.equal(media[0].url, 'https://pbs.twimg.com/media/photo?format=jpg&name=large')
    assert.equal(media[0].thumbnailUrl, 'https://pbs.twimg.com/media/photo?format=jpg&name=small')
    assert.match(media[0].localPath ?? '', /^\/media-cache-test\/1234567890\/.+\.jpg$/)
    assert.match(media[1].localPath ?? '', /^\/media-cache-test\/1234567890\/.+\.mp4$/)

    for (const item of media) {
      assert.ok(item.localPath)
      const filePath = join(dir, '1234567890', basename(item.localPath))
      assert.equal(existsSync(filePath), true)
      assert.equal(readFileSync(filePath).byteLength > 0, true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keeps media import rows when a media download fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'siftly-media-cache-fail-'))
  const fetchMedia = async (): Promise<Response> => new Response('not found', { status: 404 })

  try {
    const media = await prepareMediaItemsForImport(
      [{ type: 'photo', url: 'https://pbs.twimg.com/media/missing.jpg' }],
      {
        tweetId: 'missing',
        storageDir: dir,
        publicBasePath: '/media-cache-test',
        fetch: fetchMedia,
      },
    )

    assert.equal(media.length, 1)
    assert.equal(media[0].url, 'https://pbs.twimg.com/media/missing.jpg')
    assert.equal(media[0].localPath, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
