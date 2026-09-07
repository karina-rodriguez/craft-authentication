import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import QRCode from 'qrcode'
import { prisma } from '@/lib/prisma'
import { initGarage } from '@/lib/object-store'
import { runFfmpeg, probeDuration } from '@/lib/ffmpeg'
import { downloadObjectToFile, createMediaFileFromBuffer } from '@/lib/media-io'
import { deleteMediaFiles } from '@/lib/media-delete'
import { mediaKind } from '@/lib/media-kind'
import { ANSWER_KEYS } from '@/lib/validations/craftStory'
import type { TranscriptSegment } from '@/lib/vtt'
import enMessages from '../../../messages/en.json'
import { computeInputsHash } from './hash'
import {
    buildFilmPlan,
    validateIngredients,
    FILM_WIDTH,
    FILM_HEIGHT,
    FILM_FPS,
    type FilmInputs,
    type FilmChapterInput,
    type FilmVisual,
    type FilmPlan,
    type PlannedChapter,
} from './planner'

const CARD_BG = '0x1b1b1b'

function serverBaseUrl(): string {
    return (
        process.env.NEXT_PUBLIC_SERVER_URL ||
        process.env.AUTH_URL ||
        'https://www.sustainablecrafting.org'
    )
}

// Pick a Noto family (selected via fontconfig at render time) that can shape the
// given text — names can be any script even in an English-only film, so the
// outro must not tofu. Families are provided by the fonts-noto-core apt package
// in the production image; filename-independent so it survives Debian repacks.
function fontFamilyForText(text: string): string {
    if (/[؀-ۿݐ-ݿ]/.test(text)) return 'Noto Sans Arabic'
    if (/[ऀ-ॿ]/.test(text)) return 'Noto Sans Devanagari'
    return 'Noto Sans'
}

const englishTitle = (index: number): string => {
    const craftStory = (enMessages as unknown as { craftStory: Record<string, { title?: string }> })
        .craftStory
    return craftStory[`step${index + 1}`]?.title ?? `Chapter ${index + 1}`
}

type CardLine = { text: string; fontSize: number; yExpr: string }

// Render a full-frame card (intro / chapter title / outro) with centered text
// lines and optional QR overlay, plus a matching stretch of silent stereo audio
// so every unit has both streams for the final concat.
async function renderCard(params: {
    durationSec: number
    lines: CardLine[]
    outPath: string
    tmpDir: string
    qrPngPath?: string
}): Promise<void> {
    const inputs: string[] = [
        '-f', 'lavfi', '-i', `color=c=${CARD_BG}:s=${FILM_WIDTH}x${FILM_HEIGHT}:r=${FILM_FPS}:d=${params.durationSec}`,
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
    ]
    let qrIndex = -1
    if (params.qrPngPath) {
        inputs.push('-i', params.qrPngPath)
        qrIndex = 2
    }

    const drawParts: string[] = []
    for (let i = 0; i < params.lines.length; i++) {
        const line = params.lines[i]
        // textfile= avoids escaping the artisan's own words/URL inside the filter.
        const txtFile = path.join(params.tmpDir, `card-${randomUUID()}.txt`)
        await fs.promises.writeFile(txtFile, line.text, 'utf8')
        const family = fontFamilyForText(line.text)
        // Reference the textfile by basename (resolved via cwd below): an
        // absolute path inside a filtergraph breaks on Windows, where the
        // drive-letter ":" is read as ffmpeg's option separator.
        drawParts.push(
            `drawtext=font=${family}:textfile=${path.basename(txtFile)}:fontcolor=white:fontsize=${line.fontSize}:x=(w-text_w)/2:y=${line.yExpr}`,
        )
    }

    let filter = `[0:v]${drawParts.join(',')}`
    if (qrIndex >= 0) {
        filter += `[bg];[bg][${qrIndex}:v]overlay=(W-w)/2:H-h-90[v]`
    } else {
        filter += `[v]`
    }

    await runFfmpeg([
        ...inputs,
        '-filter_complex', filter,
        '-map', '[v]',
        '-map', '1:a',
        '-t', String(params.durationSec),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FILM_FPS),
        '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-y', params.outPath,
    ], { cwd: params.tmpDir })
}

// A still photo with a slow Ken Burns move. Feeds a single frame and lets
// zoompan generate the frames via d= (never -loop 1 + select, which deadlocks).
// A still held for the shot, drifting slowly so the frame is never static.
//
// The pan works on an already blur-padded composition rather than on the raw
// image. Zooming the raw image meant taking a 16:9 window out of the middle of
// it, which on a portrait photo threw away the top and bottom, and the old 1.5x
// travel pushed that crop further still. Composing first means the whole picture
// is always on screen, and the drift is gentle enough that it only ever eats into
// the blurred surround.
const PAN_TRAVEL = 0.08
const PAN_PER_FRAME = 0.0007

