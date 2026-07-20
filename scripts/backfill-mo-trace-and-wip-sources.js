const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
})

const { prisma, disconnectDatabase } = require('../src/prisma')

function splitMetadataAndBody(rawNotes = '', marker) {
  const notes = String(rawNotes || '')
  if (!notes.startsWith(marker))
    return null

  const metadata = {}
  const lines = notes.split('\n')
  let bodyStarted = false
  const bodyLines = []

  for (const line of lines.slice(1)) {
    if (!bodyStarted && line.includes('=')) {
      const separatorIndex = line.indexOf('=')
      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1).trim()
      metadata[key] = value
      continue
    }

    bodyStarted = true
    if (line.trim() || bodyLines.length > 0)
      bodyLines.push(line)
  }

  return {
    metadata,
    body: bodyLines.join('\n').trim(),
  }
}

function extractReworkSourceLabel(cleanedNotes = '') {
  const marker = 'Rework child MO dari '
  const startIndex = cleanedNotes.indexOf(marker)
  if (startIndex < 0)
    return null

  const afterMarker = cleanedNotes.slice(startIndex + marker.length)
  const viaIndex = afterMarker.indexOf(' via Stock Rework')
  if (viaIndex >= 0)
    return afterMarker.slice(0, viaIndex).trim() || null

  return afterMarker.trim() || null
}

