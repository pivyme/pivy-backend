import { deriveStealthKeypair, deriveStealthPubFromPriv } from "../../lib/pivy-stealth/pivy-stealth.js"
import { prismaQuery } from "../../lib/prisma.js"
import cron from "node-cron"
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
  // Get all withdrawals for this transaction
  const withdrawalTxs = await prismaQuery.withdrawal.findMany({
    where: {
      txHash: txHash
    },
    include: {
      mint: {
        select: {
          symbol: true,
          decimals: true
        }
      }
    }
  });

  console.log("Processing withdrawal txs: ", withdrawalTxs);

  for (const withdrawalTx of withdrawalTxs) {
    // Find the payment that has this stealth owner pubkey
    const payment = await prismaQuery.payment.findFirst({
      where: {
        stealthOwnerPubkey: withdrawalTx.stealthOwnerPubkey
      },
      include: {
        link: {
          select: {
            userId: true
          }
        }
      }
    });

    if (!payment || !payment.link) {
      console.log("No payment or link found for stealth address", {
        withdrawalTx: withdrawalTx,
      });
      // Mark as processed if we can't find the owner
      await prismaQuery.withdrawal.update({
        where: {
          txHash_stealthOwnerPubkey: {
            txHash: withdrawalTx.txHash,
            stealthOwnerPubkey: withdrawalTx.stealthOwnerPubkey
          }
        },
        data: {
          isProcessed: true,
        }
      });
      continue;
    }

    const userId = payment.link.userId;
    console.log("Found owner for withdrawal: ", {
      withdrawalTx: withdrawalTx,
      userId: userId,
    });

    // Build the activity data here
    const activityData = {
      txHash: withdrawalTx.txHash,
      userId: userId,
      amount: withdrawalTx.amount,
      token: {
        symbol: withdrawalTx.mint.symbol,
        decimals: withdrawalTx.mint.decimals
      },
      destinationPubkey: withdrawalTx.destinationPubkey,
      timestamp: withdrawalTx.timestamp
    };

    console.log("Activity data: ", activityData);

    // Mark this withdrawal as processed and associate with user
    await prismaQuery.withdrawal.update({
      where: {
        txHash_stealthOwnerPubkey: {
          txHash: withdrawalTx.txHash,
          stealthOwnerPubkey: withdrawalTx.stealthOwnerPubkey
        }
      },
      data: {
        userId: userId,
        isProcessed: true,
      }
    });
  }
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
// processPaymentActivities()

export const processWithdrawalActivities = async () => {
  const unprocessedWithdrawals = await prismaQuery.withdrawal.findMany({
    where: {
      isProcessed: false
    },
    orderBy: {
      createdAt: "desc"
    },
    take: 50
  })

  for (const withdrawal of unprocessedWithdrawals) {
    await processWithdrawalTx({ txHash: withdrawal.txHash })
  }
}
// processWithdrawalActivities()

// For backups if there is any missing payments or withdrawals, run processPaymentActivities() and processWithdrawalActivities() every 30 seconds
cron.schedule('*/30 * * * * *', () => {
  processPaymentActivities()
  processWithdrawalActivities()
})
// processPaymentActivities()
// processWithdrawalActivities()