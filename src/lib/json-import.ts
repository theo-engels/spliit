import { Prisma, RecurrenceRule, SplitMode } from '@prisma/client'
import { randomUUID } from 'crypto'

// Type for the standard JSON export format
export type JSONImportData = {
    id: string
    name: string
    currency: string
    currencyCode: string | null
    expenses: Array<{
        createdAt: string
        expenseDate: string
        title: string
        category: {
            grouping: string
            name: string
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
        recurrenceRule: string | null
    }>
    participants: Array<{
        id: string
        name: string
    }>
}

export enum VersionComparisonResult {
    NEWER = 'NEWER',
    OLDER = 'OLDER',
    SAME = 'SAME',
    NOT_FOUND = 'NOT_FOUND',
}

export type VersionComparison = {
    result: VersionComparisonResult
    existingGroupUpdatedAt?: Date
    jsonExportedAt: Date
}

export type JSONGroupComparison = {
    addedExpenses: number
    removedExpenses: number
    modifiedExpenses: number
    addedParticipants: number
    removedParticipants: number
}

type ExistingGroup = {
    participants: Array<{ id: string }>
    expenses: Array<{ id: string; createdAt: Date; expenseDate: Date }>
    activities: Array<{ time: Date }>
}

function mapSplitMode(value: string): SplitMode {
    switch (value) {
        case 'BY_SHARES':
            return SplitMode.BY_SHARES
        case 'BY_PERCENTAGE':
            return SplitMode.BY_PERCENTAGE
        case 'BY_AMOUNT':
            return SplitMode.BY_AMOUNT
        case 'EVENLY':
        default:
            return SplitMode.EVENLY
    }
}

function mapRecurrenceRule(value: string | null): RecurrenceRule {
    switch (value) {
        case 'DAILY':
            return RecurrenceRule.DAILY
        case 'WEEKLY':
            return RecurrenceRule.WEEKLY
        case 'MONTHLY':
            return RecurrenceRule.MONTHLY
        case 'NONE':
        default:
            return RecurrenceRule.NONE
    }
}

/**
 * Compare JSON export version with existing group
 */
export function compareJSONVersions(
    jsonData: JSONImportData,
    existingGroup: ExistingGroup | null,
): VersionComparison {
    // Use the latest expense date as the JSON "export date"
    const latestExpenseDate = jsonData.expenses.length > 0
        ? new Date(Math.max(...jsonData.expenses.map(e => new Date(e.expenseDate).getTime())))
        : new Date(0)

    if (!existingGroup) {
        return {
            result: VersionComparisonResult.NOT_FOUND,
            jsonExportedAt: latestExpenseDate,
        }
    }

    // Get the latest timestamp from existing group (latest expense or activity)
    const latestExpense = existingGroup.expenses.length > 0
        ? new Date(Math.max(...existingGroup.expenses.map(e => e.expenseDate.getTime())))
        : null

    const latestActivity = existingGroup.activities.length > 0
        ? new Date(Math.max(...existingGroup.activities.map(a => a.time.getTime())))
        : null

    const existingGroupUpdatedAt = latestExpense && latestActivity
        ? new Date(Math.max(latestExpense.getTime(), latestActivity.getTime()))
        : latestExpense || latestActivity || new Date(0)

    // Compare timestamps
    if (latestExpenseDate.getTime() > existingGroupUpdatedAt.getTime()) {
        return {
            result: VersionComparisonResult.NEWER,
            existingGroupUpdatedAt,
            jsonExportedAt: latestExpenseDate,
        }
    } else if (latestExpenseDate.getTime() < existingGroupUpdatedAt.getTime()) {
        return {
            result: VersionComparisonResult.OLDER,
            existingGroupUpdatedAt,
            jsonExportedAt: latestExpenseDate,
        }
    } else {
        return {
            result: VersionComparisonResult.SAME,
            existingGroupUpdatedAt,
            jsonExportedAt: latestExpenseDate,
        }
    }
}

/**
 * Calculate differences between JSON import and existing group
 */
export function calculateJSONDifferences(
    jsonData: JSONImportData,
    existingGroup: ExistingGroup,
): JSONGroupComparison {
    const existingExpenseIds = new Set(existingGroup.expenses.map(e => e.id))
    const existingParticipantIds = new Set(existingGroup.participants.map(p => p.id))

    // Note: JSON export doesn't include expense IDs, so we can't accurately determine
    // which expenses are new vs modified. We'll use creation date as a heuristic.
    const existingExpenseDates = new Set(
        existingGroup.expenses.map(e => e.expenseDate.toISOString().split('T')[0])
    )

    const jsonExpenseDates = new Set(
        jsonData.expenses.map(e => new Date(e.expenseDate).toISOString().split('T')[0])
    )

    const addedExpenses = jsonData.expenses.filter(
        e => !existingExpenseDates.has(new Date(e.expenseDate).toISOString().split('T')[0])
    ).length

    const removedExpenses = existingGroup.expenses.filter(
        e => !jsonExpenseDates.has(e.expenseDate.toISOString().split('T')[0])
    ).length

    const addedParticipants = jsonData.participants.filter(
        p => !existingParticipantIds.has(p.id)
    ).length

    const removedParticipants = existingGroup.participants.filter(
        p => !jsonData.participants.some(jp => jp.id === p.id)
    ).length

    return {
        addedExpenses,
        removedExpenses,
        modifiedExpenses: 0, // Cannot accurately determine from JSON
        addedParticipants,
        removedParticipants,
    }
}

/**
 * Restore group from JSON export data
 */
export async function restoreGroupFromJSON(
    tx: Prisma.TransactionClient,
    jsonData: JSONImportData,
    mode: 'create' | 'update' | 'rollback',
): Promise<void> {
    const importTime = new Date()
    
    
    if (mode === 'create') {
        // Create new group
        await tx.group.create({
            data: {
                id: jsonData.id,
                name: jsonData.name,
                currency: jsonData.currency,
                currencyCode: jsonData.currencyCode,
                participants: {
                    create: jsonData.participants.map(p => ({
                        id: p.id,
                        name: p.name,
                    })),
                },
            },
        })


        // Mark the start of JSON import
        await tx.activity.create({
            data: {
                id: randomUUID(),
                groupId: jsonData.id,
                activityType: 'UPDATE_GROUP',
                time: importTime,
                data: `JSON_IMPORT_START:${mode}:${jsonData.expenses.length} expenses`,
            },
        })

        // Verify all participants exist and create a map
        const participantIds = new Set(jsonData.participants.map(p => p.id))
        
        
        // Create categories and expenses
        for (const expense of jsonData.expenses) {
            // Validate participant IDs
            if (!participantIds.has(expense.paidById)) {
                console.error(`[JSON Import ERROR] Participant ${expense.paidById} not found. Available:`, Array.from(participantIds))
                throw new Error(`Invalid paidById: ${expense.paidById} not found in participants for expense "${expense.title}". This expense was paid by a participant that doesn't exist in the imported participant list.`)
            }
            for (const pf of expense.paidFor) {
                if (!participantIds.has(pf.participantId)) {
                    console.error(`[JSON Import ERROR] Participant ${pf.participantId} not found. Available:`, Array.from(participantIds))
                    throw new Error(`Invalid participantId: ${pf.participantId} not found in participants for expense "${expense.title}". This expense is shared with a participant that doesn't exist in the imported participant list.`)
                }
            }

            let categoryId: number | null = null

            if (expense.category) {
                let category = await tx.category.findFirst({
                    where: {
                        grouping: expense.category.grouping,
                        name: expense.category.name,
                    },
                })

                if (!category) {
                    category = await tx.category.create({
                        data: {
                            grouping: expense.category.grouping,
                            name: expense.category.name,
                        },
                    })
                }

                categoryId = category.id
            }

            const expenseId = randomUUID()
            await tx.expense.create({
                data: {
                    id: expenseId,
                    groupId: jsonData.id,
                    expenseDate: new Date(expense.expenseDate),
                    title: expense.title,
                    categoryId: categoryId ?? 0,
                    amount: expense.amount,
                    originalAmount: expense.originalAmount,
                    originalCurrency: expense.originalCurrency,
                    conversionRate: expense.conversionRate ? parseFloat(expense.conversionRate) : null,
                    paidById: expense.paidById,
                    isReimbursement: expense.isReimbursement,
                    splitMode: mapSplitMode(expense.splitMode),
                    recurrenceRule: mapRecurrenceRule(expense.recurrenceRule),
                    paidFor: {
                        create: expense.paidFor.map(pf => ({
                            participantId: pf.participantId,
                            shares: pf.shares,
                        })),
                    },
                },
            })

            // Create activity log for imported expense, embedding import date
            await tx.activity.create({
                data: {
                    id: randomUUID(),
                    groupId: jsonData.id,
                    activityType: 'CREATE_EXPENSE',
                    time: importTime,
                    expenseId: expenseId,
                    data: JSON.stringify({ title: expense.title, importDate: importTime.toISOString() }),
                },
            })
        }
    } else if (mode === 'update') {
        // Update existing group - only add new expenses and participants
        const existingGroup = await tx.group.findUnique({
            where: { id: jsonData.id },
            include: {
                participants: true,
                expenses: true,
            },
        })

        if (!existingGroup) {
            throw new Error('Group not found')
        }

        // Mark the start of JSON import
        await tx.activity.create({
            data: {
                id: randomUUID(),
                groupId: jsonData.id,
                activityType: 'UPDATE_GROUP',
                time: importTime,
                data: `JSON_IMPORT_START:${mode}:${jsonData.expenses.length} expenses`,
            },
        })

        // Update group metadata
        await tx.group.update({
            where: { id: jsonData.id },
            data: {
                name: jsonData.name,
                currency: jsonData.currency,
                currencyCode: jsonData.currencyCode,
            },
        })

        // Add new participants
        const existingParticipantIds = new Set(existingGroup.participants.map(p => p.id))
        for (const participant of jsonData.participants) {
            if (!existingParticipantIds.has(participant.id)) {
                await tx.participant.create({
                    data: {
                        id: participant.id,
                        groupId: jsonData.id,
                        name: participant.name,
                    },
                })
                existingParticipantIds.add(participant.id)
            }
        }

        // Add new expenses (based on expenseDate + title combination as pseudo-ID)
        const existingExpenseKeys = new Set(
            existingGroup.expenses.map(e =>
                `${e.expenseDate.toISOString()}:${e.title}`
            )
        )

        for (const expense of jsonData.expenses) {
            const expenseKey = `${new Date(expense.expenseDate).toISOString()}:${expense.title}`
            if (!existingExpenseKeys.has(expenseKey)) {
                // Validate participant IDs exist
                if (!existingParticipantIds.has(expense.paidById)) {
                    throw new Error(`Invalid paidById: ${expense.paidById} not found in participants for expense "${expense.title}"`)
                }
                for (const pf of expense.paidFor) {
                    if (!existingParticipantIds.has(pf.participantId)) {
                        throw new Error(`Invalid participantId: ${pf.participantId} not found in participants for expense "${expense.title}"`)
                    }
                }

                let categoryId: number | null = null

                if (expense.category) {
                    let category = await tx.category.findFirst({
                        where: {
                            grouping: expense.category.grouping,
                            name: expense.category.name,
                        },
                    })

                    if (!category) {
                        category = await tx.category.create({
                            data: {
                                grouping: expense.category.grouping,
                                name: expense.category.name,
                            },
                        })
                    }

                    categoryId = category.id
                }

                const expenseId = randomUUID()
                await tx.expense.create({
                    data: {
                        id: expenseId,
                        groupId: jsonData.id,
                        expenseDate: new Date(expense.expenseDate),
                        title: expense.title,
                        categoryId: categoryId ?? 0,
                        amount: expense.amount,
                        originalAmount: expense.originalAmount,
                        originalCurrency: expense.originalCurrency,
                        conversionRate: expense.conversionRate ? parseFloat(expense.conversionRate) : null,
                        paidById: expense.paidById,
                        isReimbursement: expense.isReimbursement,
                        splitMode: mapSplitMode(expense.splitMode),
                        recurrenceRule: mapRecurrenceRule(expense.recurrenceRule),
                        paidFor: {
                            create: expense.paidFor.map(pf => ({
                                participantId: pf.participantId,
                                shares: pf.shares,
                            })),
                        },
                    },
                })

                // Create activity log for imported expense, embedding import date
                await tx.activity.create({
                    data: {
                        id: randomUUID(),
                        groupId: jsonData.id,
                        activityType: 'CREATE_EXPENSE',
                        time: importTime,
                        expenseId: expenseId,
                        data: JSON.stringify({ title: expense.title, importDate: importTime.toISOString() }),
                    },
                })
            }
        }
    } else if (mode === 'rollback') {
        // Delete all existing expenses and participants, then recreate from JSON
        await tx.expensePaidFor.deleteMany({
            where: {
                expense: {
                    groupId: jsonData.id,
                },
            },
        })

        await tx.expense.deleteMany({
            where: { groupId: jsonData.id },
        })

        await tx.participant.deleteMany({
            where: { groupId: jsonData.id },
        })

        await tx.activity.deleteMany({
            where: { groupId: jsonData.id },
        })

        // Update group metadata
        await tx.group.update({
            where: { id: jsonData.id },
            data: {
                name: jsonData.name,
                currency: jsonData.currency,
                currencyCode: jsonData.currencyCode,
            },
        })

        // Mark the start of JSON import (rollback)
        await tx.activity.create({
            data: {
                id: randomUUID(),
                groupId: jsonData.id,
                activityType: 'UPDATE_GROUP',
                time: importTime,
                data: `JSON_IMPORT_START:${mode}:${jsonData.expenses.length} expenses`,
            },
        })

        // Recreate participants
        const participantIds = new Set<string>()
        for (const participant of jsonData.participants) {
            await tx.participant.create({
                data: {
                    id: participant.id,
                    groupId: jsonData.id,
                    name: participant.name,
                },
            })
            participantIds.add(participant.id)
        }

        // Recreate expenses
        for (const expense of jsonData.expenses) {
            // Validate participant IDs
            if (!participantIds.has(expense.paidById)) {
                throw new Error(`Invalid paidById: ${expense.paidById} not found in participants for expense "${expense.title}"`)
            }
            for (const pf of expense.paidFor) {
                if (!participantIds.has(pf.participantId)) {
                    throw new Error(`Invalid participantId: ${pf.participantId} not found in participants for expense "${expense.title}"`)
                }
            }

            let categoryId: number | null = null

            if (expense.category) {
                let category = await tx.category.findFirst({
                    where: {
                        grouping: expense.category.grouping,
                        name: expense.category.name,
                    },
                })

                if (!category) {
                    category = await tx.category.create({
                        data: {
                            grouping: expense.category.grouping,
                            name: expense.category.name,
                        },
                    })
                }

                categoryId = category.id
            }

            const expenseId = randomUUID()
            await tx.expense.create({
                data: {
                    id: expenseId,
                    groupId: jsonData.id,
                    expenseDate: new Date(expense.expenseDate),
                    title: expense.title,
                    categoryId: categoryId ?? 0,
                    amount: expense.amount,
                    originalAmount: expense.originalAmount,
                    originalCurrency: expense.originalCurrency,
                    conversionRate: expense.conversionRate ? parseFloat(expense.conversionRate) : null,
                    paidById: expense.paidById,
                    isReimbursement: expense.isReimbursement,
                    splitMode: mapSplitMode(expense.splitMode),
                    recurrenceRule: mapRecurrenceRule(expense.recurrenceRule),
                    paidFor: {
                        create: expense.paidFor.map(pf => ({
                            participantId: pf.participantId,
                            shares: pf.shares,
                        })),
                    },
                },
            })

            // Create activity log for imported expense, embedding import date
            await tx.activity.create({
                data: {
                    id: randomUUID(),
                    groupId: jsonData.id,
                    activityType: 'CREATE_EXPENSE',
                    time: importTime,
                    expenseId: expenseId,
                    data: JSON.stringify({ title: expense.title, importDate: importTime.toISOString() }),
                },
            })
        }
    }
}
