import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { decryptEphemeralPrivKey, deriveStealthPub } from "../../../lib/pivy-stealth/pivy-stealth-sui.js";
import { prismaQuery } from "../../../lib/prisma.js";
import bs58 from 'bs58';

export const processSuiPaymentTx = async ({
  txHash
}) => {
  try {
    const paymentTx = await prismaQuery.payment.findUnique({
      where: {
        txHash: txHash
      }
    })

    if (paymentTx.announce) {
      console.log("Detected announce payment")
    }

    const users = await prismaQuery.user.findMany({
      where: {
        walletChain: 'SUI'
      }
    })

    let owner, link;

    for (const u of users) {
      const decryptedEphPriv = await decryptEphemeralPrivKey(
        paymentTx.memo,
        u.metaViewPriv,
        paymentTx.ephemeralPubkey
      )

      const stealthPubB58 = await deriveStealthPub(
        u.metaSpendPub,
        u.metaViewPub,
        decryptedEphPriv,
        u.metaSpendPriv
      )

      if (stealthPubB58.stealthSuiAddress === paymentTx.stealthOwnerPubkey) {
        owner = u;
        break;
      }
    }

    if (!owner) {
      console.log('Owner not found', {
        txHash: paymentTx.txHash,
      })
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

    console.log('Found owner for payment: ', {
      txHash: paymentTx.txHash,
      owner: owner.id,
      label: paymentTx.label,
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

    console.log('Found link: ', {
      txHash: paymentTx.txHash,
      owner: owner.id,
      link: link.id,
    })

    // Build the activity data here
    const activityData = {
      txHash: paymentTx.txHash,
      link: link,
    }

    await prismaQuery.payment.update({
      where: {
        txHash: paymentTx.txHash
      },
      data: {
        linkId: link.id,
        isProcessed: true,
      }
    })
  } catch (error) {
    console.log('Error processing payment tx: ', error)
    await prismaQuery.payment.update({
      where: {
        txHash: txHash
      },
      data: {
        isProcessed: true,
      }
    })
  }
}