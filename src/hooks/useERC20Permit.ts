import JSBI from 'jsbi'
import { ChainId, CurrencyAmount, Percent, TokenAmount } from '@uniswap/sdk-core'
import { Trade as V2Trade } from '@uniswap/v2-sdk'
import { Trade as V3Trade } from '@uniswap/v3-sdk'
import { splitSignature } from 'ethers/lib/utils'
import { useMemo, useState } from 'react'
import { UNI, USDC, DAI } from '../constants'
import { SWAP_ROUTER_ADDRESSES } from '../constants/v3'
import { useSingleCallResult } from '../state/multicall/hooks'
import { useActiveWeb3React } from './index'
import { useEIP2612Contract } from './useContract'
import useIsArgentWallet from './useIsArgentWallet'
import useTransactionDeadline from './useTransactionDeadline'

enum PermitType {
  AMOUNT = 1,
  ALLOWED = 2,
}

// 20 minutes to submit after signing
const PERMIT_VALIDITY_BUFFER = 20 * 60

interface PermitInfo {
  type: PermitType
  name: string
  // version is optional, and if omitted, will not be included in the domain
  version?: string
}

// todo: read this information from extensions on token lists
const PERMITTABLE_TOKENS: {
  [chainId in ChainId]: {
    [checksummedTokenAddress: string]: PermitInfo
  }
} = {
  [ChainId.MAINNET]: {
    [USDC.address]: { type: PermitType.AMOUNT, name: 'USD Coin', version: '1' },
    [DAI.address]: { type: PermitType.ALLOWED, name: 'Dai Stablecoin', version: '1' },
    [UNI[ChainId.MAINNET].address]: { type: PermitType.AMOUNT, name: 'Uniswap' },
  },
  [ChainId.RINKEBY]: {
    [UNI[ChainId.RINKEBY].address]: { type: PermitType.AMOUNT, name: 'Uniswap' },
  },
  [ChainId.ROPSTEN]: {
    [UNI[ChainId.ROPSTEN].address]: { type: PermitType.AMOUNT, name: 'Uniswap' },
  },
  [ChainId.GÖRLI]: {
    [UNI[ChainId.GÖRLI].address]: { type: PermitType.AMOUNT, name: 'Uniswap' },
  },
  [ChainId.KOVAN]: {
    [UNI[ChainId.KOVAN].address]: { type: PermitType.AMOUNT, name: 'Uniswap' },
  },
}

export enum UseERC20PermitState {
  // returned for any reason, e.g. it is an argent wallet, or the currency does not support it
  NOT_APPLICABLE,
  LOADING,
  NOT_SIGNED,
  SIGNED,
}

export interface SignatureData {
  v: number
  r: string
  s: string
  deadline: number
  nonce: number
  amount: string
  owner: string
  spender: string
  chainId: ChainId | number
  tokenAddress: string
}

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

const EIP712_DOMAIN_TYPE_NO_VERSION = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

const EIP2612_TYPE = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
]

