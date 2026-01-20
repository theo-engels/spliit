import { deleteGroupWithDocuments, getGroupDocumentCount } from '@/lib/api'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const deleteGroupProcedure = baseProcedure
    .input(
        z.object({
            groupId: z.string().min(1),
            deleteDocuments: z.boolean().optional(),
        }),
    )
    .mutation(async ({ input: { groupId, deleteDocuments } }) => {
        await deleteGroupWithDocuments(groupId, deleteDocuments ?? false)
    })
