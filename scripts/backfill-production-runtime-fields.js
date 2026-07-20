const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
})

const { prisma, disconnectDatabase } = require('../src/prisma')

function extractPartCodeFromOperationNotes(notes = '') {
  const match = String(notes || '').match(/\bfor\s+(.+?)\s+x\s+[\d.]+/i)
  return match?.[1]?.trim() || null
}

function parseReworkNote(notes = '') {
  const text = String(notes || '').trim()
  if (!/^Rework dari /i.test(text))
    return null

  const afterPrefix = text.slice('Rework dari '.length)
  const qtyIndex = afterPrefix.indexOf(' (qty:')
  const viaIndex = afterPrefix.indexOf(' via Stock Rework')
  const endIndex = [viaIndex, qtyIndex].filter(index => index >= 0).sort((left, right) => left - right)[0] ?? afterPrefix.length
  const sourceLabel = afterPrefix.slice(0, endIndex).trim() || null

  let reworkReferenceType = null
  let reworkSourceType = null
  if (/^QI\s+/i.test(sourceLabel))
    reworkReferenceType = reworkSourceType = 'QUALITY_INSPECTION'
  else if (/^Production Log\s+/i.test(sourceLabel) || /^LOG-/i.test(sourceLabel))
    reworkReferenceType = reworkSourceType = 'PRODUCTION_LOG'
  else if (/Stock Rework/i.test(text))
    reworkSourceType = 'STOCK_REWORK'

  const reworkReferenceNumber = sourceLabel
    ? sourceLabel.replace(/^Production Log\s+/i, '').trim()
    : null

  return {
    isReworkOrder: true,
    reworkSourceType,
    reworkReferenceType,
    reworkReferenceNumber,
    reworkReferenceLabel: sourceLabel,
  }
}

function stripAutoNarrativeLines(notes = '') {
  const lines = String(notes || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (lines.length === 0)
    return null

  const keptLines = lines.filter((line) => {
    if (/^Rework dari /i.test(line))
      return false
    if (/^Rework child MO dari /i.test(line))
      return false
    if (/^Created from WIP of /i.test(line))
      return false
    return true
  })

  return keptLines.length > 0 ? keptLines.join('\n') : null
}

function extractVendorOrderNumberFromMovementNotes(notes = '') {
  const match = String(notes || '').match(/\bVPO-\d{8}-\d{3}\b/i)
  return match?.[0] || null
}

function extractPartCodeFromWipNotes(notes = '') {
  const text = String(notes || '')
  return (
    text.match(/Consume WIP\s+(.+?)\s+dari/i)?.[1]?.trim()
    || text.match(/Material\s+(.+?)\s+issued/i)?.[1]?.trim()
    || text.match(/Production NG\s+(.+?)\s+dari/i)?.[1]?.trim()
    || null
  )
}

async function backfillWorkOrders() {
  const workOrders = await prisma.workOrder.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      mbomDetailId: true,
      notes: true,
      outputPartId: true,
      outputPartCode: true,
      outputPartNumber: true,
      outputPartName: true,
      isReworkOrder: true,
      reworkSourceType: true,
      reworkReferenceType: true,
      reworkReferenceNumber: true,
      reworkReferenceLabel: true,
      mbomDetail: {
        select: {
          part: {
            select: {
              id: true,
              partCode: true,
              partNumber: true,
              partName: true,
            },
          },
        },
      },
    },
  })

  let updatedCount = 0
  for (const row of workOrders) {
    const outputPart = row.mbomDetail?.part || null
    const fallbackPartCode = extractPartCodeFromOperationNotes(row.notes)
    const parsedRework = parseReworkNote(row.notes)
    const data = {}

    if (!row.outputPartCode && (outputPart?.partCode || fallbackPartCode)) {
      data.outputPartId = outputPart?.id || null
      data.outputPartCode = outputPart?.partCode || fallbackPartCode
      data.outputPartNumber = outputPart?.partNumber || null
      data.outputPartName = outputPart?.partName || null
    }

    if (!row.isReworkOrder && parsedRework) {
      Object.assign(data, parsedRework)
    }

    const cleanedNotes = stripAutoNarrativeLines(row.notes)
    if ((parsedRework || /^Created from WIP of /i.test(String(row.notes || '').trim())) && cleanedNotes !== row.notes) {
      data.notes = cleanedNotes
    }

    if (Object.keys(data).length > 0) {
      await prisma.workOrder.update({ where: { id: row.id }, data })
      updatedCount += 1
    }
  }

  return updatedCount
}

async function backfillVendorProcessOrders() {
  const rows = await prisma.vendorProcessOrder.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      notes: true,
      isReworkOrder: true,
      reworkSourceType: true,
      reworkReferenceType: true,
      reworkReferenceNumber: true,
      reworkReferenceLabel: true,
    },
  })

  let updatedCount = 0
  for (const row of rows) {
    const parsedRework = parseReworkNote(row.notes)
    const cleanedNotes = stripAutoNarrativeLines(row.notes)
    if (!row.isReworkOrder && parsedRework) {
      await prisma.vendorProcessOrder.update({
        where: { id: row.id },
        data: {
          ...parsedRework,
          ...(cleanedNotes !== row.notes ? { notes: cleanedNotes } : {}),
        },
      })
      updatedCount += 1
    }
    else if (cleanedNotes !== row.notes) {
      await prisma.vendorProcessOrder.update({
        where: { id: row.id },
        data: { notes: cleanedNotes },
      })
      updatedCount += 1
    }
  }

  return updatedCount
}

