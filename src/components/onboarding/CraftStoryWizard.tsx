'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { AlertCircle, ArrowLeft, ArrowRight, Check, Loader2, Mic, Pencil, Save, Sparkles, Video } from 'lucide-react'
import { StepDots } from '@/components/shared/StepDots'
import { AnswerMediaUpload } from './AnswerMediaUpload'
import { StoryWorkshopUpload, type WorkshopMedia } from './StoryWorkshopUpload'
import { StoryFilmPanel } from './StoryFilmPanel'
import { StoryFilmUploadButton } from './StoryFilmUploadButton'
import { FilmStoryboard, type StoryboardAnswer } from './FilmStoryboard'
import { ANSWER_KEYS, type AnswerKey } from '@/lib/validations/craftStory'
import { mediaKind } from '@/lib/media-kind'
import type { TranscriptSegment } from '@/lib/vtt'

export type CraftStoryDraft = {
    id: string
    status: 'DRAFT' | 'PUBLISHED'
    lastStepReached: number
    updatedAt: string
    answerSelfText: string | null
    answerSelfMediaId: string | null
    answerCraftText: string | null
    answerCraftMediaId: string | null
    answerMeaningText: string | null
    answerMeaningMediaId: string | null
    answerBenefitsText: string | null
    answerBenefitsMediaId: string | null
    answerFutureText: string | null
    answerFutureMediaId: string | null
    answerChallengesText: string | null
    answerChallengesMediaId: string | null
    summaryText: string | null
    consentedAt: string | null
}

interface CraftStoryWizardProps {
    initialStory: CraftStoryDraft | null
    initialWorkshopMedia: WorkshopMedia[]
    // mediaId -> mimeType for saved answer media, so reloaded previews render correctly.
    answerMediaMimeTypes?: Record<string, string>
}

// 0=intro, 1-6=questions, 7=workshop media, 8=review
const TOTAL_STEPS = 9

