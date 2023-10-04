import React from 'react'
import { ChainId } from './consts'
import { useContract } from './hooks'
import { MulticallProvider } from '../src'

interface Props {
  chainId: ChainId
  blockNumber: number | undefined
  blocksPerFetch?: number
}

export function Updater({ chainId, blockNumber, blocksPerFetch }: Props) {
  const contract = useContract(chainId)
  const listenerOptions = blocksPerFetch ? { blocksPerFetch } : undefined
  return (
    <MulticallProvider
      chainId={chainId}
      latestBlockNumber={blockNumber}
      contract={contract}
      listenerOptions={listenerOptions}
    />
  )
}
