import { Prisma } from '@prisma/client'

// Helper to check if a URL is accessible
async function checkUrlExists(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { method: 'HEAD' })
        return response.ok
    } catch {
        return false
    }
}

export type BackupData = {
    version: string
    exportedAt: string
    group: {
        id: string
        name: string
        information: string | null
        currency: string
        currencyCode: string | null
        createdAt: string
    }
    participants: Array<{
        id: string
        name: string
    }>
    expenses: Array<{
        id: string
        expenseDate: string
        createdAt: string
        title: string
        category: {
            id: number
            name: string
            grouping: string
        } | null
        amount: number
        originalAmount: number | null
        originalCurrency: string | null
        conversionRate: string | null
        paidById: string
        paidFor: Array<{
            participantId: string
            shares: number
        }>
        isReimbursement: boolean
        splitMode: string
        notes: string | null
        documents: Array<{
            id: string
            url: string
            width: number
            height: number
        }>
        recurrenceRule: string | null
        recurringExpenseLink: {
            id: string
            nextExpenseCreatedAt: string | null
            nextExpenseDate: string
        } | null
    }>
    activities: Array<{
        id: string
        time: string
        activityType: string
        participantId: string | null
        expenseId: string | null
        data: string | null
    }>
}

export enum VersionComparisonResult {
    NEWER = 'NEWER', // Backup is newer than existing group
    OLDER = 'OLDER', // Backup is older than existing group
    SAME = 'SAME', // Same version
    NOT_FOUND = 'NOT_FOUND', // Group doesn't exist
}

export type GroupComparison = {
    result: VersionComparisonResult
    existingGroupUpdatedAt?: Date
    backupExportedAt: Date
    differences?: {
        addedExpenses: number
        removedExpenses: number
        modifiedExpenses: number
        addedParticipants: number
        removedParticipants: number
    }
}

/**
 * Compare backup timestamp with existing group data
 */
export function compareVersions(
    backupData: BackupData,
    existingGroup: {
        createdAt: Date
        expenses: Array<{ createdAt: Date }>
        activities: Array<{ time: Date }>
    } | null,
): GroupComparison {
    const backupExportedAt = new Date(backupData.exportedAt)

    if (!existingGroup) {
        return {
            result: VersionComparisonResult.NOT_FOUND,
            backupExportedAt,
        }
    }

    // Get the latest update time from existing group (most recent expense or activity)
    const latestExpenseTime = existingGroup.expenses.length > 0
        ? new Date(Math.max(...existingGroup.expenses.map(e => e.createdAt.getTime())))
        : existingGroup.createdAt

    const latestActivityTime = existingGroup.activities.length > 0
        ? new Date(Math.max(...existingGroup.activities.map(a => a.time.getTime())))
        : existingGroup.createdAt

    const existingGroupUpdatedAt = new Date(
        Math.max(latestExpenseTime.getTime(), latestActivityTime.getTime())
    )

    // Compare timestamps
    if (backupExportedAt > existingGroupUpdatedAt) {
        return {
            result: VersionComparisonResult.NEWER,
            existingGroupUpdatedAt,
            backupExportedAt,
        }
    } else if (backupExportedAt < existingGroupUpdatedAt) {
        return {
            result: VersionComparisonResult.OLDER,
            existingGroupUpdatedAt,
            backupExportedAt,
        }
    } else {
        return {
            result: VersionComparisonResult.SAME,
            existingGroupUpdatedAt,
            backupExportedAt,
        }
    }
}

/**
 * Calculate differences between backup and existing group
 */
export function calculateDifferences(
    backupData: BackupData,
    existingGroup: {
        participants: Array<{ id: string }>
        expenses: Array<{ id: string }>
    },
) {
    const backupExpenseIds = new Set(backupData.expenses.map(e => e.id))
    const existingExpenseIds = new Set(existingGroup.expenses.map(e => e.id))

    const backupParticipantIds = new Set(backupData.participants.map(p => p.id))
    const existingParticipantIds = new Set(existingGroup.participants.map(p => p.id))

    return {
        addedExpenses: backupData.expenses.filter(e => !existingExpenseIds.has(e.id)).length,
        removedExpenses: existingGroup.expenses.filter(e => !backupExpenseIds.has(e.id)).length,
        modifiedExpenses: 0, // Could implement deep comparison if needed
        addedParticipants: backupData.participants.filter(p => !existingParticipantIds.has(p.id)).length,
        removedParticipants: existingGroup.participants.filter(p => !backupParticipantIds.has(p.id)).length,
    }
}

/**
 * Restore group from backup data
 */