export function CraftStoryWizard({
    initialStory,
    initialWorkshopMedia,
    answerMediaMimeTypes = {},
}: CraftStoryWizardProps) {
    const t = useTranslations('craftStory')
    const router = useRouter()

    const [step, setStep] = useState(initialStory?.lastStepReached ?? 0)
    const [story, setStory] = useState<Partial<CraftStoryDraft>>(initialStory ?? {})
    const [storyId, setStoryId] = useState<string | null>(initialStory?.id ?? null)
    const [knownUpdatedAt, setKnownUpdatedAt] = useState<string | null>(initialStory?.updatedAt ?? null)
    const [saving, setSaving] = useState(false)
    const [publishing, setPublishing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Publication consent. A story consented to on an earlier publish keeps it,
    // so re-publishing an edit does not ask again.
    const [consented, setConsented] = useState(Boolean(initialStory?.consentedAt))
    // True while editing a single step reached by clicking a section on the
    // review screen — lets us offer a direct "back to review" action.
    const [returnToReview, setReturnToReview] = useState(false)
    // mediaId -> transcript status for this story's videos (caption chips).
    const [captionStatuses, setCaptionStatuses] = useState<Record<string, string>>({})
    // Workshop media lives here (not inside the step component) so it survives
    // stepping away and back — the step subtree remounts on navigation.
    const [workshopMedia, setWorkshopMedia] = useState<WorkshopMedia[]>(initialWorkshopMedia)
    // mediaId -> mimeType for answer media, seeded from the server and extended
    // as new recordings upload, so a revisited video answer still renders as video.
    const [answerMimeTypes, setAnswerMimeTypes] = useState<Record<string, string>>(answerMediaMimeTypes)

    // Timed caption segments per media id, used by the film storyboard to snap
    // its preview cuts to the same speech beats the renderer will use.
    const [captionSegments, setCaptionSegments] = useState<Record<string, TranscriptSegment[]>>({})

    // Spoken answers drive the film's chapters and its length. Text-only answers
    // contribute nothing to the timeline, so they are left out.
    const storyboardAnswers: StoryboardAnswer[] = useMemo(() => {
        return ANSWER_KEYS.flatMap(key => {
            const mediaId = story[`answer${key}MediaId` as const] as string | null | undefined
            if (!mediaId) return []
            const kind = mediaKind(answerMimeTypes[mediaId])
            if (kind !== 'audio' && kind !== 'video') return []
            return [{ key, mediaId, kind }]
        })
    }, [story, answerMimeTypes])

    const refreshCaptionStatuses = useCallback(async () => {
        try {
            const res = await fetch('/api/artisans/me/story/transcripts')
            if (!res.ok) return
            const data = await res.json()
            setCaptionStatuses(data.statuses ?? {})
            setCaptionSegments(data.segments ?? {})
        } catch {
            // Chips are informational only — never surface fetch failures.
        }
    }, [])

    // Re-run any failed captions (e.g. a transient upstream error). The failed
    // rows flip back to processing, and the poll below picks them up.
    const retryCaptions = useCallback(async () => {
        try {
            const res = await fetch('/api/artisans/me/story/transcripts', { method: 'POST' })
            if (!res.ok) return
            const data = await res.json()
            setCaptionStatuses(data.statuses ?? {})
        } catch {
            // Informational retry — never surface fetch failures.
        }
    }, [])

    useEffect(() => {
        void refreshCaptionStatuses()
    }, [refreshCaptionStatuses])

    // Poll while any caption job is still running so chips flip to ready/failed.
    const hasActiveCaptionJobs = Object.values(captionStatuses).some(
        s => s === 'PENDING' || s === 'PROCESSING'
    )
    useEffect(() => {
        if (!hasActiveCaptionJobs) return
        const id = setInterval(() => void refreshCaptionStatuses(), 8000)
        return () => clearInterval(id)
    }, [hasActiveCaptionJobs, refreshCaptionStatuses])

    function setAnswerText(key: AnswerKey, value: string) {
        setStory(s => ({ ...s, [`answer${key}Text`]: value }))
    }
    function setAnswerMedia(key: AnswerKey, mediaId: string | null, mimeType?: string | null) {
        setStory(s => ({ ...s, [`answer${key}MediaId`]: mediaId }))
        if (mediaId && mimeType) {
            setAnswerMimeTypes(m => ({ ...m, [mediaId]: mimeType }))
        }
    }

    // Mirrors of state used inside queued background saves — a chained save
    // must read the values current at execution time, not the ones captured
    // when the save was queued.
    const storyRef = useRef(story)
    storyRef.current = story
    const knownUpdatedAtRef = useRef(knownUpdatedAt)
    knownUpdatedAtRef.current = knownUpdatedAt
    // Serializes saves so expectedUpdatedAt conflict detection stays coherent.
    const pendingSaveRef = useRef<Promise<boolean>>(Promise.resolve(true))

    async function save(nextStep: number): Promise<boolean> {
        setSaving(true)
        setError(null)
        const draft = storyRef.current
        try {
            const res = await fetch('/api/artisans/me/story', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lastStepReached: Math.max(nextStep, draft.lastStepReached ?? 0),
                    expectedUpdatedAt: knownUpdatedAtRef.current ?? undefined,
                    answerSelfText: draft.answerSelfText ?? null,
                    answerSelfMediaId: draft.answerSelfMediaId ?? null,
                    answerCraftText: draft.answerCraftText ?? null,
                    answerCraftMediaId: draft.answerCraftMediaId ?? null,
                    answerMeaningText: draft.answerMeaningText ?? null,
                    answerMeaningMediaId: draft.answerMeaningMediaId ?? null,
                    answerBenefitsText: draft.answerBenefitsText ?? null,
                    answerBenefitsMediaId: draft.answerBenefitsMediaId ?? null,
                    answerFutureText: draft.answerFutureText ?? null,
                    answerFutureMediaId: draft.answerFutureMediaId ?? null,
                    answerChallengesText: draft.answerChallengesText ?? null,
                    answerChallengesMediaId: draft.answerChallengesMediaId ?? null,
                    summaryText: draft.summaryText ?? null,
                }),
            })
            if (res.status === 409) {
                setError(t('errors.conflict'))
                return false
            }
            if (!res.ok) throw new Error('Save failed')
            const data = await res.json()
            if (data.story?.id) setStoryId(data.story.id)
            if (data.story?.updatedAt) {
                setKnownUpdatedAt(data.story.updatedAt)
                knownUpdatedAtRef.current = data.story.updatedAt
            }
            setStory(s => ({ ...s, ...data.story }))
            // Saving enqueues caption jobs for new videos — pick up their status.
            void refreshCaptionStatuses()
            return true
        } catch {
            setError(t('errors.saveFailed'))
            return false
        } finally {
            setSaving(false)
        }
    }

    // Queue a save behind any in-flight one. save() never rejects, so the
    // chain cannot break; callers that care await the returned promise.
    function queueSave(nextStep: number): Promise<boolean> {
        const queued = pendingSaveRef.current.then(() => save(nextStep))
        pendingSaveRef.current = queued
        return queued
    }

    function handleNext() {
        // Advance immediately — the save runs in the background so stepping
        // through the wizard never waits on the network. Failures surface in
        // the error banner, and publish/exit await the full save chain.
        const target = step + 1
        setStep(target)
        void queueSave(target)
    }

    function handleBack() {
        setStep(s => Math.max(0, s - 1))
    }

    // Save the current step's edits and return straight to the review screen.
    function handleReturnToReview() {
        setReturnToReview(false)
        setStep(TOTAL_STEPS - 1)
        void queueSave(step)
    }

    async function handleSaveExit() {
        await queueSave(step)
        router.push('/profile')
    }

    async function handlePublish() {
        setPublishing(true)
        setError(null)
        try {
            // Persist final state (behind any still-running background saves),
            // then publish.
            const saved = await queueSave(step)
            if (!saved) {
                setPublishing(false)
                return
            }
            const res = await fetch('/api/artisans/me/story/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ consent: consented }),
            })
            if (!res.ok) {
                let body: { error?: string; message?: string } | null = null
                try { body = await res.json() } catch { /* ignore */ }
                if (body?.error === 'EMPTY_STORY') {
                    setError(t('errors.emptyStory'))
                } else if (body?.error === 'FILM_REQUIRED') {
                    setError(t('errors.filmRequired'))
                } else if (body?.error === 'VISUAL_REQUIRED') {
                    setError(t('errors.visualRequired'))
                } else if (body?.error === 'CONSENT_REQUIRED') {
                    setError(t('errors.consentRequired'))
                } else {
                    setError(t('errors.publishFailed'))
                }
                setPublishing(false)
                return
            }
            // Keep the button disabled on success — router.push doesn't unmount
            // the wizard immediately, and re-enabling allowed a second publish.
            router.push('/profile')
        } catch {
            setError(t('errors.publishFailed'))
            setPublishing(false)
        }
    }

    const isQuestion = step >= 1 && step <= 6
    const currentKey = isQuestion ? ANSWER_KEYS[step - 1] : null
    const currentMediaId = currentKey
        ? ((story[`answer${currentKey}MediaId` as const] as string | null | undefined) ?? null)
        : null

    return (
        <div className="container mx-auto px-4 py-10">
            <Card className="mx-auto max-w-2xl overflow-hidden rounded-2xl shadow-lg">
                <div className="px-6 py-6" style={{ background: 'var(--sc-ink-deep)' }}>
                    <div className="flex items-center gap-3">
                        <Link
                            href="/profile"
                            className="rounded-md p-2 text-primary-foreground/70 transition-colors hover:bg-white/10 hover:text-primary-foreground"
                        >
                            <ArrowLeft className="h-5 w-5" />
                        </Link>
                        <div>
                            <h1 className="text-left text-2xl font-bold tracking-tight text-primary-foreground">
                                {t('wizardTitle')}
                            </h1>
                            <p className="text-left text-sm text-primary-foreground/70">
                                {t('wizardHelper')}
                            </p>
                        </div>
                    </div>
                </div>

                <CardContent className="p-6">
                    <StepDots current={step} total={TOTAL_STEPS} />
                    <p className="mb-8 text-center text-xs text-muted-foreground">
                        {t('stepLabel', { current: step + 1, total: TOTAL_STEPS })}
                    </p>

                    <div key={step} className="animate-in fade-in-50 slide-in-from-right-4 duration-300">
                        {step === 0 && (
                            <IntroStep
                                // The film needs a story to belong to, and at
                                // this point there may not be one saved yet.
                                onEnsureStory={() => queueSave(0)}
                                // Their film is done, so the work that remains
                                // is the summary and publishing: skip to review.
                                // Persist that jump, or a reload would drop them
                                // back at the intro with no sign of their film.
                                onFilmUploaded={() => {
                                    setStep(TOTAL_STEPS - 1)
                                    void queueSave(TOTAL_STEPS - 1)
                                }}
                            />
                        )}

                        {isQuestion && currentKey && (
                            <QuestionStep
                                index={step}
                                answerKey={currentKey}
                                text={(story[`answer${currentKey}Text` as const] as string | null | undefined) ?? ''}
                                mediaId={currentMediaId}
                                onTextChange={v => setAnswerText(currentKey, v)}
                                onMediaChange={(id, mime) => setAnswerMedia(currentKey, id, mime)}
                                captionStatus={currentMediaId ? captionStatuses[currentMediaId] : undefined}
                                initialMimeType={currentMediaId ? (answerMimeTypes[currentMediaId] ?? null) : null}
                            />
                        )}

                        {step === 7 && (
                            <WorkshopStep
                                storyId={storyId}
                                items={workshopMedia}
                                onItemsChange={setWorkshopMedia}
                                captionStatuses={captionStatuses}
                                onUploaded={refreshCaptionStatuses}
                                storyboardAnswers={storyboardAnswers}
                                captionSegments={captionSegments}
                            />
                        )}

                        {step === 8 && (
                            <ReviewStep
                                story={story}
                                workshopCount={workshopMedia.length}
                                captionStatuses={captionStatuses}
                                onEditStep={target => { setError(null); setReturnToReview(true); setStep(target) }}
                                summaryText={(story.summaryText as string | null | undefined) ?? ''}
                                onSummaryChange={value => {
                                    // Update the save ref synchronously so an immediate
                                    // persist (e.g. after applying an AI draft) sees it.
                                    storyRef.current = { ...storyRef.current, summaryText: value }
                                    setStory(s => ({ ...s, summaryText: value }))
                                }}
                                onPersistSummary={() => { void save(step) }}
                                onRetryCaptions={retryCaptions}
                                consented={consented}
                                onConsentChange={setConsented}
                            />
                        )}

                        {error && (
                            <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                                {error}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleBack}
                            disabled={step === 0 || publishing}
                            className="w-full sm:w-auto"
                        >
                            <ArrowLeft className="mr-1.5 h-4 w-4" />
                            {t('back')}
                        </Button>

                        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:items-center">
                            {step > 0 && step < TOTAL_STEPS - 1 && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={handleSaveExit}
                                    disabled={publishing}
                                    className="w-full sm:w-auto"
                                >
                                    <Save className="mr-1.5 h-4 w-4" />
                                    {t('saveExit')}
                                </Button>
                            )}
                            {saving && !publishing && (
                                <span className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground sm:mr-2">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    {t('saving')}
                                </span>
                            )}
                            {returnToReview && step > 0 && step < TOTAL_STEPS - 1 ? (
                                <Button type="button" onClick={handleReturnToReview} disabled={publishing} className="w-full sm:w-auto">
                                    <Check className="mr-1.5 h-4 w-4" />
                                    {t('backToReview')}
                                </Button>
                            ) : step < TOTAL_STEPS - 1 ? (
                                <Button type="button" onClick={handleNext} disabled={publishing} className="w-full sm:w-auto">
                                    {step === 0 ? t('begin') : t('next')}
                                    <ArrowRight className="ml-1.5 h-4 w-4" />
                                </Button>
                            ) : (
                                <Button type="button" onClick={handlePublish} disabled={saving || publishing || !consented} className="w-full sm:w-auto">
                                    {publishing ? (
                                        <>
                                            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                            {t('publishing')}
                                        </>
                                    ) : (
                                        <>
                                            <Check className="mr-1.5 h-4 w-4" />
                                            {t('publish')}
                                        </>
                                    )}
                                </Button>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

function IntroStep({
    onEnsureStory,
    onFilmUploaded,
}: {
    onEnsureStory: () => Promise<boolean>
    onFilmUploaded: () => void
}) {
    const t = useTranslations('craftStory.intro')
    const tFilm = useTranslations('craftStory.film')
    return (
        <div>
            <h1 className="mb-3 text-2xl font-bold tracking-tight sm:text-3xl">{t('title')}</h1>
            <p className="mb-4 text-base text-muted-foreground">{t('lead')}</p>
            <div className="mb-4 rounded-lg bg-muted/50 p-4">
                <p className="mb-2 text-sm font-medium">{t('formatsTitle')}</p>
                <ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
                    <li>{t('formatText')}</li>
                    <li>{t('formatAudio')}</li>
                    <li>{t('formatVideo')}</li>
                </ul>
            </div>
            <p className="mb-6 text-sm text-muted-foreground">{t('encouragement')}</p>

            {/* The alternative to the whole wizard, offered before the artisan
                starts rather than after they have answered everything. */}
            <div className="rounded-lg border border-border p-4">
                <p className="mb-1 text-sm font-medium">{t('alreadyHaveFilmTitle')}</p>
                <p className="mb-3 text-sm text-muted-foreground">{t('alreadyHaveFilmBody')}</p>
                <StoryFilmUploadButton
                    label={tFilm('uploadOwn')}
                    onBeforeUpload={onEnsureStory}
                    onUploaded={onFilmUploaded}
                />
            </div>
        </div>
    )
}

function QuestionStep({
    index,
    answerKey,
    text,
    mediaId,
    onTextChange,
    onMediaChange,
    captionStatus,
    initialMimeType,
}: {
    index: number
    answerKey: AnswerKey
    text: string
    mediaId: string | null
    onTextChange: (value: string) => void
    onMediaChange: (id: string | null, mimeType?: string | null) => void
    captionStatus?: string
    initialMimeType?: string | null
}) {
    const t = useTranslations('craftStory')
    return (
        <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-warm">
                {t('questionLabel', { index })}
            </p>
            <h1 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">
                {t(`step${index}.title`)}
            </h1>
            <p className="mb-6 text-base text-muted-foreground">{t(`step${index}.prompt`)}</p>

            <div className="space-y-4">
                {/* Primary: the recording is what plays in the film. */}
                <div className="rounded-xl border border-warm/30 bg-warm/5 p-4">
                    <div className="mb-1 flex items-center gap-2">
                        <Mic className="h-4 w-4 text-warm" />
                        <Video className="h-4 w-4 text-warm" />
                        <span className="text-sm font-semibold text-warm">{t('answerRecordTitle')}</span>
                    </div>
                    <p className="mb-3 text-xs text-muted-foreground">{t('answerRecordHint')}</p>
                    <AnswerMediaUpload
                        mediaId={mediaId}
                        onChange={onMediaChange}
                        initialMimeType={initialMimeType}
                        captionsReady={captionStatus === 'READY'}
                    />
                    {mediaId && (
                        <div className="mt-2">
                            <CaptionStatusChip status={captionStatus} />
                        </div>
                    )}
                </div>

                {/* Clear either/or between recording and writing. */}
                <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t('answerOr')}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                </div>

                {/* Secondary: a written answer, not used in the film. */}
                <div>
                    <Label htmlFor={`answer-${answerKey}`} className="mb-1 block text-sm font-medium">
                        {t('writeYourAnswer')}
                    </Label>
                    <p className="mb-1.5 text-xs text-muted-foreground">{t('answerWriteHint')}</p>
                    <Textarea
                        id={`answer-${answerKey}`}
                        value={text}
                        onChange={e => onTextChange(e.target.value)}
                        placeholder={t('answerPlaceholder')}
                        rows={5}
                    />
                </div>
            </div>
        </div>
    )
}

// Caption pipeline feedback — without it a FAILED transcription would be
// invisible to the artisan (there is no editing step to surface it).
function CaptionStatusChip({ status }: { status?: string }) {
    const t = useTranslations('craftStory.captions')
    if (!status) return null
    if (status === 'READY') {
        return (
            <p className="flex items-center gap-1.5 text-xs font-medium text-warm">
                <Check className="h-3.5 w-3.5" />
                {t('ready')}
            </p>
        )
    }
    if (status === 'FAILED') {
        return (
            <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                {t('failed')}
            </p>
        )
    }
    return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('processing')}
        </p>
    )
}

