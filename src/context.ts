import { createContext, Dispatch } from 'react'
import { MulticallAction, MulticallState } from './types'


export const initialState: MulticallState = {
  callResults: {},
}
// The shared settings and dynamically created utilities
// required for the hooks and components
const MulticallContext = createContext<{
  state: MulticallState
  dispatch: Dispatch<MulticallAction>
  chainId?: number
  latestBlockNumber?: number,
  isDebug?: boolean
}>({
  state: initialState,
  dispatch: () => {},
})

export default MulticallContext