export async function restoreGroupFromBackup(
    prisma: Prisma.TransactionClient,
    backupData: BackupData,
    mode: 'create' | 'update' | 'rollback',
): Promise<{ success: boolean; warnings: string[] }> {
    const { group, participants, expenses, activities } = backupData
    const warnings: string[] = []

    if (mode === 'create') {
        // Create new group with all data
        await prisma.group.create({
            data: {
                id: group.id,
                name: group.name,
                information: group.information,
                currency: group.currency,
                currencyCode: group.currencyCode,
                createdAt: new Date(group.createdAt),
            },
        })
    } else if (mode === 'rollback') {
        // Delete all existing data and recreate
        await prisma.activity.deleteMany({ where: { groupId: group.id } })
        await prisma.expense.deleteMany({ where: { groupId: group.id } })
        await prisma.participant.deleteMany({ where: { groupId: group.id } })

        // Update group metadata
        await prisma.group.update({
            where: { id: group.id },
            data: {
                name: group.name,
                information: group.information,
                currency: group.currency,
                currencyCode: group.currencyCode,
            },
        })
    }

    // Create/restore participants
    if (mode === 'create' || mode === 'rollback') {
        for (const participant of participants) {
            await prisma.participant.create({
                data: {
                    id: participant.id,
                    name: participant.name,
                    groupId: group.id,
                },
            })
        }
    } else if (mode === 'update') {
        // In update mode, only add missing participants
        const existingParticipants = await prisma.participant.findMany({
            where: { groupId: group.id },
            select: { id: true },
        })
        const existingIds = new Set(existingParticipants.map(p => p.id))

        for (const participant of participants) {
            if (!existingIds.has(participant.id)) {
                await prisma.participant.create({
                    data: {
                        id: participant.id,
                        name: participant.name,
                        groupId: group.id,
                    },
                })
            }
        }
    }

    // Create/restore expenses
    if (mode === 'create' || mode === 'rollback') {
        for (const expense of expenses) {
            // First create the expense
            await prisma.expense.create({
                data: {
                    id: expense.id,
                    groupId: group.id,
                    expenseDate: new Date(expense.expenseDate),
                    createdAt: new Date(expense.createdAt),
                    title: expense.title,
                    categoryId: expense.category?.id ?? 0,
                    amount: expense.amount,
                    originalAmount: expense.originalAmount,
                    originalCurrency: expense.originalCurrency,
                    conversionRate: expense.conversionRate ? new Prisma.Decimal(expense.conversionRate) : null,
                    paidById: expense.paidById,
                    isReimbursement: expense.isReimbursement,
                    splitMode: expense.splitMode as any,
                    notes: expense.notes,
                    recurrenceRule: expense.recurrenceRule as any,
                },
            })

            // Create paidFor relations
            for (const paidFor of expense.paidFor) {
                await prisma.expensePaidFor.create({
                    data: {
                        expenseId: expense.id,
                        participantId: paidFor.participantId,
                        shares: paidFor.shares,
                    },
                })
            }

            // Create documents (check if URLs exist first)
            for (const doc of expense.documents) {
                const urlExists = await checkUrlExists(doc.url)
                if (urlExists) {
                    // Use upsert to handle existing documents
                    await prisma.expenseDocument.upsert({
                        where: { id: doc.id },
                        create: {
                            id: doc.id,
                            url: doc.url,
                            width: doc.width,
                            height: doc.height,
                            expenseId: expense.id,
                        },
                        update: {
                            url: doc.url,
                            width: doc.width,
                            height: doc.height,
                            expenseId: expense.id,
                        },
                    })
                } else {
                    warnings.push(`Document not found for expense "${expense.title}": ${doc.url}`)
                }
            }

            // Create recurring expense link if exists
            if (expense.recurringExpenseLink) {
                await prisma.recurringExpenseLink.create({
                    data: {
                        id: expense.recurringExpenseLink.id,
                        groupId: group.id,
                        currentFrameExpenseId: expense.id,
                        nextExpenseCreatedAt: expense.recurringExpenseLink.nextExpenseCreatedAt
                            ? new Date(expense.recurringExpenseLink.nextExpenseCreatedAt)
                            : null,
                        nextExpenseDate: new Date(expense.recurringExpenseLink.nextExpenseDate),
                    },
                })
            }
        }
    } else if (mode === 'update') {
        // In update mode, only add missing expenses
        const existingExpenses = await prisma.expense.findMany({
            where: { groupId: group.id },
            select: { id: true },
        })
        const existingIds = new Set(existingExpenses.map(e => e.id))

        for (const expense of expenses) {
            if (!existingIds.has(expense.id)) {
                await prisma.expense.create({
                    data: {
                        id: expense.id,
                        groupId: group.id,
                        expenseDate: new Date(expense.expenseDate),
                        createdAt: new Date(expense.createdAt),
                        title: expense.title,
                        categoryId: expense.category?.id ?? 0,
                        amount: expense.amount,
                        originalAmount: expense.originalAmount,
                        originalCurrency: expense.originalCurrency,
                        conversionRate: expense.conversionRate ? new Prisma.Decimal(expense.conversionRate) : null,
                        paidById: expense.paidById,
                        isReimbursement: expense.isReimbursement,
                        splitMode: expense.splitMode as any,
                        notes: expense.notes,
                        recurrenceRule: expense.recurrenceRule as any,
                    },
                })

                for (const paidFor of expense.paidFor) {
                    await prisma.expensePaidFor.create({
                        data: {
                            expenseId: expense.id,
                            participantId: paidFor.participantId,
                            shares: paidFor.shares,
                        },
                    })
                }

                for (const doc of expense.documents) {
                    const urlExists = await checkUrlExists(doc.url)
                    if (urlExists) {
                        // Use upsert to handle existing documents
                        await prisma.expenseDocument.upsert({
                            where: { id: doc.id },
                            create: {
                                id: doc.id,
                                url: doc.url,
                                width: doc.width,
                                height: doc.height,
                                expenseId: expense.id,
                            },
                            update: {
                                url: doc.url,
                                width: doc.width,
                                height: doc.height,
                                expenseId: expense.id,
                            },
                        })
                    } else {
                        warnings.push(`Document not found for expense "${expense.title}": ${doc.url}`)
                    }
                }
            }
        }
    }

    // Restore activities
    if (mode === 'create' || mode === 'rollback') {
        for (const activity of activities) {
            await prisma.activity.create({
                data: {
                    id: activity.id,
                    groupId: group.id,
                    time: new Date(activity.time),
                    activityType: activity.activityType as any,
                    participantId: activity.participantId,
                    expenseId: activity.expenseId,
                    data: activity.data,
                },
            })
        }
    }

    return { success: true, warnings }
}