function WorkshopStep({
    storyId,
    items,
    onItemsChange,
    captionStatuses,
    onUploaded,
    storyboardAnswers,
    captionSegments,
}: {
    storyId: string | null
    items: WorkshopMedia[]
    onItemsChange: Dispatch<SetStateAction<WorkshopMedia[]>>
    captionStatuses: Record<string, string>
    onUploaded: () => void
    storyboardAnswers: StoryboardAnswer[]
    captionSegments: Record<string, TranscriptSegment[]>
}) {
    const t = useTranslations('craftStory.step7')
    return (
        <div>
            <h1 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">{t('title')}</h1>
            <p className="mb-6 text-base text-muted-foreground">{t('prompt')}</p>
            {storyId ? (
                <>
                    <StoryWorkshopUpload
                        storyId={storyId}
                        items={items}
                        onItemsChange={onItemsChange}
                        captionStatuses={captionStatuses}
                        onUploaded={onUploaded}
                    />
                    {/* Sits directly under the grid so a reorder and its effect
                        on the film are visible in one glance. */}
                    <FilmStoryboard
                        answers={storyboardAnswers}
                        workshopMedia={items}
                        segments={captionSegments}
                    />
                </>
            ) : (
                <p className="text-sm text-muted-foreground">{t('saveFirst')}</p>
            )}
        </div>
    )
}

