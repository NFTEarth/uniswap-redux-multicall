import React, { FC, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { MulticallContext, initialState } from './context'
import {
  Call,
  ListenerOptions, MulticallAction,
  MulticallState
} from './types'
import useDebounce from './utils/useDebounce'
import { parseCallKey, toCallKey } from './utils/callKeys'
import chunkCalls from './utils/chunkCalls'
import { CHUNK_GAS_LIMIT, DEFAULT_CALL_GAS_REQUIRED } from './constants'
import { retry, RetryableError } from './utils/retry'
import { UniswapInterfaceMulticall } from './abi/types'

const FETCH_RETRY_CONFIG = {
  n: Infinity,
  minWait: 1000,
  maxWait: 2500,
}

/**
 * Fetches a chunk of calls, enforcing a minimum block number constraint
 * @param multicall multicall contract to fetch against
 * @param chunk chunk of calls to make
 * @param blockNumber block number passed as the block tag in the eth_call
 */
async function fetchChunk(
  multicall: UniswapInterfaceMulticall,
  chunk: Call[],
  blockNumber: number,
  isDebug?: boolean
): Promise<{ success: boolean; returnData: string }[]> {
  console.debug('Fetching chunk', chunk, blockNumber)
  try {
    const { returnData } = await multicall.callStatic.multicall(
      chunk.map((obj) => ({
        target: obj.address,
        callData: obj.callData,
        gasLimit: obj.gasRequired ?? DEFAULT_CALL_GAS_REQUIRED,
      })),
      // we aren't passing through the block gas limit we used to create the chunk, because it causes a problem with the integ tests
      { blockTag: blockNumber }
    )

    if (isDebug) {
      returnData.forEach(({ gasUsed, returnData, success }, i) => {
        if (
          !success &&
          returnData.length === 2 &&
          gasUsed.gte(Math.floor((chunk[i].gasRequired ?? DEFAULT_CALL_GAS_REQUIRED) * 0.95))
        ) {
          console.warn(
            `A call failed due to requiring ${gasUsed.toString()} vs. allowed ${
              chunk[i].gasRequired ?? DEFAULT_CALL_GAS_REQUIRED
            }`,
            chunk[i]
          )
        }
      })
    }

    return returnData
  } catch (e) {
    const error = e as any
    if (error.code === -32000 || error.message?.indexOf('header not found') !== -1) {
      throw new RetryableError(`header not found for block number ${blockNumber}`)
    } else if (error.code === -32603 || error.message?.indexOf('execution ran out of gas') !== -1) {
      if (chunk.length > 1) {
        if (process.env.NODE_ENV === 'development') {
          console.debug('Splitting a chunk in 2', chunk)
        }
        const half = Math.floor(chunk.length / 2)
        const [c0, c1] = await Promise.all([
          fetchChunk(multicall, chunk.slice(0, half), blockNumber),
          fetchChunk(multicall, chunk.slice(half, chunk.length), blockNumber),
        ])
        return c0.concat(c1)
      }
    }
    console.error('Failed to fetch chunk', error)
    throw error
  }
}

/**
 * From the current all listeners state, return each call key mapped to the
 * minimum number of blocks per fetch. This is how often each key must be fetched.
 * @param allListeners the all listeners state
 * @param chainId the current chain id
 */
export function activeListeningKeys(
  allListeners: MulticallState['callListeners'],
  chainId?: number
): { [callKey: string]: number } {
  if (!allListeners || !chainId) return {}
  const listeners = allListeners[chainId]
  if (!listeners) return {}

  return Object.keys(listeners).reduce<{ [callKey: string]: number }>((memo, callKey) => {
    const keyListeners = listeners[callKey]

    memo[callKey] = Object.keys(keyListeners)
      .filter((key) => {
        const blocksPerFetch = parseInt(key)
        if (blocksPerFetch <= 0) return false
        return keyListeners[blocksPerFetch] > 0
      })
      .reduce((previousMin, current) => {
        return Math.min(previousMin, parseInt(current))
      }, Infinity)
    return memo
  }, {})
}

/**
 * Return the keys that need to be refetched
 * @param callResults current call result state
 * @param listeningKeys each call key mapped to how old the data can be in blocks
 * @param chainId the current chain id
 * @param latestBlockNumber the latest block number
 */
export function outdatedListeningKeys(
  callResults: MulticallState['callResults'],
  listeningKeys: { [callKey: string]: number },
  chainId: number | undefined,
  latestBlockNumber: number | undefined
): string[] {
  if (!chainId || !latestBlockNumber) return []
  const results = callResults[chainId]
  // no results at all, load everything
  if (!results) return Object.keys(listeningKeys)

  return Object.keys(listeningKeys).filter((callKey) => {
    const blocksPerFetch = listeningKeys[callKey]

    const data = callResults[chainId][callKey]
    // no data, must fetch
    if (!data) return true

    const minDataBlockNumber = latestBlockNumber - (blocksPerFetch - 1)

    // already fetching it for a recent enough block, don't refetch it
    if (data.fetchingBlockNumber && data.fetchingBlockNumber >= minDataBlockNumber) return false

    // if data is older than minDataBlockNumber, fetch it
    return !data.blockNumber || data.blockNumber < minDataBlockNumber
  })
}

function onFetchChunkSuccess(
  chunk: Call[],
  result: Array<{ success: boolean; returnData: string }>
) {
  const { dispatch, chainId, latestBlockNumber, isDebug } = useContext(MulticallContext)

  // split the returned slice into errors and results
  const { erroredCalls, results } = chunk.reduce<{
    erroredCalls: Call[]
    results: { [callKey: string]: string | null }
  }>(
    (memo, call, i) => {
      if (result[i].success) {
        memo.results[toCallKey(call)] = result[i].returnData ?? null
      } else {
        memo.erroredCalls.push(call)
      }
      return memo
    },
    { erroredCalls: [], results: {} }
  )

  // dispatch any new results
  if (Object.keys(results).length > 0)
    dispatch({
      type: 'update',
      payload: {
        chainId,
        results,
        blockNumber: latestBlockNumber,
      }
    })

  // dispatch any errored calls
  if (erroredCalls.length > 0) {
    if (isDebug) {
      result.forEach((returnData, ix) => {
        if (!returnData.success) {
          console.debug('Call failed', chunk[ix], returnData)
        }
      })
    } else {
      console.debug('Calls errored in fetch', erroredCalls)
    }
    dispatch({
      type: 'error',
      payload: {
        calls: erroredCalls,
        chainId,
        fetchingBlockNumber: latestBlockNumber,
      }
    })
  }
}

function onFetchChunkFailure(chunk: Call[], error: any) {
  const { dispatch, chainId, latestBlockNumber } = useContext(MulticallContext)

  if (error.isCancelledError) {
    console.debug('Cancelled fetch for blockNumber', latestBlockNumber, chunk, chainId)
    return
  }
  console.error('Failed to fetch multicall chunk', chunk, chainId, error)
  dispatch({
    type: 'error',
    payload: {
      calls: chunk,
      chainId,
      fetchingBlockNumber: latestBlockNumber,
    }
  })
}

export const multicallReducer = (state: MulticallState, action: MulticallAction) : MulticallState => {
  switch (action.type) {
    case 'add': {
      const {
        calls,
        chainId,
        options: { blocksPerFetch },
      } = action.payload

      if (!chainId) {
        return state
      }

      const listeners: MulticallState['callListeners'] = state.callListeners
        ? state.callListeners
        : (state.callListeners = {})
      listeners[chainId] = listeners[chainId] ?? {}
      calls.forEach((call) => {
        const callKey = toCallKey(call)
        listeners[chainId][callKey] = listeners[chainId][callKey] ?? {}
        listeners[chainId][callKey][blocksPerFetch] = (listeners[chainId][callKey][blocksPerFetch] ?? 0) + 1
      })

      return state
    }
    case 'remove': {
      const {
        calls,
        chainId,
        options: { blocksPerFetch },
      } = action.payload
      const listeners: MulticallState['callListeners'] = state.callListeners
        ? state.callListeners
        : (state.callListeners = {})

      if (!chainId || !listeners[chainId]) {
        return state
      }

      calls.forEach((call) => {
        const callKey = toCallKey(call)
        if (!listeners[chainId][callKey]) return
        if (!listeners[chainId][callKey][blocksPerFetch]) return

        if (listeners[chainId][callKey][blocksPerFetch] === 1) {
          delete listeners[chainId][callKey][blocksPerFetch]
        } else {
          listeners[chainId][callKey][blocksPerFetch]--
        }
      })

      return state
    }
    case 'fetch': {
      const { chainId, fetchingBlockNumber, calls } = action.payload
      if (!chainId || !fetchingBlockNumber) {
        return state
      }

      state.callResults[chainId] = state.callResults[chainId] ?? {}
      calls.forEach((call) => {
        const callKey = toCallKey(call)
        const current = state.callResults[chainId][callKey]
        if (!current) {
          state.callResults[chainId][callKey] = {
            fetchingBlockNumber,
          }
        } else {
          if ((current.fetchingBlockNumber ?? 0) >= fetchingBlockNumber) return
          state.callResults[chainId][callKey].fetchingBlockNumber = fetchingBlockNumber
        }
      })

      return state
    }
    case 'error': {
      const { chainId, fetchingBlockNumber, calls } = action.payload
      if (!chainId || !fetchingBlockNumber) {
        return state
      }

      state.callResults[chainId] = state.callResults[chainId] ?? {}
      calls.forEach((call) => {
        const callKey = toCallKey(call)
        const current = state.callResults[chainId][callKey]
        if (!current || typeof current.fetchingBlockNumber !== 'number') return // only should be dispatched if we are already fetching
        if (current.fetchingBlockNumber <= fetchingBlockNumber) {
          delete current.fetchingBlockNumber
          current.data = null
          current.blockNumber = fetchingBlockNumber
        }
      })

      return state
    }
    case 'update': {
      const { chainId, results, blockNumber } = action.payload
      if (!chainId || !blockNumber) {
        return state
      }

      state.callResults[chainId] = state.callResults[chainId] ?? {}
      Object.keys(results).forEach((callKey) => {
        const current = state.callResults[chainId][callKey]
        if ((current?.blockNumber ?? 0) > blockNumber) return
        if (current?.data === results[callKey] && current?.blockNumber === blockNumber) return
        state.callResults[chainId][callKey] = {
          data: results[callKey],
          blockNumber,
        }
      })

      return state
    }
    case 'options': {
      const { chainId, listenerOptions } = action.payload
      if (!chainId) {
        return state
      }

      state.listenerOptions = state.listenerOptions ?? {}
      state.listenerOptions[chainId] = listenerOptions

      return state
    }
    default:
      return state;
  }
}

export interface ProviderProps {
  chainId: number | undefined // For now, one updater is required for each chainId to be watched
  latestBlockNumber: number | undefined
  contract: UniswapInterfaceMulticall
  isDebug?: boolean
  listenerOptions?: ListenerOptions
}

export const MulticallProvider: FC<ProviderProps> = (props) => {
  const { chainId, latestBlockNumber, contract, isDebug, listenerOptions, children } = props
  const [ state, dispatch ] = useReducer(multicallReducer, initialState)

  // set user configured listenerOptions in state for given chain ID.
  useEffect(() => {
    if (chainId && listenerOptions) {
      dispatch({
        type: 'options',
        payload: { chainId, listenerOptions }
      })
    }
  }, [chainId, listenerOptions, dispatch])

  // wait for listeners to settle before triggering updates
  const debouncedListeners = useDebounce(state.callListeners, 100)
  const cancellations = useRef<{ blockNumber: number; cancellations: (() => void)[] }>()

  const listeningKeys: { [callKey: string]: number } = useMemo(() => {
    return activeListeningKeys(debouncedListeners, chainId)
  }, [debouncedListeners, chainId])

  const serializedOutdatedCallKeys = useMemo(() => {
    const outdatedCallKeys = outdatedListeningKeys(state.callResults, listeningKeys, chainId, latestBlockNumber)
    return JSON.stringify(outdatedCallKeys.sort())
  }, [chainId, state.callResults, listeningKeys, latestBlockNumber])

  useEffect(() => {
    if (!latestBlockNumber || !chainId || !contract) return

    const outdatedCallKeys: string[] = JSON.parse(serializedOutdatedCallKeys)
    if (outdatedCallKeys.length === 0) return
    const calls = outdatedCallKeys.map((key) => parseCallKey(key))

    const chunkedCalls = chunkCalls(calls, CHUNK_GAS_LIMIT)

    if (cancellations.current && cancellations.current.blockNumber !== latestBlockNumber) {
      cancellations.current.cancellations.forEach((c) => c())
    }

    dispatch({
      type: 'fetch',
      payload: {
        calls,
        chainId,
        fetchingBlockNumber: latestBlockNumber,
      }
    })

    // Execute fetches and gather cancellation callbacks
    const newCancellations = chunkedCalls.map((chunk) => {
      const { cancel, promise } = retry(
        () => fetchChunk(contract, chunk, latestBlockNumber, isDebug),
        FETCH_RETRY_CONFIG
      )
      promise
        .then((result) => onFetchChunkSuccess(chunk, result))
        .catch((error) => onFetchChunkFailure(chunk, error))
      return cancel
    })

    cancellations.current = {
      blockNumber: latestBlockNumber,
      cancellations: newCancellations,
    }
  }, [chainId, contract, dispatch, serializedOutdatedCallKeys, latestBlockNumber, isDebug])

  return (
    <MulticallContext.Provider value={{
      state,
      dispatch
    }}>
      {children}
    </MulticallContext.Provider>
  )
}