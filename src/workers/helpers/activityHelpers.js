import { deriveStealthKeypair, deriveStealthPubFromPriv } from "../../lib/pivy-stealth/pivy-stealth.js"
import { prismaQuery } from "../../lib/prisma.js"

export const processPaymentTx = async ({
  txHash,
  users
}) => {
  const paymentTx = await prismaQuery.payment.findUnique({
    where: {
      txHash: txHash
    }
  })
  // Will determine which payment is it and save it to the activity table

  if (paymentTx.announce) {
    console.log("Detected announce payment")
  }

  let owner, link;

  for (const u of users) {
    const expect = await deriveStealthPubFromPriv(
      u.metaSpendPriv,
      u.metaViewPriv,
      paymentTx.ephemeralPubkey
    )

    if (expect === paymentTx.stealthOwnerPubkey) {
      owner = u;
      break;
    }
  }

  if (!owner) {
    console.log("Owner not found", {
      paymentTx: paymentTx,
    })
    // Mark as processed even if owner not found
    await prismaQuery.payment.update({
      where: {
        txHash: paymentTx.txHash
      },
      data: {
        isProcessed: true,
      }
    })
    return;
  }

  console.log("Found owner for payment: ", {
    paymentTx: paymentTx,
    owner: owner.id,
  })

  // Special handling for personal link
  if (paymentTx.label === 'personal') {
    link = await prismaQuery.link.findFirst({
      where: {
        userId: owner.id,
        tag: "", // Empty tag for personal link
        label: "personal"
      }
    })
  } else {
    // Normal link lookup
    link = await prismaQuery.link.findFirst({
      where: {
        userId: owner.id,
        tag: paymentTx.label
      }
    })
  }

  if (!link) {
    console.log("Link not found", {
      paymentTx: paymentTx,
      owner: owner.id,
    })
    // Mark as processed even if link not found
    await prismaQuery.payment.update({
      where: {
        txHash: paymentTx.txHash
      },
      data: {
        isProcessed: true,
      }
    })
    return;
  }

  // Build the activity data here
  const activityData = {
    txHash: paymentTx.txHash,
    link: link,
  }

  console.log("Activity data: ", activityData)

  await prismaQuery.payment.update({
    where: {
      txHash: paymentTx.txHash
    },
    data: {
      linkId: link.id,
      isProcessed: true,
    }
  })
}

export const processWithdrawalTx = async ({
  txHash
}) => {
  const withdrawalTx = await prismaQuery.withdrawal.findUnique({
    where: {
      txHash: txHash
    },
  })

  console.log("Processing withdrawal tx: ", withdrawalTx)
  // Will determine which withdrawal is it and save it to the activity table
}


export const processPaymentActivities = async () => {
  const unprocessedPayments = await prismaQuery.payment.findMany({
    where: {
      isProcessed: false
    },
    orderBy: {
      createdAt: "desc"
    },
    take: 20
  })

  const users = await prismaQuery.user.findMany({})

  for (const payment of unprocessedPayments) {
    await processPaymentTx({ txHash: payment.txHash, users: users })
  }
}

processPaymentActivities()
