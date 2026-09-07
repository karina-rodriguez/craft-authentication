'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog'
import { CaptionedVideo } from '@/components/shared/CaptionedVideo'
import { AlertCircle, Clapperboard, Download, Loader2, RefreshCw } from 'lucide-react'
import { StoryFilmUploadButton } from './StoryFilmUploadButton'

type FilmStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'
type FilmSource = 'RENDERED' | 'UPLOADED'

interface FilmView {
    status: FilmStatus
    source: FilmSource
    isPublic: boolean
    outputMediaId: string | null
    durationSec: number | null
    error: string | null
    updatedAt: string
}

/**
 * @param storyPublished whether the story is already live. A film only becomes
 * public when the story is published, so a film rendered after that point sits
 * finished but hidden until the artisan is told to show it.
 */
export function StoryFilmPanel({ storyPublished = false }: { storyPublished?: boolean }) {
    const t = useTranslations('craftStory.film')
    const tStory = useTranslations('craftStory')

    const [film, setFilm] = useState<FilmView | null>(null)
    const [stale, setStale] = useState(false)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState<string | null>(null)
    const [open, setOpen] = useState(false)

    const refresh = useCallback(async () => {
        try {
            const res = await fetch('/api/artisans/me/story/film')
            if (!res.ok) return
            const data = await res.json()
            setFilm(data.film ?? null)
            setStale(Boolean(data.stale))
        } catch {
            // Status is informational — never surface fetch failures.
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    // Poll while a render is in flight so the panel flips to ready/failed.
    const active = film?.status === 'PENDING' || film?.status === 'PROCESSING'
    useEffect(() => {
        if (!active) return
        const id = setInterval(() => void refresh(), 8000)
        return () => clearInterval(id)
    }, [active, refresh])

    async function startRender(force: boolean) {
        setBusy(true)
        setNotice(null)
        try {
            const res = await fetch('/api/artisans/me/story/film', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(force ? { force: true } : {}),
            })
            if (res.status === 400) {
                setNotice(t('insufficientInputs'))
                return
            }
            if (!res.ok) {
                setNotice(t('failed'))
                return
            }
            const data = await res.json()
            setFilm(data.film ?? null)
            setStale(false)
        } catch {
            setNotice(t('failed'))
        } finally {
            setBusy(false)
        }
    }

    async function togglePublish() {
        if (!film) return
        setBusy(true)
        try {
            const res = await fetch('/api/artisans/me/story/film', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isPublic: !film.isPublic }),
            })
            if (res.ok) {
                const data = await res.json()
                setFilm(f => (f ? { ...f, isPublic: data.film.isPublic } : f))
            }
        } finally {
            setBusy(false)
        }
    }

    const isProcessing = film?.status === 'PENDING' || film?.status === 'PROCESSING'
    const isReady = film?.status === 'READY' && film.outputMediaId
    const isUploaded = film?.source === 'UPLOADED'

    // Offered whenever a render is not in flight: as an alternative to creating
    // a film, and afterwards as a way to replace one.
    const uploadControl = !isProcessing && (
        <StoryFilmUploadButton
            label={isReady ? t('uploadReplace') : t('uploadOwn')}
            disabled={busy}
            onUploaded={refresh}
        />
    )

    return (
        <div className="rounded-lg border border-border bg-muted/20 p-4">
            <div className="mb-2 flex items-center gap-2">
                <Clapperboard className="h-5 w-5 text-warm" />
                <h3 className="text-sm font-semibold">{t('title')}</h3>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">{t('description')}</p>

            {isProcessing && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('processing')}
                </p>
            )}

            {film?.status === 'FAILED' && (
                <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
                        <AlertCircle className="h-4 w-4" />
                        {t('failed')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => void startRender(false)} disabled={busy}>
                            <RefreshCw className="mr-1.5 h-4 w-4" />
                            {t('retry')}
                        </Button>
                        {/* A render that keeps failing should not trap the
                            artisan: their own film is a way through. */}
                        {uploadControl}
                    </div>
                </div>
            )}

            {isReady && (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" onClick={() => setOpen(true)}>
                            <Clapperboard className="mr-1.5 h-4 w-4" />
                            {t('watch')}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => void startRender(true)} disabled={busy}>
                            {busy ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="mr-1.5 h-4 w-4" />
                            )}
                            {isUploaded ? t('generateInstead') : t('regenerate')}
                        </Button>
                        {uploadControl}
                        {film.isPublic && (
                            <span className="text-xs font-medium text-warm">{t('published')}</span>
                        )}
                        {/* Rendering a film for an already published story does
                            not put it on the page: only publishing does that, and
                            the story is published already. Without this the film
                            sits finished and invisible with nothing to press. */}
                        {!film.isPublic && storyPublished && (
                            <Button type="button" size="sm" onClick={() => void togglePublish()} disabled={busy}>
                                {t('showOnStory')}
                            </Button>
                        )}
                    </div>
                    {isUploaded && (
                        <p className="text-xs text-muted-foreground">{t('uploadedBadge')}</p>
                    )}
                    {/* A generation that failed over an uploaded film leaves the
                        film in place and records why, so say so rather than
                        letting the attempt look successful. */}
                    {isUploaded && film.error && (
                        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {t('generateFailedKeptUpload')}
                        </p>
                    )}
                    {!film.isPublic && !storyPublished && (
                        <p className="text-xs text-muted-foreground">{t('willBeHighlight')}</p>
                    )}
                    {!film.isPublic && storyPublished && (
                        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {t('notShowingYet')}
                        </p>
                    )}
                    {stale && (
                        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {t('stale')}
                        </p>
                    )}
                </div>
            )}

            {!film && !isProcessing && (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" onClick={() => void startRender(false)} disabled={busy}>
                            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Clapperboard className="mr-1.5 h-4 w-4" />}
                            {t('create')}
                        </Button>
                        {uploadControl}
                    </div>
                    <p className="text-xs text-muted-foreground">{t('uploadHint')}</p>
                </div>
            )}

            {notice && <p className="mt-2 text-sm text-muted-foreground">{notice}</p>}

            {isReady && film.outputMediaId && (
                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>{t('premiereTitle')}</DialogTitle>
                            <DialogDescription>{t('description')}</DialogDescription>
                        </DialogHeader>
                        <CaptionedVideo
                            src={`/api/media/${film.outputMediaId}`}
                            captionsSrc={`/api/media/${film.outputMediaId}/subtitles`}
                            captionsLabel={tStory('captionsLabel')}
                            className="w-full rounded-md bg-black"
                        />
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => void startRender(true)} disabled={busy}>
                                <RefreshCw className="mr-1.5 h-4 w-4" />
                                {t('regenerate')}
                            </Button>
                            <a
                                href={`/api/media/${film.outputMediaId}`}
                                download
                                className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                                <Download className="mr-1.5 h-4 w-4" />
                                {t('download')}
                            </a>
                            {/* No separate "publish film" button — publishing the
                                story features a ready film. Only offer to hide it. */}
                            {film.isPublic && (
                                <Button type="button" variant="outline" size="sm" onClick={() => void togglePublish()} disabled={busy}>
                                    {t('unpublish')}
                                </Button>
                            )}
                        </div>
                        {!film.isPublic && (
                            <p className="text-xs text-muted-foreground">{t('willBeHighlight')}</p>
                        )}
                    </DialogContent>
                </Dialog>
            )}
        </div>
    )
}