function parseLegacyWipAllocations(notes = '') {
  const match = String(notes || '').match(/sourceWipAllocationsJson=(.+)$/m)
  if (!match?.[1])
    return []

  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

function parseLegacyTrace(notes = '') {
  const raw = String(notes || '')
  const wipDerived = splitMetadataAndBody(raw, '[WIP_DERIVED]')
  if (wipDerived) {
    const cleanedBody = wipDerived.body.replace(/\n*\[WIP_MULTI_SOURCE\][\s\S]*$/m, '').trim()
    const metadata = wipDerived.metadata
    const sourceReworkReferenceLabel
      = metadata.sourceReworkReferenceLabel || extractReworkSourceLabel(cleanedBody) || null
    const sourceReworkTraceType
      = metadata.sourceReworkTraceType || (sourceReworkReferenceLabel ? 'STOCK_REWORK' : null)

    return {
      parentMoNumber: metadata.sourceMoNumber || null,
      rootMoNumber: metadata.sourceRootMoNumber || metadata.sourceMoNumber || null,
      sourceReferenceType: metadata.sourceReferenceType || null,
      sourcePlannedOrderNumber: metadata.sourcePlannedOrderNumber || null,
      sourceMonthlyProductionPlanNumber: metadata.sourceMonthlyProductionPlanNumber || null,
      sourceMonthlyProductionPlanLineNumber: metadata.sourceMonthlyProductionPlanLineNumber
        ? Number(metadata.sourceMonthlyProductionPlanLineNumber)
        : null,
      sourceStartSequence: metadata.sourceStartSequence ? Number(metadata.sourceStartSequence) : null,
      sourceStartProcessLabel: metadata.sourceStartProcessLabel || null,
      sourceReworkTraceType,
      sourceReworkReferenceType: metadata.sourceReworkReferenceType || null,
      sourceReworkReferenceNumber: metadata.sourceReworkReferenceNumber || null,
      sourceReworkReferenceLabel,
      isReworkChild: Boolean(sourceReworkTraceType),
      cleanedNotes: cleanedBody || null,
      allocations: parseLegacyWipAllocations(raw),
    }
  }

  const moTrace = splitMetadataAndBody(raw, '[MO_TRACE]')
  if (moTrace) {
    const metadata = moTrace.metadata
    return {
      parentMoNumber: metadata.parentMoNumber || metadata.sourceMoNumber || null,
      rootMoNumber:
        metadata.rootMoNumber
        || metadata.sourceRootMoNumber
        || metadata.parentMoNumber
        || metadata.sourceMoNumber
        || null,
      sourceReferenceType: metadata.sourceReferenceType || null,
      sourcePlannedOrderNumber: metadata.sourcePlannedOrderNumber || null,
      sourceMonthlyProductionPlanNumber: metadata.sourceMonthlyProductionPlanNumber || null,
      sourceMonthlyProductionPlanLineNumber: metadata.sourceMonthlyProductionPlanLineNumber
        ? Number(metadata.sourceMonthlyProductionPlanLineNumber)
        : null,
      sourceStartSequence: null,
      sourceStartProcessLabel: null,
      sourceReworkTraceType: null,
      sourceReworkReferenceType: null,
      sourceReworkReferenceNumber: null,
      sourceReworkReferenceLabel: null,
      isReworkChild: false,
      cleanedNotes: moTrace.body || null,
      allocations: parseLegacyWipAllocations(raw),
    }
  }

  const cleanedNotes = raw.replace(/\n*\[WIP_MULTI_SOURCE\][\s\S]*$/m, '').trim()
  return {
    parentMoNumber: null,
    rootMoNumber: null,
    sourceReferenceType: null,
    sourcePlannedOrderNumber: null,
    sourceMonthlyProductionPlanNumber: null,
    sourceMonthlyProductionPlanLineNumber: null,
    sourceStartSequence: null,
    sourceStartProcessLabel: null,
    sourceReworkTraceType: null,
    sourceReworkReferenceType: null,
    sourceReworkReferenceNumber: null,
    sourceReworkReferenceLabel: null,
    isReworkChild: false,
    cleanedNotes: cleanedNotes || null,
    allocations: parseLegacyWipAllocations(raw),
  }
}

function normalizeAllocationsFromMo(mo, allocations = []) {
  if (Array.isArray(allocations) && allocations.length > 0) {
    return allocations.map((allocation, index) => ({
      lineNumber: index + 1,
      stockBalanceId: allocation.stockBalanceId || null,
      qty: Number(allocation.qty || 0),
      warehouseCode: allocation.warehouseCode || null,
      rackCode: allocation.rackCode || null,
      lotNumber: allocation.lotNumber || null,
      partCode: allocation.partCode || null,
      partNumber: allocation.partNumber || null,
      partName: allocation.partName || null,
      stockType: allocation.stockType || 'WIP',
    })).filter(allocation => allocation.qty > 0)
  }

  if (mo.inputSourceType === 'WIP_STOCK' && mo.sourceStockBalanceId) {
    return [{
      lineNumber: 1,
      stockBalanceId: mo.sourceStockBalanceId,
      qty: Number(mo.sourceQtyPlanned || mo.qtyPlanned || 0),
      warehouseCode: mo.sourceWarehouseCode || null,
      rackCode: mo.sourceRackCode || null,
      lotNumber: mo.sourceLotNumber || null,
      partCode: mo.sourcePartCode || null,
      partNumber: mo.sourcePartNumber || null,
      partName: mo.sourcePartName || null,
      stockType: mo.sourceStockType || 'WIP',
    }].filter(allocation => allocation.qty > 0)
  }

  return []
}

async function main() {
  const mos = await prisma.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      OR: [
        { notes: { contains: '[WIP_DERIVED]' } },
        { notes: { contains: '[MO_TRACE]' } },
        { notes: { contains: '[WIP_MULTI_SOURCE]' } },
      ],
    },
    select: {
      id: true,
      moNumber: true,
      notes: true,
      inputSourceType: true,
      sourceStockBalanceId: true,
      sourceWarehouseCode: true,
      sourceRackCode: true,
      sourceLotNumber: true,
      sourcePartCode: true,
      sourcePartNumber: true,
      sourcePartName: true,
      sourceStockType: true,
      sourceQtyPlanned: true,
      qtyPlanned: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  let updatedCount = 0
  let allocationCount = 0

  for (const mo of mos) {
    const legacy = parseLegacyTrace(mo.notes)
    const allocations = normalizeAllocationsFromMo(mo, legacy.allocations)

    await prisma.$transaction(async (tx) => {
      await tx.manufacturingOrder.update({
        where: { id: mo.id },
        data: {
          parentMoNumber: legacy.parentMoNumber || null,
          rootMoNumber: legacy.rootMoNumber || legacy.parentMoNumber || null,
          sourceReferenceType: legacy.sourceReferenceType || null,
          sourcePlannedOrderNumber: legacy.sourcePlannedOrderNumber || null,
          sourceMonthlyProductionPlanNumber: legacy.sourceMonthlyProductionPlanNumber || null,
          sourceMonthlyProductionPlanLineNumber: legacy.sourceMonthlyProductionPlanLineNumber || null,
          sourceStartSequence: legacy.sourceStartSequence || null,
          sourceStartProcessLabel: legacy.sourceStartProcessLabel || null,
          sourceReworkTraceType: legacy.sourceReworkTraceType || null,
          sourceReworkReferenceType: legacy.sourceReworkReferenceType || null,
          sourceReworkReferenceNumber: legacy.sourceReworkReferenceNumber || null,
          sourceReworkReferenceLabel: legacy.sourceReworkReferenceLabel || null,
          isReworkChild: Boolean(legacy.isReworkChild),
          notes: legacy.cleanedNotes || null,
        },
      })

      await tx.manufacturingOrderSourceWip.updateMany({
        where: {
          manufacturingOrderId: mo.id,
          isDeleted: false,
        },
        data: {
          isDeleted: true,
        },
      })

      if (allocations.length > 0) {
        await tx.manufacturingOrderSourceWip.createMany({
          data: allocations.map(allocation => ({
            id: crypto.randomUUID(),
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            ...allocation,
          })),
        })
      }
    })

    updatedCount += 1
    allocationCount += allocations.length
    console.log(`Backfilled ${mo.moNumber} | allocations: ${allocations.length}`)
  }

  console.log(`Done. Updated ${updatedCount} MO(s), wrote ${allocationCount} source WIP allocation row(s).`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
