import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-guard'
import { errorResponse } from '@/lib/validations/types'
import { ANSWER_MEDIA_FIELDS, ANSWER_TEXT_FIELDS } from '@/lib/validations/craftStory'
import { canMakeFilm, getFilmIngredients } from '@/lib/film/eligibility'

export async function POST(request: Request) {
    const { session, unauthorized } = await requireAuth()
    if (unauthorized) return unauthorized

    try {
        // The wizard sends { consent: true } from its consent checkbox. Older
        // clients send no body at all, which parses to an empty object.
        const body = await request.json().catch(() => ({}))
        const consentGiven = (body as { consent?: unknown }).consent === true

        const artisan = await prisma.artisan.findUnique({
            where: { userId: session!.user.id },
            select: { id: true },
        })
        if (!artisan) return errorResponse('Artisan profile required', 409)

        const story = await prisma.craftStory.findUnique({
            where: { artisanId: artisan.id },
        })
        if (!story) return errorResponse('No story to publish', 404)

        const hasTextAnswer = ANSWER_TEXT_FIELDS.some(
            k => (story[k] ?? '').toString().trim().length > 0
        )
        const hasAnswerMedia = ANSWER_MEDIA_FIELDS.some(k => Boolean(story[k]))
        const workshopCount = await prisma.mediaAttachment.count({
            where: { entityType: 'CraftStory', entityId: story.id },
        })
        // An uploaded film is a story in itself: an artisan who arrives with a
        // finished film has something to publish even with no answers recorded.
        const uploadedFilm = await prisma.storyFilm.findFirst({
            where: { storyId: story.id, source: 'UPLOADED', status: 'READY' },
            select: { id: true },
        })
        const hasContent =
            hasTextAnswer || hasAnswerMedia || workshopCount > 0 || Boolean(uploadedFilm)

        if (!hasContent) {
            return NextResponse.json(
                {
                    error: 'EMPTY_STORY',
                    message: 'Add at least one written answer, recording, or workshop photo before publishing.',
                },
                { status: 400 }
            )
        }

        // Publishing puts the artisan's face, voice and chosen location in
        // public, so it needs their explicit consent. Stories consented to
        // earlier keep that consent and are not asked again.
        if (!story.consentedAt && !consentGiven) {
            return NextResponse.json(
                {
                    error: 'CONSENT_REQUIRED',
                    message: 'Confirm the publication consent before publishing your story.',
                },
                { status: 400 }
            )
        }

        // If this story has the raw material for a film, require a finished one
        // before publishing (the film is the story's headline). A story that
        // can't make a film publishes as the written page, and a FAILED render
        // is allowed through so a broken render never traps the artisan.
        // A story told out loud needs something to look at. Without a visual no
        // film can be built, and the public page falls back to listing every
        // recording as its own bare player, which reads as a broken page rather
        // than as a story. Ask for one picture instead of publishing that.
        const ingredients = await getFilmIngredients(story)
        const hasVisual = ingredients.workshopCount >= 1 || ingredients.videoAnswerCount >= 1
        if (ingredients.spokenCount >= 1 && !hasVisual) {
            return NextResponse.json(
                {
                    error: 'VISUAL_REQUIRED',
                    message:
                        'Add at least one photo or video of your work before publishing, so your story can be shown as a film rather than as a list of recordings.',
                },
                { status: 400 }
            )
        }

        if (canMakeFilm(ingredients)) {
            const film = await prisma.storyFilm.findUnique({
                where: { storyId: story.id },
                select: { status: true },
            })
            if (!film || film.status === 'PENDING' || film.status === 'PROCESSING') {
                return NextResponse.json(
                    {
                        error: 'FILM_REQUIRED',
                        message: 'Create your film before publishing your story.',
                    },
                    { status: 400 }
                )
            }
        }

        const updated = await prisma.craftStory.update({
            where: { artisanId: artisan.id },
            data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                ...(story.consentedAt ? {} : { consentedAt: new Date() }),
            },
        })

        // A rendered, READY film becomes the story's public hero. The artisan has
        // already previewed it in the wizard, so publishing the story approves it.
        await prisma.storyFilm.updateMany({
            where: { storyId: story.id, status: 'READY' },
            data: { isPublic: true },
        })

        return NextResponse.json({ story: updated })
    } catch (error) {
        console.error('Error publishing craft story:', error)
        return errorResponse('Failed to publish craft story', 500)
    }
}
