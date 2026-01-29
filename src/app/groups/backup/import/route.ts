import { prisma } from '@/lib/prisma'
import {
    BackupData,
    calculateDifferences,
    compareVersions,
    restoreGroupFromBackup,
    VersionComparisonResult,
} from '@/lib/backup'
import { NextResponse } from 'next/server'
import JSZip from 'jszip'

export async function POST(req: Request) {
    try {
        const formData = await req.formData()
        const file = formData.get('file') as File
        const action = formData.get('action') as string // 'analyze' | 'restore' | 'rollback'

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 })
        }

        // Read the zip file
        const arrayBuffer = await file.arrayBuffer()
        const zip = new JSZip()
        const zipData = await zip.loadAsync(arrayBuffer)

        // Extract backup.json
        const backupFile = zipData.file('backup.json')
        if (!backupFile) {
            return NextResponse.json(
                { error: 'Invalid backup file: backup.json not found' },
                { status: 400 }
            )
        }

        const backupContent = await backupFile.async('string')
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const backupData: BackupData = JSON.parse(backupContent) as unknown as BackupData

        // Validate backup data
        if (!backupData.version || !backupData.group || !backupData.exportedAt) {
            return NextResponse.json(
                { error: 'Invalid backup file format' },
                { status: 400 }
            )
        }

        // Check if group exists
        const existingGroup = await prisma.group.findUnique({
            where: { id: backupData.group.id },
            include: {
                participants: { select: { id: true } },
                expenses: { select: { id: true, createdAt: true } },
                activities: { select: { time: true } },
            },
        })

        const comparison = compareVersions(backupData, existingGroup)

        // If action is 'analyze', just return the comparison
        if (action === 'analyze') {
            let differences
            if (existingGroup) {
                differences = calculateDifferences(backupData, existingGroup)
            }

            return NextResponse.json({
                success: true,
                comparison: {
                    result: comparison.result,
                    existingGroupUpdatedAt: comparison.existingGroupUpdatedAt?.toISOString(),
                    backupExportedAt: comparison.backupExportedAt.toISOString(),
                    differences,
                },
                groupName: backupData.group.name,
            })
        }

        // Handle restore/rollback actions
        if (action === 'restore' || action === 'rollback') {
            let mode: 'create' | 'update' | 'rollback'

            if (comparison.result === VersionComparisonResult.NOT_FOUND) {
                mode = 'create'
            } else if (action === 'rollback') {
                mode = 'rollback'
            } else if (comparison.result === VersionComparisonResult.NEWER) {
                mode = 'update'
            } else {
                return NextResponse.json(
                    { error: 'Backup is not newer than existing group. Use rollback to restore older version.' },
                    { status: 400 }
                )
            }

            // Execute restore in a transaction
            let warnings: string[] = []
            await prisma.$transaction(async (tx) => {
                const result = await restoreGroupFromBackup(tx, backupData, mode)
                warnings = result.warnings
            })

            return NextResponse.json({
                success: true,
                message: `Group ${mode === 'create' ? 'created' : mode === 'rollback' ? 'rolled back' : 'updated'} successfully`,
                groupId: backupData.group.id,
                mode,
                warnings: warnings.length > 0 ? warnings : undefined,
            })
        }

        return NextResponse.json(
            { error: 'Invalid action. Use "analyze", "restore", or "rollback"' },
            { status: 400 }
        )
    } catch (error) {
        console.error('Backup restore error:', error)
        return NextResponse.json(
            {
                error: 'Failed to process backup file',
                details: error instanceof Error ? error.message : 'Unknown error'
            },
            { status: 500 }
        )
    }
}