function ReviewStep({
    story,
    workshopCount,
    captionStatuses,
    onEditStep,
    summaryText,
    onSummaryChange,
    onPersistSummary,
    onRetryCaptions,
    consented,
    onConsentChange,
}: {
    story: Partial<CraftStoryDraft>
    workshopCount: number
    captionStatuses: Record<string, string>
    onEditStep: (step: number) => void
    summaryText: string
    onSummaryChange: (value: string) => void
    onPersistSummary: () => void
    onRetryCaptions: () => void
    consented: boolean
    onConsentChange: (value: boolean) => void
}) {
    const t = useTranslations('craftStory')
    const statusValues = Object.values(captionStatuses)
    const captionsProcessing = statusValues.some(s => s === 'PENDING' || s === 'PROCESSING')
    const captionsFailed = statusValues.some(s => s === 'FAILED')
    const rows = ANSWER_KEYS.map((key, i) => {
        const text = story[`answer${key}Text` as const] as string | null | undefined
        const media = story[`answer${key}MediaId` as const] as string | null | undefined
        const summary = [
            text?.trim() ? `${(text as string).slice(0, 80)}${(text as string).length > 80 ? '…' : ''}` : null,
            media ? t('review.hasRecording') : null,
        ].filter(Boolean).join(' · ')
        return {
            // Questions occupy steps 1-6, in the same order as ANSWER_KEYS.
            step: i + 1,
            label: t(`step${i + 1}.title`),
            value: summary || null,
        }
    })

    // Workshop media is its own step (7); add it as a final editable row.
    const allRows = [
        ...rows,
        { step: 7, label: t('step7.title'), value: t('review.workshopCount', { count: workshopCount }) },
    ]

    return (
        <div>
            <h1 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">{t('review.title')}</h1>
            <p className="mb-6 text-base text-muted-foreground">{t('review.lead')}</p>

            {/* The film is the headline of the story — offer it first. */}
            <StoryFilmPanel storyPublished={story.status === 'PUBLISHED'} />

            <div className="mt-6">
                <SummaryEditor value={summaryText} onChange={onSummaryChange} onPersist={onPersistSummary} />
            </div>

            <div className="mt-8 divide-y divide-border overflow-hidden rounded-lg border border-border">
                {allRows.map(({ step, label, value }) => (
                    <button
                        key={label}
                        type="button"
                        onClick={() => onEditStep(step)}
                        aria-label={t('review.editStep', { section: label })}
                        className="group flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:flex-row sm:items-start sm:justify-between"
                    >
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground sm:w-1/3">
                            {label}
                        </span>
                        <span className="flex items-start gap-2 sm:w-2/3">
                            <span className={`text-sm ${value ? 'font-medium' : 'italic text-muted-foreground'}`}>
                                {value ?? t('review.notAnswered')}
                            </span>
                            <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                        </span>
                    </button>
                ))}
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">{t('review.editHint')}</p>
            {captionsProcessing && (
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('captions.someProcessing')}
                </p>
            )}
            {captionsFailed && (
                <div className="mt-3 flex flex-col items-center gap-1.5">
                    <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {t('captions.someFailed')}
                    </p>
                    <Button type="button" variant="ghost" size="sm" onClick={onRetryCaptions}>
                        {t('captions.retry')}
                    </Button>
                </div>
            )}

            {/* Publishing puts the artisan's face, voice and chosen location in
                public, so it is confirmed explicitly rather than implied by the
                Publish button. */}
            <div className="mt-8 rounded-lg border border-border bg-muted/30 p-4">
                <h2 className="mb-2 text-sm font-semibold">{t('consent.title')}</h2>
                <label className="flex items-start gap-3 text-sm">
                    <input
                        type="checkbox"
                        checked={consented}
                        onChange={e => onConsentChange(e.target.checked)}
                        className="mt-1 h-4 w-4 shrink-0 accent-[color:var(--sc-accent)]"
                    />
                    <span className="leading-snug text-muted-foreground">{t('consent.body')}</span>
                </label>
            </div>
        </div>
    )
}

