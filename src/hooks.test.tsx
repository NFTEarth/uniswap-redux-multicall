import '@testing-library/jest-dom'
import { act } from 'react-dom/test-utils'
import { renderHook } from '@testing-library/react-hooks'
import React, { useReducer, useRef } from 'react'
import { render, unmountComponentAtNode } from 'react-dom'

import { initialState as  defaultState } from './context'
import { useCallsDataSubscription } from './hooks'
import { toCallKey } from './utils/callKeys'
import { Call, ListenerOptions } from './types'
import { multicallReducer } from './provider'

describe('multicall hooks', () => {
  let container: HTMLDivElement | null = null
  const { result } = renderHook(() => useReducer(multicallReducer, defaultState));
  const [, dispatch] = result.current;

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    if (container) {
      unmountComponentAtNode(container)
      container.remove()
    }
    container = null
  })

  function updateCallResult(call: Call, result: string) {
    act(() => {
      dispatch({
        type: 'update',
        payload: {
          chainId: 1,
          blockNumber: 1,
          results: { [toCallKey(call)]: result },
        }
      })
    })
  }

  describe('useCallsDataSubscription', () => {
    function Caller({
      calls,
      listenerOptions,
    }: {
      calls: Call[]
      listenerOptions?: ListenerOptions
    }) {
      const data = useCallsDataSubscription( 1, calls, listenerOptions)
      return <>{calls.map((call, i) => `${toCallKey(call)}:${data[i].data}`).join(';')}</>
    }

    describe('stabilizes values', () => {
      it('returns data matching calls', () => {
        const callA = { address: 'a', callData: '' }
        const callB = { address: 'b', callData: '' }
        updateCallResult(callA, '0xa')
        updateCallResult(callB, '0xb')

        render(
          <Caller calls={[callA]} />,
          container
        )
        expect(container?.textContent).toBe('a-:0xa')

        render(
          <Caller calls={[callB]} />,
          container
        )
        expect(container?.textContent).toBe('b-:0xb')

        render(
          <Caller calls={[callA, callB]} />,
          container
        )
        expect(container?.textContent).toBe('a-:0xa;b-:0xb')
      })

      it('returns updates immediately', () => {
        const call = { address: 'a', callData: '' }
        updateCallResult(call, '0xa')

        render(
          <Caller calls={[call]} />,
          container
        )
        expect(container?.textContent).toBe('a-:0xa')

        updateCallResult(call, '0xb')
        expect(container?.textContent).toBe('a-:0xb')
      })

      it('ignores subsequent updates if data is stable', () => {
        function Caller({ calls }: { calls: Call[] }) {
          const data = useCallsDataSubscription(1, calls)
          const { current: initialData } = useRef(data)
          return <>{(data === initialData).toString()}</>
        }
        const mock = jest.fn(Caller)
        const MockCaller: typeof Caller = mock

        const call = { address: 'a', callData: '' }
        updateCallResult(call, '0xa')

        render(
          <MockCaller calls={[call]} />,
          container
        )
        expect(container?.textContent).toBe('true')

        // stable update
        updateCallResult(call, '0xa')
        expect(container?.textContent).toBe('true')

        // unrelated update
        updateCallResult({ address: 'b', callData: '' }, '0xb')
        expect(container?.textContent).toBe('true')
      })
    })

    describe('utilizes correct blocksPerFetch values from defaultListenerOptions in store', () => {
      it('utilizes blocksPerFetch configured in defaultListenerOptions in store', () => {
        const callA = { address: 'a', callData: '' }
        const chainId = 1
        const blocksPerFetch = 10
        updateCallResult(callA, '0xa')

        dispatch({
          type: 'options',
          payload: {
            chainId,
            listenerOptions: {
              blocksPerFetch,
            },
          }
        })

        act(() => {
          render(
            <Caller calls={[callA]} />,
            container
          )
        })
      })

      it('overrides blocksPerFetch configured in defaultListenerOptions in store when blocksPerFetch param is provided', () => {
        const callA = { address: 'a', callData: '' }
        const chainId = 1
        const blocksPerFetch = 10
        updateCallResult(callA, '0xa')

        dispatch({
          type: 'options',
          payload: {
            chainId,
            listenerOptions: {
              blocksPerFetch,
            },
          }
        })

        act(() => {
          render(
            <Caller calls={[callA]} listenerOptions={{ blocksPerFetch: 5 }} />,
            container
          )
        })
      })

      it('defaults blocksPerFetch to DEFAULT_BLOCK_PER_FETCH constant when blocksPerFetch param is undefined and no defaultListenerOptions is provided', () => {
        const callA = { address: 'a', callData: '' }
        updateCallResult(callA, '0xa')

        act(() => {
          render(
            <Caller calls={[callA]} />,
            container
          )
        })
      })
    })
  })
})