async function renderImageShot(
    imagePath: string,
    durationSec: number,
    panDirection: 'in' | 'out',
    outPath: string,
): Promise<void> {
    const frames = Math.max(1, Math.round(durationSec * FILM_FPS))
    const zoom =
        panDirection === 'in'
            ? `z='min(1+${PAN_PER_FRAME}*on,${1 + PAN_TRAVEL})'`
            : `z='max(${1 + PAN_TRAVEL}-${PAN_PER_FRAME}*on,1.0)'`

    // Compose at twice the output size so the pan resamples down rather than up.
    const composeW = FILM_WIDTH * 2
    const composeH = FILM_HEIGHT * 2
    const filter =
        blurPadFilter('0:v', 'composed', composeW, composeH) +
        `;[composed]zoompan=${zoom}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
        `d=${frames}:s=${FILM_WIDTH}x${FILM_HEIGHT}:fps=${FILM_FPS},format=yuv420p,setsar=1[v]`

    await runFfmpeg([
        '-i', imagePath,
        '-filter_complex', filter,
        '-map', '[v]',
        '-frames:v', String(frames),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FILM_FPS),
        '-an',
        '-y', outPath,
    ])
}

// Fit a source of any shape into the 16:9 frame: the whole thing scaled to fit,
// over a blurred, cover-cropped copy of itself filling the rest. Cropping to fill
// instead would cut the top and bottom off a portrait photo, which is where most
// of a person is.
function blurPadFilter(inLabel: string, outLabel: string, width: number, height: number): string {
    return (
        `[${inLabel}]split[bgsrc][fgsrc];` +
        `[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:2[bg];` +
        `[fgsrc]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[${outLabel}]`
    )
}

// A workshop clip (or talking head) trimmed to length, muted, and blur-padded
// to 16:9 so any aspect ratio fills the frame. `-stream_loop -1` + an output `-t`
// guarantee the shot fills durationSec even when the source clip is shorter (a
// short clip would otherwise leave the body shorter than the voiceover).
async function renderVideoShot(
    videoPath: string,
    durationSec: number,
    outPath: string,
    startSec = 0,
): Promise<void> {
    const filter =
        blurPadFilter('0:v', 'padded', FILM_WIDTH, FILM_HEIGHT) +
        `;[padded]format=yuv420p[v]`
    await runFfmpeg([
        '-stream_loop', '-1',
        // Input-side seek: fast, keyframe accurate, which is fine for B-roll.
        ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
        '-i', videoPath,
        '-filter_complex', filter,
        '-map', '[v]',
        '-t', String(durationSec),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FILM_FPS),
        '-an',
        '-y', outPath,
    ])
}

// A neutral filler clip, used when a shot's source can't be rendered so one bad
// visual never fails the whole film.
async function renderBlankShot(durationSec: number, outPath: string): Promise<void> {
    await runFfmpeg([
        '-f', 'lavfi', '-i', `color=c=${CARD_BG}:s=${FILM_WIDTH}x${FILM_HEIGHT}:r=${FILM_FPS}:d=${durationSec}`,
        '-vf', 'setsar=1,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FILM_FPS),
        '-an',
        '-y', outPath,
    ])
}

// High-quality voice track extracted from the ORIGINAL answer media (not the
// 16 kHz Whisper mp3). If the source has no audio track (e.g. a silent video),
// falls back to silence of the same length so the chapter still plays visually
// instead of failing the whole render.
async function extractVoice(sourcePath: string, outPath: string, durationSec: number): Promise<void> {
    try {
        await runFfmpeg([
            '-i', sourcePath,
            '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
            '-y', outPath,
        ])
        return
    } catch (err) {
        console.error('Voice extraction failed, using silence:', err)
    }
    await runFfmpeg([
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-t', String(durationSec),
        '-c:a', 'pcm_s16le',
        '-y', outPath,
    ])
}

function concatListFile(paths: string[], listPath: string): Promise<void> {
    // The concat demuxer resolves relative entries against the list file's own
    // directory, so use basenames — an absolute Windows path (drive-letter colon
    // + backslashes) breaks the `file '...'` parsing. All clips live alongside
    // the list in the temp dir. Single quotes in a name are still escaped.
    const body = paths
        .map(p => `file '${path.basename(p).replace(/'/g, "'\\''")}'`)
        .join('\n')
    return fs.promises.writeFile(listPath, body, 'utf8')
}