// A short editable summary of the whole story. "Suggest" drafts one from the
// artisan's answers + transcripts via the server; the artisan owns the final text.
function SummaryEditor({
    value,
    onChange,
    onPersist,
}: {
    value: string
    onChange: (value: string) => void
    onPersist: () => void
}) {
    const t = useTranslations('craftStory.summary')
    const [drafting, setDrafting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function suggest() {
        setDrafting(true)
        setError(null)
        try {
            const res = await fetch('/api/artisans/me/story/summary/draft', { method: 'POST' })
            if (res.status === 429) return setError(t('rateLimited'))
            if (res.status === 400) return setError(t('empty'))
            if (!res.ok) return setError(t('failed'))
            const data = await res.json()
            if (data.draft) {
                onChange(data.draft)
                onPersist()
            }
        } catch {
            setError(t('failed'))
        } finally {
            setDrafting(false)
        }
    }

    return (
        <div className="mt-6 rounded-lg border border-border p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
                <Label htmlFor="story-summary" className="text-sm font-medium">
                    {t('label')}
                </Label>
                <Button type="button" size="sm" variant="outline" onClick={() => void suggest()} disabled={drafting}>
                    {drafting ? (
                        <>
                            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            {t('suggesting')}
                        </>
                    ) : (
                        <>
                            <Sparkles className="mr-1.5 h-4 w-4" />
                            {t('suggest')}
                        </>
                    )}
                </Button>
            </div>
            <Textarea
                id="story-summary"
                value={value}
                onChange={e => onChange(e.target.value)}
                onBlur={onPersist}
                placeholder={t('hint')}
                rows={4}
                maxLength={1200}
            />
            {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
    )
}