async function backfillWipEntries() {
  const entries = await prisma.wIPEntry.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      sourceRef: true,
      notes: true,
      woId: true,
      partCode: true,
      partNumber: true,
      partName: true,
      uomCode: true,
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      stockType: true,
      workOrder: {
        select: {
          outputPartCode: true,
          outputPartNumber: true,
          outputPartName: true,
          uomCode: true,
        },
      },
    },
  })

  const movementByLogNumber = new Map()
  const logRefs = [...new Set(entries.filter(entry => entry.sourceType === 'ProductionInput' && entry.sourceRef).map(entry => entry.sourceRef))]
  if (logRefs.length > 0) {
    const movements = await prisma.stockMovement.findMany({
      where: {
        referenceType: 'PRODUCTION_LOG',
        referenceNumber: { in: logRefs },
        transactionType: 'PRODUCTION',
        movementType: 'OUT',
        isDeleted: false,
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        referenceNumber: true,
        partCode: true,
        partNumber: true,
        partName: true,
        uomCode: true,
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        stockType: true,
      },
    })
    for (const movement of movements) {
      if (!movementByLogNumber.has(movement.referenceNumber))
        movementByLogNumber.set(movement.referenceNumber, movement)
    }
  }

  let updatedCount = 0
  for (const entry of entries) {
    const data = {}
    const identity = {}

    if (entry.workOrder?.outputPartCode) {
      identity.partCode = entry.workOrder.outputPartCode
      identity.partNumber = entry.workOrder.outputPartNumber || null
      identity.partName = entry.workOrder.outputPartName || null
      identity.uomCode = entry.workOrder.uomCode || null
      identity.stockType = 'WIP'
    }

    if (entry.sourceType === 'ProductionInput' && entry.sourceRef && movementByLogNumber.has(entry.sourceRef)) {
      Object.assign(identity, movementByLogNumber.get(entry.sourceRef))
    }

    if (!identity.partCode) {
      const parsedPartCode = extractPartCodeFromWipNotes(entry.notes)
      if (parsedPartCode)
        identity.partCode = parsedPartCode
    }

    for (const field of ['partCode', 'partNumber', 'partName', 'uomCode', 'warehouseCode', 'rackCode', 'lotNumber', 'stockType']) {
      if (!entry[field] && identity[field] != null)
        data[field] = identity[field]
    }

    if (Object.keys(data).length > 0) {
      await prisma.wIPEntry.update({ where: { id: entry.id }, data })
      updatedCount += 1
    }
  }

  return updatedCount
}

async function backfillManufacturingOrders() {
  const rows = await prisma.manufacturingOrder.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      notes: true,
      inputSourceType: true,
      parentMoNumber: true,
      rootMoNumber: true,
      sourceStartSequence: true,
      sourceReworkTraceType: true,
    },
  })

  let updatedCount = 0
  for (const row of rows) {
    const cleanedNotes = stripAutoNarrativeLines(row.notes)
    if (cleanedNotes === row.notes)
      continue

    if (
      row.inputSourceType === 'WIP_STOCK'
      || row.parentMoNumber
      || row.rootMoNumber
      || row.sourceStartSequence
      || row.sourceReworkTraceType
    ) {
      await prisma.manufacturingOrder.update({
        where: { id: row.id },
        data: { notes: cleanedNotes },
      })
      updatedCount += 1
    }
  }

  return updatedCount
}

async function backfillStockMovements() {
  const movements = await prisma.stockMovement.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      transactionType: true,
      stockType: true,
      rackCode: true,
      notes: true,
      referenceType: true,
      referenceNumber: true,
      qualityBucket: true,
    },
  })

  let updatedCount = 0
  for (const movement of movements) {
    const data = {}

    if (movement.transactionType === 'VENDOR_SEND' && movement.referenceType !== 'VENDOR_PROCESS_ORDER') {
      const orderNumber = extractVendorOrderNumberFromMovementNotes(movement.notes)
      if (orderNumber) {
        data.referenceType = 'VENDOR_PROCESS_ORDER'
        data.referenceNumber = orderNumber
      }
    }

    if (!movement.qualityBucket) {
      const notes = String(movement.notes || '').toLowerCase()
      if (movement.transactionType === 'QC_HOLD') {
        if (movement.rackCode === 'RACK-REJECT' || notes.includes('rack reject'))
          data.qualityBucket = 'NG'
        else
          data.qualityBucket = 'GOOD'
      }
      else if (movement.transactionType === 'QUALITY_RELEASE' || movement.transactionType === 'PRODUCTION')
        data.qualityBucket = 'GOOD'
      else if (['REJECT', 'SCRAP', 'REWORK'].includes(movement.transactionType))
        data.qualityBucket = 'NG'
    }

    if (Object.keys(data).length > 0) {
      await prisma.stockMovement.update({ where: { id: movement.id }, data })
      updatedCount += 1
    }
  }

  return updatedCount
}

async function main() {
  const manufacturingOrders = await backfillManufacturingOrders()
  const workOrders = await backfillWorkOrders()
  const vendorProcessOrders = await backfillVendorProcessOrders()
  const wipEntries = await backfillWipEntries()
  const stockMovements = await backfillStockMovements()

  console.log('Backfill production runtime fields complete:')
  console.log(`- Manufacturing Orders: ${manufacturingOrders}`)
  console.log(`- Work Orders: ${workOrders}`)
  console.log(`- Vendor Process Orders: ${vendorProcessOrders}`)
  console.log(`- WIP Entries: ${wipEntries}`)
  console.log(`- Stock Movements: ${stockMovements}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDatabase()
  })