// Stitch same-parameter shot clips into one silent body video (copy — cheap).
async function concatShots(shotPaths: string[], listPath: string, outPath: string): Promise<void> {
    await concatListFile(shotPaths, listPath)
    await runFfmpeg([
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy',
        '-y', outPath,
    ])
}

async function muxBodyWithVoice(bodyVideoPath: string, voicePath: string, outPath: string): Promise<void> {
    await runFfmpeg([
        '-i', bodyVideoPath,
        '-i', voicePath,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        '-y', outPath,
    ])
}

// Join every unit (intro, per-chapter title + body, outro) and normalise
// loudness in one final re-encode. Every input is first forced to identical
// params: the concat filter rejects ANY mismatch in size, SAR, fps, pixel
// format, sample rate or channel layout (one workshop clip with non-square
// pixels is enough to break it).
async function finalConcat(unitPaths: string[], outPath: string): Promise<void> {
    const inputs: string[] = []
    unitPaths.forEach(p => inputs.push('-i', p))

    const norm: string[] = []
    const labels: string[] = []
    unitPaths.forEach((_, i) => {
        norm.push(`[${i}:v]scale=${FILM_WIDTH}:${FILM_HEIGHT},setsar=1,fps=${FILM_FPS},format=yuv420p[v${i}]`)
        norm.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`)
        labels.push(`[v${i}][a${i}]`)
    })
    const filter =
        `${norm.join(';')};` +
        `${labels.join('')}concat=n=${unitPaths.length}:v=1:a=1[v][a];` +
        `[a]loudnorm=I=-16:TP=-1.5:LRA=11[ao]`

    await runFfmpeg([
        ...inputs,
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[ao]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FILM_FPS),
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outPath,
    ])
}

async function setFilmStatus(
    storyId: string,
    status: 'PROCESSING' | 'READY' | 'FAILED',
    data: Record<string, unknown> = {},
): Promise<void> {
    await prisma.storyFilm.update({ where: { storyId }, data: { status, ...data } }).catch((err: unknown) => {
        console.error(`Failed to set film status for story ${storyId}:`, err)
    })
}

// Download the sources the plan needs and probe durations, producing the pure
// planner's FilmInputs plus a mediaId -> local path map for the renderer.
async function gatherInputs(
    storyId: string,
    tmpDir: string,
): Promise<{ inputs: FilmInputs; localPath: Map<string, string>; uploaderId: string | null } | null> {
    const story = await prisma.craftStory.findUnique({
        where: { id: storyId },
        include: { artisan: { select: { firstName: true, lastName: true, slug: true, userId: true } } },
    })
    if (!story || !story.artisan) return null

    const answerMediaIds = ANSWER_KEYS.map(k => story[`answer${k}MediaId` as const]).filter(
        (v): v is string => typeof v === 'string',
    )
    const workshop = await prisma.mediaAttachment.findMany({
        where: { entityType: 'CraftStory', entityId: storyId, attachmentType: 'PROCESS' },
        include: { media: { select: { id: true, objectKey: true, mimeType: true } } },
        orderBy: { displayOrder: 'asc' },
    })

    const mediaRows = await prisma.mediaFile.findMany({
        where: { id: { in: answerMediaIds } },
        select: { id: true, objectKey: true, mimeType: true },
    })
    const mediaById = new Map(mediaRows.map(m => [m.id, m]))

    const transcripts = await prisma.mediaTranscript.findMany({
        where: { mediaId: { in: answerMediaIds }, status: 'READY' },
        select: { mediaId: true, segments: true },
    })
    const segmentsById = new Map(
        transcripts.map(t => [t.mediaId, (t.segments as unknown as TranscriptSegment[]) ?? null]),
    )

    const localPath = new Map<string, string>()
    async function fetchLocal(mediaId: string, objectKey: string): Promise<string> {
        const dest = path.join(tmpDir, `src-${mediaId}`)
        if (!localPath.has(mediaId)) {
            await downloadObjectToFile(objectKey, dest)
            localPath.set(mediaId, dest)
        }
        return localPath.get(mediaId) as string
    }

    // Chapters, in ANSWER_KEYS order.
    const chapters: FilmChapterInput[] = []
    for (let i = 0; i < ANSWER_KEYS.length; i++) {
        const key = ANSWER_KEYS[i]
        const mediaId = story[`answer${key}MediaId` as const]
        let voiceMediaId: string | null = null
        let voiceKind: 'audio' | 'video' | null = null
        let voiceDurationSec = 0
        let segments: TranscriptSegment[] | null = null
        if (typeof mediaId === 'string') {
            const media = mediaById.get(mediaId)
            const kind = media ? mediaKind(media.mimeType) : 'image'
            if (media && (kind === 'audio' || kind === 'video')) {
                const local = await fetchLocal(mediaId, media.objectKey)
                voiceMediaId = mediaId
                voiceKind = kind
                voiceDurationSec = await probeDuration(local).catch(() => 0)
                segments = segmentsById.get(mediaId) ?? null
            }
        }
        chapters.push({
            key,
            titleCardText: englishTitle(i),
            voiceMediaId,
            voiceKind,
            voiceDurationSec,
            segments,
        })
    }

    // Workshop visuals in display order; download eagerly so the renderer has them.
    const visuals: FilmVisual[] = []
    for (const att of workshop) {
        if (!att.media) continue
        const kind = mediaKind(att.media.mimeType)
        if (kind !== 'image' && kind !== 'video') continue
        await fetchLocal(att.media.id, att.media.objectKey)
        visuals.push({ mediaId: att.media.id, kind })
    }

    const name = `${story.artisan.firstName} ${story.artisan.lastName}`.trim()
    const inputs: FilmInputs = {
        artisanName: name,
        profileUrl: `${serverBaseUrl()}/artisans/${story.artisan.slug}`,
        chapters,
        visuals,
        templateVersion: 1,
    }
    return { inputs, localPath, uploaderId: story.artisan.userId }
}

async function renderTimeline(
    plan: FilmPlan,
    localPath: Map<string, string>,
    tmpDir: string,
): Promise<string> {
    const units: string[] = []

    // A clip dealt to several shots used to replay its opening every time, so a
    // long upload showed the same few seconds over and over while the rest was
    // never seen. Walk through each clip instead, one shot's worth at a time,
    // starting over once the end is reached.
    const clipLength = new Map<string, number>()
    const clipCursor = new Map<string, number>()

    async function nextClipStart(mediaId: string, src: string, shotSec: number): Promise<number> {
        let total = clipLength.get(mediaId)
        if (total === undefined) {
            total = await probeDuration(src).catch(() => 0)
            clipLength.set(mediaId, total)
        }
        // A clip no longer than the shot already loops to fill it; seeking into
        // one would only skip past the footage there is.
        if (total <= shotSec) return 0

        let start = clipCursor.get(mediaId) ?? 0
        if (start + shotSec > total) start = 0
        clipCursor.set(mediaId, start + shotSec)
        return start
    }

    // Intro name card.
    const introPath = path.join(tmpDir, 'unit-intro.mp4')
    await renderCard({
        durationSec: plan.intro.durationSec,
        lines: [{ text: plan.intro.text, fontSize: 64, yExpr: '(h-text_h)/2' }],
        outPath: introPath,
        tmpDir,
    })
    units.push(introPath)

    // Per chapter: title card, then the voiced body.
    for (let ci = 0; ci < plan.chapters.length; ci++) {
        const chapter: PlannedChapter = plan.chapters[ci]

        const titlePath = path.join(tmpDir, `unit-title-${ci}.mp4`)
        await renderCard({
            durationSec: chapter.titleCard.durationSec,
            lines: [{ text: chapter.titleCard.text, fontSize: 52, yExpr: '(h-text_h)/2' }],
            outPath: titlePath,
            tmpDir,
        })
        units.push(titlePath)

        // Render each shot to a uniform silent clip. A shot that can't be built
        // (missing or unreadable source) becomes a neutral filler of the same
        // length, so one bad visual never fails the film and the body stays the
        // same length as the voiceover.
        const shotPaths: string[] = []
        for (let si = 0; si < chapter.shots.length; si++) {
            const shot = chapter.shots[si]
            const shotPath = path.join(tmpDir, `shot-${ci}-${si}.mp4`)
            const src = localPath.get(shot.source.mediaId)
            try {
                if (src && shot.source.type === 'image') {
                    await renderImageShot(src, shot.durationSec, shot.source.panDirection, shotPath)
                } else if (src) {
                    const start = await nextClipStart(shot.source.mediaId, src, shot.durationSec)
                    await renderVideoShot(src, shot.durationSec, shotPath, start)
                } else {
                    await renderBlankShot(shot.durationSec, shotPath)
                }
            } catch (err) {
                console.error(`Film shot ${ci}-${si} failed, using filler:`, err)
                await renderBlankShot(shot.durationSec, shotPath)
            }
            shotPaths.push(shotPath)
        }

        const bodyVideo = path.join(tmpDir, `body-video-${ci}.mp4`)
        await concatShots(shotPaths, path.join(tmpDir, `body-list-${ci}.txt`), bodyVideo)

        const voice = path.join(tmpDir, `voice-${ci}.wav`)
        await extractVoice(localPath.get(chapter.voiceMediaId) as string, voice, chapter.voiceDurationSec)

        const bodyPath = path.join(tmpDir, `unit-body-${ci}.mp4`)
        await muxBodyWithVoice(bodyVideo, voice, bodyPath)
        units.push(bodyPath)
    }

    // Outro: name, profile URL, QR code.
    const qrPath = path.join(tmpDir, 'qr.png')
    await QRCode.toFile(qrPath, plan.outro.profileUrl, { width: 220, margin: 1 })
    const outroPath = path.join(tmpDir, 'unit-outro.mp4')
    await renderCard({
        durationSec: plan.outro.durationSec,
        lines: [
            { text: plan.outro.name, fontSize: 48, yExpr: 'h/2-140' },
            { text: plan.outro.profileUrl, fontSize: 26, yExpr: 'h/2-70' },
        ],
        outPath: outroPath,
        tmpDir,
        qrPngPath: qrPath,
    })
    units.push(outroPath)

    const finalPath = path.join(tmpDir, 'film.mp4')
    await finalConcat(units, finalPath)
    return finalPath
}

/**
 * Worker body — assumes the film row is claimed (status PROCESSING). Assembles
 * the mp4, uploads it, attaches soft captions as a synthetic READY transcript
 * on the output MediaFile, marks the film READY, and GCs any prior output.
 * Errors are recorded on the film row, never thrown.
 */
export async function renderStoryFilm(storyId: string): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), `film-${randomUUID()}`)
    await fs.promises.mkdir(tmpDir, { recursive: true })

    // Capture the prior output up front so we can GC it after a successful swap.
    const existing = await prisma.storyFilm.findUnique({
        where: { storyId },
        select: { outputMediaId: true },
    })
    const priorOutputId = existing?.outputMediaId ?? null

    try {
        await initGarage()

        const gathered = await gatherInputs(storyId, tmpDir)
        if (!gathered) {
            await setFilmStatus(storyId, 'FAILED', { error: 'Story or artisan not found' })
            return
        }

        const check = validateIngredients(gathered.inputs)
        if (!check.ok) {
            await setFilmStatus(storyId, 'FAILED', { error: `Insufficient ingredients: ${check.reason}` })
            return
        }

        const plan = buildFilmPlan(gathered.inputs)
        const finalPath = await renderTimeline(plan, gathered.localPath, tmpDir)

        const buffer = await fs.promises.readFile(finalPath)
        const durationSec = await probeDuration(finalPath).catch(() => plan.totalDurationSec)

        const output = await createMediaFileFromBuffer({
            buffer,
            mimeType: 'video/mp4',
            extension: 'mp4',
            originalName: `story-film-${storyId}.mp4`,
            uploaderId: gathered.uploaderId,
        })

        // Soft captions ride a synthetic READY transcript on the output file, so
        // the existing /api/media/[id]/subtitles route serves them unchanged.
        await prisma.$transaction([
            prisma.mediaTranscript.create({
                data: {
                    mediaId: output.id,
                    status: 'READY',
                    sourceLanguage: 'English',
                    segments: plan.captionSegments as unknown as object[],
                },
            }),
            prisma.storyFilm.update({
                where: { storyId },
                data: {
                    status: 'READY',
                    // Rendering over a film the artisan uploaded returns
                    // ownership of the row to the generator.
                    source: 'RENDERED',
                    outputMediaId: output.id,
                    durationSec,
                    inputsHash: computeInputsHash(gathered.inputs),
                    error: null,
                },
            }),
        ])

        // Old output (and its cascading transcript) is now unreferenced.
        if (priorOutputId && priorOutputId !== output.id) {
            await deleteMediaFiles([priorOutputId])
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown film render error'
        console.error(`Film render failed for story ${storyId}:`, error)

        // Generating over a film the artisan uploaded must not cost them that
        // film. The row still points at their video, so a failure here leaves it
        // READY and merely records why the generation did not happen. Marking it
        // FAILED would hide their own film from the panel and from their
        // published page, with no way back to it.
        const current = await prisma.storyFilm.findUnique({
            where: { storyId },
            select: { source: true, outputMediaId: true },
        })
        if (current?.source === 'UPLOADED' && current.outputMediaId) {
            await setFilmStatus(storyId, 'READY', { error: message })
        } else {
            await setFilmStatus(storyId, 'FAILED', { error: message })
        }
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}
