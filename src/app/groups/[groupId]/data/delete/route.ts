import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'

export async function POST(
    req: Request,
    { params }: { params: Promise<{ groupId: string }> }
) {
    try {
        const { groupId } = await params
        const { action } = await req.json() as { action: 'undo-import' }

        // Verify group exists
        const group = await prisma.group.findUnique({
            where: { id: groupId },
            include: {
                activities: {
                    where: {
                        data: {
                            startsWith: 'JSON_IMPORT_START:',
                        },
                    },
                    orderBy: { time: 'desc' },
                    take: 1,
                },
            },
        })

        if (!group) {
            return NextResponse.json(
                { error: 'Group not found' },
                { status: 404 }
            )
        }

        if (action === 'undo-import') {
            // Find the most recent import marker
            const lastImport = group.activities[0]

            if (!lastImport) {
                return NextResponse.json(
                    { error: 'No import found to undo' },
                    { status: 400 }
                )
            }

            // Delete all expenses and participants created after the import marker
            await prisma.$transaction(async (tx) => {
                // Delete expense paid-for entries first (foreign key constraint)
                await tx.expensePaidFor.deleteMany({
                    where: {
                        expense: {
                            groupId: groupId,
                            createdAt: {
                                gte: lastImport.time,
                            },
                        },
                    },
                })

                // Delete expenses created during or after import
                await tx.expense.deleteMany({
                    where: {
                        groupId: groupId,
                        createdAt: {
                            gte: lastImport.time,
                        },
                    },
                })

                // Delete participants - Note: Can't filter by createdAt as it doesn't exist
                // We'll keep participants to avoid breaking expense references
                // Alternatively, delete only participants not referenced by remaining expenses

                // Delete activities from the import
                await tx.activity.deleteMany({
                    where: {
                        groupId: groupId,
                        time: {
                            gte: lastImport.time,
                        },
                    },
                })
            })

            revalidatePath(`/groups/${groupId}`)
            revalidatePath(`/groups/${groupId}/expenses`)
            revalidatePath(`/groups/${groupId}/balances`)
            revalidatePath(`/groups/${groupId}/activity`)

            return NextResponse.json({
                success: true,
                message: 'Successfully undid last import',
            })
        }

        return NextResponse.json(
            { error: 'Invalid action' },
            { status: 400 }
        )
    } catch (error) {
        console.error('Delete operation error:', error)
        return NextResponse.json(
            {
                error: 'Failed to delete data',
                details: error instanceof Error ? error.message : 'Unknown error'
            },
            { status: 500 }
        )
    }
}
