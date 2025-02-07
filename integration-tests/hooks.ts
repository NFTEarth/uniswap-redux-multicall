import { act } from '@testing-library/react'
import { abi as MulticallABI } from '@uniswap/v3-periphery/artifacts/contracts/lens/UniswapInterfaceMulticall.sol/UniswapInterfaceMulticall.json'
import { BigNumber } from '@ethersproject/bignumber'
import { Contract } from '@ethersproject/contracts'
import { InfuraProvider, JsonRpcProvider } from '@ethersproject/providers'
import { Interface } from '@ethersproject/abi'
import { config } from 'dotenv'
import { useEffect, useMemo, useState } from 'react'

import { UniswapInterfaceMulticall } from '../src/abi/types'
import { ChainId, DAI_ADDRESS, MULTICALL_ADDRESS, NULL_ADDRESS, USDC_ADDRESS, USDT_ADDRESS } from './consts'
import ERC20_ABI from './erc20.json'
import { useMultiChainSingleContractSingleData, useMultipleContractSingleData, useSingleCallResult } from '../src/hooks'

config()
if (!process.env.INFURA_PROJECT_ID) throw new Error('Tests require process.env.INFURA_PROJECT_ID')
const projectId = process.env.INFURA_PROJECT_ID
const projectSecret = process.env.INFURA_PROJECT_SECRET
const project = projectSecret ? { projectId, projectSecret } : projectId

const providerCache: Partial<Record<ChainId, JsonRpcProvider>> = {}
const MulticallInterface = new Interface(MulticallABI)
const ERC20Interface = new Interface(ERC20_ABI)

export function useContract(chainId: ChainId) {
  return useMemo(() => {
    return new Contract(MULTICALL_ADDRESS, MulticallABI, getProvider(chainId)) as UniswapInterfaceMulticall
  }, [chainId])
}

export function useLatestBlock(provider: JsonRpcProvider) {
  const [blockNumber, setBlockNumber] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!provider) return
    const onBlock = (num: number) => act(() => setBlockNumber(num))
    provider.on('block', onBlock)
    return () => {
      provider.off('block', onBlock)
    }
  }, [provider, setBlockNumber])
  return blockNumber
}

export function useCurrentBlockTimestamp(chainId: ChainId, blockNumber: number | undefined): string | undefined {
  const contract = useContract(chainId)
  const callState = useSingleCallResult(chainId, blockNumber, contract, 'getCurrentBlockTimestamp')
  return callState.result?.[0]?.toString()
}

export function useCurrentBlockTimestampMultichain(
  chainIds: ChainId[],
  blockNumbers: Array<number | undefined>
): Array<string | undefined> {
  const chainToBlock = useMemo(() => {
    return chainIds.reduce((result, chainId, i) => {
      result[chainId] = blockNumbers[i]
      return result
    }, {} as Record<number, number | undefined>)
  }, [chainIds, blockNumbers])

  const chainToAddress = useMemo(() => {
    return chainIds.reduce((result, chainId) => {
      result[chainId] = MULTICALL_ADDRESS
      return result
    }, {} as Record<number, string>)
  }, [chainIds])

  const chainToCallState = useMultiChainSingleContractSingleData(
    chainToBlock,
    chainToAddress,
    MulticallInterface,
    'getCurrentBlockTimestamp'
  )

  return Object.values(chainToCallState).map((callState) => callState.result?.[0]?.toString())
}

export function useMaxTokenBalance(chainId: ChainId, blockNumber: number | undefined): string | undefined {
  const { contracts, accounts } = useMemo(
    () => ({
      // The first element is intentionally empty to test sparse arrays; see https://github.com/Uniswap/redux-multicall/pull/21.
      // eslint-disable-next-line no-sparse-arrays
      contracts: [, USDC_ADDRESS, USDT_ADDRESS, DAI_ADDRESS],
      accounts: [NULL_ADDRESS],
    }),
    []
  )
  const results = useMultipleContractSingleData(chainId, blockNumber, contracts, ERC20Interface, 'balanceOf', accounts)
  let max
  for (const result of results) {
    if (!result.valid || !result.result?.length) continue
    const value = BigNumber.from(result.result[0])
    if (!max || value.gt(max)) max = value
  }
  return max?.toString()
}

export function getProvider(chainId: ChainId) {
  if (providerCache[chainId]) return providerCache[chainId]!
  const name = getInfuraChainName(chainId)
  providerCache[chainId] = new InfuraProvider(name, project)
  providerCache[chainId]?.once('error', (e) => {
    throw e
  })
  return providerCache[chainId]!
}

export function getInfuraChainName(chainId: ChainId) {
  switch (chainId) {
    case ChainId.MAINNET:
      return 'homestead'
    case ChainId.GOERLI:
      return 'goerli'
    default:
      throw new Error(`Unsupported eth infura chainId for ${chainId}`)
  }
}