export function useERC20Permit(
  currencyAmount: CurrencyAmount | null | undefined,
  spender: string | null | undefined,
  overridePermitInfo: PermitInfo | undefined | null
): {
  signatureData: SignatureData | null
  state: UseERC20PermitState
  gatherPermitSignature: null | (() => Promise<void>)
} {
  const { account, chainId, library } = useActiveWeb3React()
  const transactionDeadline = useTransactionDeadline()
  const tokenAddress = currencyAmount instanceof TokenAmount ? currencyAmount.token.address : undefined
  const eip2612Contract = useEIP2612Contract(tokenAddress)
  const isArgentWallet = useIsArgentWallet()
  const nonceInputs = useMemo(() => [account ?? undefined], [account])
  const tokenNonceState = useSingleCallResult(eip2612Contract, 'nonces', nonceInputs)
  const permitInfo =
    overridePermitInfo ?? (chainId && tokenAddress ? PERMITTABLE_TOKENS[chainId][tokenAddress] : undefined)

  const [signatureData, setSignatureData] = useState<SignatureData | null>(null)

  return useMemo(() => {
    if (
      isArgentWallet ||
      !currencyAmount ||
      !eip2612Contract ||
      !account ||
      !chainId ||
      !transactionDeadline ||
      !library ||
      !tokenNonceState.valid ||
      !tokenAddress ||
      !spender ||
      !permitInfo ||
      // todo: support allowed permit
      permitInfo.type !== PermitType.AMOUNT
    ) {
      return {
        state: UseERC20PermitState.NOT_APPLICABLE,
        signatureData: null,
        gatherPermitSignature: null,
      }
    }

    const nonceNumber = tokenNonceState.result?.[0]?.toNumber()
    if (tokenNonceState.loading || typeof nonceNumber !== 'number') {
      return {
        state: UseERC20PermitState.LOADING,
        signatureData: null,
        gatherPermitSignature: null,
      }
    }

    const isSignatureDataValid =
      signatureData &&
      signatureData.owner === account &&
      signatureData.deadline >= transactionDeadline.toNumber() &&
      signatureData.tokenAddress === tokenAddress &&
      signatureData.spender === spender &&
      JSBI.equal(JSBI.BigInt(signatureData.amount), currencyAmount.raw)

    return {
      state: isSignatureDataValid ? UseERC20PermitState.SIGNED : UseERC20PermitState.NOT_SIGNED,
      signatureData: isSignatureDataValid ? signatureData : null,
      gatherPermitSignature: async function gatherPermitSignature() {
        const signatureDeadline = transactionDeadline.toNumber() + PERMIT_VALIDITY_BUFFER

        const value = currencyAmount.raw.toString()

        const message = {
          owner: account,
          spender,
          value,
          nonce: nonceNumber,
          deadline: signatureDeadline,
        }
        const domain = permitInfo.version
          ? {
              name: permitInfo.name,
              version: permitInfo.version,
              verifyingContract: tokenAddress,
              chainId,
            }
          : {
              name: permitInfo.name,
              verifyingContract: tokenAddress,
              chainId,
            }
        const data = JSON.stringify({
          types: {
            EIP712Domain: permitInfo.version ? EIP712_DOMAIN_TYPE : EIP712_DOMAIN_TYPE_NO_VERSION,
            Permit: EIP2612_TYPE,
          },
          domain,
          primaryType: 'Permit',
          message,
        })

        library
          .send('eth_signTypedData_v4', [account, data])
          .then(splitSignature)
          .then((signature) => {
            setSignatureData({
              v: signature.v,
              r: signature.r,
              s: signature.s,
              deadline: signatureDeadline,
              amount: value,
              nonce: nonceNumber,
              chainId,
              owner: account,
              spender,
              tokenAddress,
            })
          })
      },
    }
  }, [
    currencyAmount,
    eip2612Contract,
    account,
    chainId,
    isArgentWallet,
    transactionDeadline,
    library,
    tokenNonceState.loading,
    tokenNonceState.valid,
    tokenNonceState.result,
    tokenAddress,
    spender,
    permitInfo,
    signatureData,
  ])
}

const REMOVE_V2_LIQUIDITY_PERMIT_INFO: PermitInfo = {
  version: '1',
  name: 'Uniswap V2',
  type: PermitType.AMOUNT,
}

export function useV2LiquidityTokenPermit(
  liquidityAmount: TokenAmount | null | undefined,
  spender: string | null | undefined
) {
  return useERC20Permit(liquidityAmount, spender, REMOVE_V2_LIQUIDITY_PERMIT_INFO)
}

export function useERC20PermitFromTrade(trade: V2Trade | V3Trade | undefined, allowedSlippage: number) {
  const { chainId } = useActiveWeb3React()
  const swapRouterAddress = SWAP_ROUTER_ADDRESSES[chainId as ChainId]
  const amountToApprove = useMemo(
    () => (trade ? trade.maximumAmountIn(new Percent(allowedSlippage, 10_000)) : undefined),
    [trade, allowedSlippage]
  )

  return useERC20Permit(
    amountToApprove,
    // v2 router does not support
    trade instanceof V2Trade ? undefined : trade instanceof V3Trade ? swapRouterAddress : undefined,
    null
  )
}