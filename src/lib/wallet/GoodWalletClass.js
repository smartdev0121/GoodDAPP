// @flow
import GoodDollarABI from '@gooddollar/goodprotocol/artifacts/abis/IGoodDollar.min.json'
import IdentityABI from '@gooddollar/goodprotocol/artifacts/abis/IIdentity.min.json'
import cERC20ABI from '@gooddollar/goodprotocol/artifacts/abis/cERC20.min.json'
import GoodReserveCDai from '@gooddollar/goodprotocol/artifacts/abis/GoodReserveCDai.min.json'
import SimpleStakingABI from '@gooddollar/goodprotocol/artifacts/abis/SimpleStakingV2.min.json'
import UBIABI from '@gooddollar/goodprotocol/artifacts/abis/UBIScheme.min.json'
import FundManagerABI from '@gooddollar/goodprotocol/artifacts/abis/GoodFundManager.min.json'
import GOODToken from '@gooddollar/goodprotocol/artifacts/abis/GReputation.min.json'
import ContractsAddress from '@gooddollar/goodprotocol/releases/deployment.json'
import OneTimePaymentsABI from '@gooddollar/goodcontracts/build/contracts/OneTimePayments.min.json'
import StakingModelAddress from '@gooddollar/goodcontracts/stakingModel/releases/deployment.json'
import InvitesABI from '@gooddollar/goodcontracts/upgradables/build/contracts/InvitesV1.min.json'
import FaucetABI from '@gooddollar/goodcontracts/upgradables/build/contracts/FuseFaucet.min.json'
import { MultiCall } from 'eth-multicall'
import Web3 from 'web3'
import { BN, toBN } from 'web3-utils'
import abiDecoder from 'abi-decoder'
import { chunk, flatten, get, identity, last, mapValues, maxBy, pickBy, range, sortBy, uniqBy, values } from 'lodash'
import moment from 'moment'
import bs58 from 'bs58'
import * as TextileCrypto from '@textile/crypto'
import Config from '../../config/config'
import logger from '../logger/js-logger'
import { ExceptionCategory } from '../exceptions/utils'
import API from '../API'
import { delay, retry as retryCall } from '../utils/async'
import { generateShareLink } from '../share'
import WalletFactory from './WalletFactory'

import {
  getTxLogArgs,
  NULL_ADDRESS,
  WITHDRAW_STATUS_COMPLETE,
  WITHDRAW_STATUS_PENDING,
  WITHDRAW_STATUS_UNKNOWN,
} from './utils'

const ZERO = new BN('0')
const log = logger.child({ from: 'GoodWalletV2' })

// eslint-disable-next-line
const retry = async asyncFn => retryCall(asyncFn, 1, 200)

type EventLog = {
  event: string,
  address: string,
  returnValues: any,
  logIndex: number,
  transactionIndex: number,
  transactionHash: string,
  blockHash: string,
  blockNumber: number,
  raw?: {
    data: string,
    topics: any[],
  },
}

type Log = {
  address: string,
  data: string,
  topics: Array<string | string[]>,
  logIndex: number,
  transactionIndex: number,
  transactionHash: string,
  blockHash: string,
  blockNumber: number,
}

type TransactionReceipt = {
  status: boolean,
  transactionHash: string,
  transactionIndex: number,
  blockHash: string,
  blockNumber: number,
  from: string,
  to: string,
  contractAddress?: string,
  cumulativeGasUsed: number,
  gasUsed: number,
  logs: Log[],
  logsBloom: string,
  events?: {
    [eventName: string]: EventLog,
  },
}

type PromiEvents = {
  onTransactionHash?: Function,
  onReceipt?: Function,
  onConfirmation?: Function,
  onError?: Function,
}

type GasValues = {
  gas?: number,
  gasPrice?: number,
}

const defaultPromiEvents: PromiEvents = {
  onTransactionHash: () => {},
  onReceipt: () => {},
  onConfirmation: () => {},
  onError: () => {},
}
const MultiCalls = {
  3: '0xFa8d865A962ca8456dF331D78806152d3aC5B84F',
  1: '0x5Eb3fa2DFECdDe21C950813C665E9364fa609bD2',
  122: '0x2219bf813a0f8f28d801859c215a5a94cca90ed1',
}
export class GoodWallet {
  static AccountUsageToPath = {
    gd: 0,
    gundb: 1,
    eth: 2,
    donate: 3,
    login: 4,
    faceVerification: 5,
  }

  ready: Promise<Web3>

  config: {}

  tokenContract: Web3.eth.Contract

  identityContract: Web3.eth.Contract

  oneTimePaymentsContract: Web3.eth.Contract

  erc20Contract: Web3.eth.Contract

  UBIContract: Web3.eth.Contract

  SimpleDaiStaking: Web3.eth.Contract

  invitesContract: Web3.eth.Contract

  faucetContract: Web3.eth.Contract

  account: string

  accounts: Array<string>

  networkId: number

  network: string

  gasPrice: number

  subscribers: any = {}

  isPollEvents: boolean = true

  web3Mainnet: Web3

  constructor(walletConfig: {} = {}) {
    this.config = walletConfig
    this.init()
  }

  init(): Promise<any> {
    const mainnetNetworkId = get(ContractsAddress, Config.network + '-mainnet.networkId', 122)
    const mainnethttpWeb3provider = Config.ethereum[mainnetNetworkId].httpWeb3provider
    this.web3Mainnet = new Web3(mainnethttpWeb3provider)
    const ready = WalletFactory.create(this.config)
    this.ready = ready
      .then(wallet => {
        log.info('GoodWallet initial wallet created.')
        this.wallet = wallet
        this.accounts = this.wallet.eth.accounts.wallet
        this.account = this.getAccountForType('gd')
        this.wallet.eth.defaultAccount = this.account
        this.networkId = ContractsAddress[Config.network].networkId
        this.network = Config.network
        log.info(`networkId: ${this.networkId}`)
        this.gasPrice = wallet.utils.toWei('1', 'gwei')
        this.wallet.eth.defaultGasPrice = this.gasPrice
        this.multicallFuse = new MultiCall(this.wallet, MultiCalls[this.networkId])
        this.multicallMainnet = new MultiCall(this.web3Mainnet, MultiCalls[mainnetNetworkId])

        log.info('GoodWallet setting up contracts:')

        // Identity Contract
        this.identityContract = new this.wallet.eth.Contract(
          IdentityABI.abi,
          get(ContractsAddress, `${this.network}.Identity` /*IdentityABI.networks[this.networkId].address*/),
          { from: this.account },
        )

        // Token Contract
        this.tokenContract = new this.wallet.eth.Contract(
          GoodDollarABI.abi,
          get(ContractsAddress, `${this.network}.GoodDollar` /*GoodDollarABI.networks[this.networkId].address*/),
          { from: this.account },
        )
        abiDecoder.addABI(GoodDollarABI.abi)

        // ERC20 Contract
        this.erc20Contract = new this.wallet.eth.Contract(
          cERC20ABI.abi,
          get(ContractsAddress, `${this.network}.GoodDollar` /*GoodDollarABI.networks[this.networkId].address*/),
          { from: this.account },
        )
        abiDecoder.addABI(cERC20ABI.abi)

        // UBI Contract
        this.UBIContract = new this.wallet.eth.Contract(
          UBIABI.abi,
          get(ContractsAddress, `${this.network}.UBIScheme` /*UBIABI.networks[this.networkId].address*/),
          { from: this.account },
        )
        abiDecoder.addABI(UBIABI.abi)

        // OneTimePaymentLinks Contract
        this.oneTimePaymentsContract = new this.wallet.eth.Contract(
          OneTimePaymentsABI.abi,
          get(
            ContractsAddress,
            `${this.network}.OneTimePayments` /*OneTimePaymentsABI.networks[this.networkId].address*/,
          ),
          {
            from: this.account,
          },
        )
        abiDecoder.addABI(OneTimePaymentsABI.abi)

        // UBI Contract
        this.invitesContract = new this.wallet.eth.Contract(
          InvitesABI.abi,
          get(ContractsAddress, `${this.network}.Invites`, '0x5a35C3BC159C4e4afAfadbdcDd8dCd2dd8EC8CBE'),
          { from: this.account },
        )
        abiDecoder.addABI(InvitesABI.abi)

        // faucet Contract
        this.faucetContract = new this.wallet.eth.Contract(
          FaucetABI.abi,
          get(ContractsAddress, `${this.network}.FuseFaucet`),
          { from: this.account },
        )
        abiDecoder.addABI(FaucetABI.abi)

        // GOOD Contract
        this.GOODContract = new this.wallet.eth.Contract(
          GOODToken.abi,
          get(ContractsAddress, `${this.network}.GReputation` /*UBIABI.networks[this.networkId].address*/),
          { from: this.account },
        )
        abiDecoder.addABI(GOODToken.abi)

        // debug print contracts addresses
        {
          const { network, networkId } = this
          const contractAddresses = ContractsAddress[network]
          const mainnetAddresses = ContractsAddress[network + '-mainnet']

          log.debug('GoodWallet initialized with addresses', {
            networkId,
            mainnetNetworkId,
            network,
            contractAddresses,
            mainnetAddresses,
          })
        }

        log.info('GoodWallet Ready.', { account: this.account })
      })
      .catch(e => {
        log.warn('Failed initializing GoodWallet', e.message, e, { category: ExceptionCategory.Blockhain })
        throw e
      })
    return this.ready
  }

  getRewardsAddresses() {
    const addr = get(ContractsAddress, `${this.network}.Invites`)
    return [addr].filter(_ => _ && _ !== NULL_ADDRESS).map(_ => _.toLowerCase())
  }

  getUBIAddresses() {
    const addrs = [
      get(StakingModelAddress, `${this.network}.UBIScheme`),
      get(StakingModelAddress, `${this.network}.UBISchemeOld`),
      get(ContractsAddress, `${this.network}.UBIScheme`),
      get(ContractsAddress, `production-bug.UBIScheme`),
    ]
    return addrs.filter(_ => _ && _ !== NULL_ADDRESS).map(_ => _.toLowerCase())
  }

  setIsPollEvents(active) {
    this.isPollEvents = active
    if (!active) {
      this.pollEventsTimeout && clearTimeout(this.pollEventsTimeout)
    }
  }

  async pollEvents(fn, time, lastBlockCallback) {
    const STEP = 10000 //pokt network max events request

    try {
      const run = async () => {
        if (this.isPollEvents === false) {
          return
        }

        let lastBlock = await retry(() => this.wallet.eth.getBlockNumber())

        if (lastBlock <= this.lastEventsBlock) {
          // if next block not mined yet
          return
        }

        let nextLastBlock = Math.min(lastBlock, this.lastEventsBlock + STEP)

        //await callback to finish processing events before updating lastEventblock
        //we pass nextlastblock as null so the request naturally requests until the last block a node has,
        //this is to prevent errors where some nodes for some reason still dont have the last block
        const events = flatten(await fn(nextLastBlock < lastBlock ? nextLastBlock : null))

        if (events.length) {
          const lastEvent = maxBy(events, 'blockNumber')
          this._notifyEvents(flatten(events), this.lastEventsBlock)
          const lastBlock = parseInt(lastEvent.blockNumber) + 1
          this.lastEventsBlock = lastBlock
          lastBlockCallback(lastBlock)
        } else {
          this.lastEventsBlock = nextLastBlock
        }

        log.info('pollEvents success:', { events: events.length, nextLastBlock })
        return true
      }

      const runRes = await Promise.race([run(), delay(5000, false)])

      if (runRes === false) {
        throw new Error('pollEvents not completed after 5 seconds')
      }
    } catch (e) {
      log.warn('pollEvents failed:', e.message, e, { category: ExceptionCategory.Blockhain })
    }
    this.pollEventsTimeout = setTimeout(() => this.pollEvents(fn, time, lastBlockCallback), time)
  }

  //eslint-disable-next-line require-await
  async watchEvents(fromBlock, lastBlockCallback) {
    this.setIsPollEvents(true)
    const lastBlock = await this.syncTxWithBlockchain(fromBlock).catch(_ => fromBlock)
    lastBlockCallback(lastBlock)
    this.lastEventsBlock = lastBlock

    this.pollEvents(
      toBlock =>
        Promise.all([this.pollSendEvents(toBlock), this.pollReceiveEvents(toBlock), this.pollOTPLEvents(toBlock)]),
      Config.web3Polling,
      lastBlockCallback,
    )
  }

  _notifyEvents(events, fromBlock) {
    if (events.length === 0) {
      return
    }

    log.debug('_notifyEvents got events', { events, fromBlock })
    this.getSubscribers('balanceChanged').forEach(cb => cb())
    const uniqEvents = sortBy(uniqBy(events, 'transactionHash'), 'blockNumber')
    uniqEvents.forEach(event => {
      this._notifyReceipt(event.transactionHash).catch(err =>
        log.error('_notifyEvents event get/send receipt failed:', err.message, err, {
          category: ExceptionCategory.Blockhain,
        }),
      )
    })
  }

  async syncTxWithBlockchain(startBlock) {
    const lastBlock = await this.wallet.eth.getBlockNumber()
    startBlock = Math.min(startBlock, lastBlock)
    const STEP = 10000
    const steps = range(startBlock, lastBlock, STEP)
    log.debug('Start sync tx from blockchain', {
      steps,
      startBlock,
      lastBlock,
    })

    try {
      const chunks = chunk(steps, 100)

      for (let chunk of chunks) {
        const ps = chunk.map(async fromBlock => {
          let toBlock = fromBlock + STEP

          if (toBlock > lastBlock) {
            toBlock = lastBlock
          }

          log.debug('sync tx step:', { fromBlock, toBlock })

          const events = await Promise.all([
            this.pollSendEvents(toBlock, fromBlock),
            this.pollReceiveEvents(toBlock, fromBlock),
            this.pollOTPLEvents(toBlock, fromBlock),
          ])

          this._notifyEvents(flatten(events), fromBlock)
        })

        // eslint-disable-next-line no-await-in-loop
        await Promise.all(ps)
      }
      log.debug('sync tx from blockchain finished successfully')
      return lastBlock
    } catch (e) {
      log.error('Failed to sync tx from blockchain', e.message, e)
    }
  }

  async pollSendEvents(toBlock, from = null) {
    const fromBlock = from || this.lastEventsBlock
    const contract = this.erc20Contract

    const fromEventsFilter = pickBy(
      {
        fromBlock,
        toBlock,
        filter: { from: this.wallet.utils.toChecksumAddress(this.account) },
      },
      identity,
    )

    const events = await retry(() => contract.getPastEvents('Transfer', fromEventsFilter)).catch((e = {}) => {
      //just warn about block not  found which is recoverable
      const logFunc = e.code === -32000 ? 'warn' : 'error'
      log[logFunc]('pollSendEvents failed:', e.message, e, {
        category: ExceptionCategory.Blockhain,
        fromEventsFilter,
      })
      return []
    })

    log.info('pollSendEvents result:', { events, from, fromBlock, toBlock, lastEventsBlock: this.lastEventsBlock })

    return events
  }

  async pollReceiveEvents(toBlock, from = null) {
    const fromBlock = from || this.lastEventsBlock
    const contract = this.erc20Contract

    const toEventsFilter = pickBy(
      {
        fromBlock,
        toBlock,
        filter: { to: this.wallet.utils.toChecksumAddress(this.account) },
      },
      identity,
    )

    const events = await retry(() => contract.getPastEvents('Transfer', toEventsFilter)).catch((e = {}) => {
      //just warn about block not  found which is recoverable
      const logFunc = e.code === -32000 ? 'warn' : 'error'
      log[logFunc]('pollReceiveEvents failed:', e.message, e, {
        category: ExceptionCategory.Blockhain,
        toEventsFilter,
      })
      return []
    })

    log.info('pollReceiveEvents result:', { events, from, fromBlock, toBlock, lastEventsBlock: this.lastEventsBlock })

    return events
  }

  async pollOTPLEvents(toBlock, from = null) {
    const fromBlock = from || this.lastEventsBlock
    const contract = this.oneTimePaymentsContract

    let fromEventsFilter = pickBy(
      {
        fromBlock,
        toBlock,
        filter: { from: this.wallet.utils.toChecksumAddress(this.account) },
      },
      identity,
    )

    log.debug('pollOTPLEvents call', { fromEventsFilter })

    const eventsCancel = await retry(() =>
      contract.getPastEvents('PaymentCancel', Object.assign({}, fromEventsFilter)),
    ).catch((e = {}) => {
      //just warn about block not  found which is recoverable
      const logFunc = e.code === -32000 ? 'warn' : 'error'
      log[logFunc]('pollOTPLEvents failed:', e.message, e, {
        category: ExceptionCategory.Blockhain,
        fromEventsFilter,
      })
      return []
    })

    // const eventsWithdraw = []
    const eventsWithdraw = await retry(() => contract.getPastEvents('PaymentWithdraw', fromEventsFilter)).catch(
      (e = {}) => {
        //just warn about block not  found which is recoverable
        const logFunc = e.code === -32000 ? 'warn' : 'error'
        log[logFunc]('pollOTPLEvents failed:', e.message, e, {
          category: ExceptionCategory.Blockhain,
          fromEventsFilter,
        })
        return []
      },
    )

    const events = eventsWithdraw.concat(eventsCancel)

    log.info('pollOTPLEvents result:', { events, from, fromBlock, toBlock, lastEventsBlock: this.lastEventsBlock })

    return events
  }

  /**
   * @return an existing (non-pending) transaction receipt information + human readable logs of the transaction
   * @param transactionHash The TX hash to return the data for
   */
  async getReceiptWithLogs(transactionHash: string) {
    const transactionReceipt = await this.wallet.eth.getTransactionReceipt(transactionHash)
    if (!transactionReceipt) {
      return null
    }

    const logs = abiDecoder.decodeLogs(transactionReceipt.logs).filter(_ => _)
    return { ...transactionReceipt, logs }
  }

  sendReceiptWithLogsToSubscribers(receipt: any, subscriptions: Array<string>) {
    subscriptions.forEach(subscription => {
      const subscribers = this.getSubscribers(subscription)
      log.debug('sendReceiptWithLogsToSubscribers', { receipt, subscription, subscribers })
      subscribers.forEach(cb => {
        log.debug('sendReceiptWithLogsToSubscribers receiptCallback:', {
          subscription,
          hash: receipt.transactionHash,
          cb,
        })
        cb(receipt)
      })
    })
    return receipt
  }

  async _notifyReceipt(txHash) {
    const receipt = await this.getReceiptWithLogs(txHash)

    if (!receipt) {
      return
    }

    return this.sendReceiptWithLogsToSubscribers(receipt, ['receiptUpdated'])
  }

  /**
   * Deletes the current account
   * @returns {Promise<Promise|Q.Promise<TransactionReceipt>|Promise<*>|*>}
   */
  async deleteAccount(): Promise<TransactionReceipt | void> {
    const canDelete = await this.identityContract.methods
      .lastAuthenticated(this.account)
      .call()
      .then(_ => parseInt(_) > 0)
      .catch(_ => true)

    if (canDelete === false) {
      return
    }
  }

  /**
   * Claims tokens for current account
   * @returns {Promise<TransactionReceipt>|Promise<Promise|Q.Promise<TransactionReceipt>|Promise<*>|*>}
   */
  claim(callbacks: PromiEvents): Promise<TransactionReceipt> {
    return this.sendTransaction(this.UBIContract.methods.claim(), callbacks)
  }

  async checkEntitlement(): Promise<number> {
    try {
      return await retry(() =>
        this.UBIContract.methods
          .checkEntitlement()
          .call()
          .then(parseInt),
      )
    } catch (exception) {
      const { message } = exception

      log.error('checkEntitlement failed', message, exception)
      return 0
    }
  }

  /**
   * use multicall to get many stats
   */
  async getClaimScreenStatsFuse() {
    const calls = [
      {
        periodStart: this.UBIContract.methods.periodStart(),
        currentDay: this.UBIContract.methods.currentDay(),
        activeClaimers: this.UBIContract.methods.activeUsersCount(),
        distribution: this.UBIContract.methods.dailyCyclePool(),
        dailyStats: this.UBIContract.methods.getDailyStats(),
      },
    ]

    //entitelment is separate because it depends on msg.sender
    const [[[res]], entitlement] = await Promise.all([this.multicallFuse.all([calls]), this.checkEntitlement()])
    res.entitlement = entitlement
    res.claimers = res.dailyStats[0]
    res.claimAmount = res.dailyStats[1]
    delete res.dailyStats

    const result = mapValues(res, parseInt)

    const startRef = moment(result.periodStart * 1000).utc()
    if (startRef.isBefore(moment().utc())) {
      startRef.add(result.currentDay + 1, 'days')
    }
    result.nextClaim = result.entitlement > 0 ? 0 : startRef.valueOf()

    return result
  }

  async getReservePriceDAI() {
    const { network, wallet, web3Mainnet } = this

    const reserve = new web3Mainnet.eth.Contract(
      GoodReserveCDai.abi,
      get(ContractsAddress, `${network}-mainnet.GoodReserveCDai`),
    )

    const price = await retry(() => reserve.methods.currentPriceDAI().call())

    return Number(wallet.utils.fromWei(price))
  }

  async getClaimScreenStatsMainnet() {
    const fundManager = new this.web3Mainnet.eth.Contract(
      FundManagerABI.abi,
      get(ContractsAddress, `${this.network}-mainnet.GoodFundManager`),
    )
    const cdai = new this.web3Mainnet.eth.Contract(cERC20ABI.abi, get(ContractsAddress, `${this.network}-mainnet.cDAI`))

    const stakingContracts = get(ContractsAddress, `${this.network}-mainnet.StakingContracts`, [])
    let gainCalls = stakingContracts.map(([addr, rewards]) => {
      const stakingContract = new this.web3Mainnet.eth.Contract(SimpleStakingABI.abi, addr, { from: this.account })

      return { currentGains: stakingContract.methods.currentGains(true, true) }
    })

    const calls = [
      {
        lastCollectedInterest: fundManager.methods.lastCollectedInterest(),
      },
      { cdaiExchangeRate: cdai.methods.exchangeRateStored() },
    ]

    let [[stakeResult, interestResult], currentBlock] = await Promise.all([
      this.multicallMainnet.all([gainCalls, calls]),
      this.web3Mainnet.eth.getBlockNumber(),
    ])

    const result = {}
    if (stakeResult) {
      stakeResult = stakeResult.map(({ currentGains }) => [
        parseInt(currentGains[3]) / 1e8,
        parseInt(currentGains[4]) / 1e8,
      ])

      // console.log({ stakeData, lastCollectData })
      result.totalFundsStaked = stakeResult.reduce((prev, cur) => prev + cur[0], 0)
      result.pendingInterest = stakeResult.reduce((prev, cur) => prev + cur[1], 0)
    }

    if (interestResult) {
      let [{ lastCollectedInterest }, { cdaiExchangeRate }] = interestResult

      cdaiExchangeRate = this.wallet.utils.fromWei(cdaiExchangeRate) / 1e10
      const estimatedBlocksSince = (Date.now() / 1000 - lastCollectedInterest) / 15
      const InterestCollectedEventsFilter = {
        fromBlock: (currentBlock - estimatedBlocksSince - 5000).toFixed(0),
        toBlock: (currentBlock - estimatedBlocksSince + 5000).toFixed(0),
      }
      const events = await retry(() =>
        fundManager.getPastEvents('FundsTransferred', InterestCollectedEventsFilter),
      ).catch(e => {
        log.error('InterestCollectedEvents failed:', e.message, e, {
          category: ExceptionCategory.Blockhain,
        })
        return []
      })
      log.debug('getInterestCollected:', { events })
      let interesInCDAI = parseInt(get(last(events), 'returnValues.cDAIinterestEarned', '0')) / 1e8 //convert to decimals. cdai is 8 decimals
      result.interestCollected = interesInCDAI * cdaiExchangeRate
    }

    return result
  }

  /**
   * Sets an id and place a callback function for this id, for the sent event
   * @dev event can have multiple subscribers, each one recieves it's own id
   * @return {object} subscriber id and eventName
   * @dev so consumer can unsubscribe using id and event name
   */
  subscribeToEvent(eventName: string, cb: (EventLog | TransactionReceipt) => any) {
    if (!this.subscribers[eventName]) {
      // Get last id from subscribersList
      this.subscribers[eventName] = {}
    }

    const subscribers = this.subscribers[eventName]
    const id = Math.max(...Object.keys(subscribers).map(parseInt), 0) + 1 // Give next id in a raw to current subscriber
    this.subscribers[eventName][id] = cb
    return { id, eventName }
  }

  /**
   * removes subscriber from subscriber list with the specified id and event name
   * @param {event} event
   */
  unsubscribeFromEvent({ eventName, id }: { eventName: string, id: number }) {
    delete this.subscribers[eventName][id]
  }

  /**
   * Gets all subscribers as array for given eventName
   * @param {string} eventName
   * @return a json object containing all subscribers for the specified event name
   */
  getSubscribers(eventName: string): Function {
    return values(this.subscribers[eventName] || {})
  }

  /**
   * Listen to balance changes for the current account
   * @param cb
   * @returns {Promise<void>}
   */
  balanceChanged(cb: Function) {
    return this.subscribeToEvent('balanceChanged', cb)
  }

  /**
   * Retrieves current Block Number and returns it
   * @returns {Promise<number>} - Current block number
   */
  getBlockNumber(): Promise<number> {
    return this.wallet.eth.getBlockNumber()
  }

  async balanceOf(): Promise<number> {
    try {
      const balance = await retry(() => this.tokenContract.methods.balanceOf(this.account).call())
      const balanceValue = toBN(balance)

      return balanceValue.toNumber()
    } catch (exception) {
      const { message } = exception

      log.error('BalanceOf failed', message, exception)
      return 0
    }
  }

  async balanceOfNative(): Promise<number> {
    const { wallet, account } = this

    try {
      const balance = await retry(() => wallet.eth.getBalance(account))
      const balanceValue = parseInt(balance)

      if (isNaN(balanceValue)) {
        throw new Error(`Invalid balance value '${balance}'`)
      }

      return balanceValue
    } catch (exception) {
      const { message } = exception

      log.warn('balanceOfNative failed', message, exception)
      throw exception
    }
  }

  signMessage() {}

  sendTx() {}

  getAccountForType(type: AccountUsage): string {
    const { defaultAccount } = get(this.wallet, 'eth', {})
    const accountPath = GoodWallet.AccountUsageToPath[type]
    const account = get(this.accounts, [accountPath, 'address'], defaultAccount)

    return account ? account.toString() : ''
  }

  async sign(toSign: string, accountType: AccountUsage = 'gd'): Promise<string> {
    let account = this.getAccountForType(accountType)
    let signed = await this.wallet.eth.sign(toSign, account)

    return signed
  }

  // eslint-disable-next-line require-await
  getEd25519Key(accountType: AccountUsage): TextileCrypto.PrivateKey {
    const pkeySeed = this.accounts[this.getAccountForType(accountType)].privateKey.slice(2)
    const seed = Uint8Array.from(Buffer.from(pkeySeed, 'hex'))
    return TextileCrypto.PrivateKey.fromRawEd25519Seed(seed)
  }

  /**
   * Determines if a specified address is verified in the blockchain
   * @param address
   * @returns {Promise<boolean>}
   */
  isVerified(address: string): Promise<boolean> {
    try {
      return retry(() => this.identityContract.methods.isWhitelisted(address).call())
    } catch (exception) {
      const { message } = exception

      log.error('isVerified failed', message, exception)
      return false
    }
  }

  lastVerified(): Promise<Date> {
    try {
      return retry(() =>
        this.identityContract.methods
          .dateAdded(this.account)
          .call()
          .then(parseInt)
          .then(_ => new Date(_ * 1000)),
      )
    } catch (exception) {
      const { message } = exception

      log.error('lastVerified failed', message, exception)
      return 0
    }
  }

  /**
   * Determines if current user is verified in the blockchain
   * @returns {Promise<boolean>}
   */
  isCitizen(): Promise<boolean> {
    return this.isVerified(this.account)
  }

  /**
   * Get transaction fee from GoodDollarReserveContract
   * @returns {Promise<number>}
   */
  async getTxFee(): Promise<number> {
    try {
      const { 0: fee, 1: senderPays } = await retry(() => this.tokenContract.methods.getFees(1).call())

      return senderPays ? toBN(fee) : ZERO
    } catch (exception) {
      const { message } = exception

      log.warn('getTxFee failed', message, exception)
      throw exception
    }
  }

  /**
   * Get transaction fee from GoodDollarReserveContract
   * @returns {Promise<boolean>}
   */
  async calculateTxFee(amount): Promise<boolean> {
    try {
      const { 0: fee, 1: senderPays } = await retry(() => this.tokenContract.methods.getFees(amount).call())

      return senderPays ? toBN(fee) : ZERO
    } catch (exception) {
      const { message } = exception

      log.warn('getTxFee failed', message, exception)
      throw exception
    }
  }

  /**
   * Checks if use can send an specific amount of G$s
   * @param {number} amount
   * @param {object} options
   * @returns {Promise<boolean>}
   */
  async canSend(amount: number, options = {}): Promise<boolean> {
    try {
      const { feeIncluded = false } = options
      let amountWithFee = amount

      if (!feeIncluded) {
        // 1% is represented as 10000, and divided by 1000000 when required to be % representation to enable more granularity in the numbers (as Solidity doesn't support floating point)
        const fee = await this.calculateTxFee(amount)

        amountWithFee = new BN(amount).add(fee)
      }
      const balance = await this.balanceOf()
      return parseInt(amountWithFee) <= balance
    } catch (exception) {
      const { message } = exception
      log.error('canSend failed', message, exception)
    }
    return false
  }

  /**
   * perform transaction to deposit amount into the OneTimePaymentLink contract
   * @param {number} amount
   * @param {string} hashedCode
   * @param {PromieEvents} callbacks
   */
  async depositToHash(amount: number, hashedCode: string, callbacks: PromiEvents): Promise<TransactionReceipt> {
    if (!(await this.canSend(amount))) {
      throw new Error(`Amount is bigger than balance`)
    }

    const otpAddress = this.oneTimePaymentsContract._address
    const transferAndCall = this.tokenContract.methods.transferAndCall(otpAddress, amount, hashedCode)

    // Fixed gas amount so it can work locally with ganache
    // https://github.com/trufflesuite/ganache-core/issues/417
    const gas: number = 200000 //Math.floor((await transferAndCall.estimateGas().catch(this.handleError)) * 2)

    //don't wait for transaction return immediately with hash code and link (not using await here)
    return this.sendTransaction(transferAndCall, callbacks, { gas })
  }

  /**
   * deposits the specified amount to _oneTimeLink_ contract and generates a link that will send the user to a URL to withdraw it
   * @param {number} amount - amount of money to send using OTP
   * @param {string} reason - optional reason for sending the payment (comment)
   * @param {string} category - optional category for sending the payment (comment)
   * @param {({ link: string, code: string }) => () => any} getOnTxHash - a callback that returns onTransactionHashHandler based on generated code
   * @param {PromiEvents} events - used to subscribe to onTransactionHash event
   * @returns {{code, hashedCode, paymentLink}}
   */
  generatePaymentLink(
    amount: number,
    reason: string = '',
    category: string = '',
    inviteCode: string,
    events: PromiEvents = defaultPromiEvents,
  ): { code: string, hashedCode: string, paymentLink: string } {
    const { privateKey: code, address: hashedCode } = this.wallet.eth.accounts.create()

    log.debug('generatePaymentLink:', { amount, code, hashedCode, reason, category })

    const params = {
      p: code,
      r: reason,
      cat: category,
    }
    inviteCode && (params.i = inviteCode)

    const paymentLink = generateShareLink('send', params)

    const asParam = this.wallet.eth.abi.encodeParameter('address', hashedCode)

    const txPromise = this.depositToHash(amount, asParam, events)

    return {
      code,
      hashedCode: hashedCode.toLowerCase(),
      paymentLink,
      txPromise,
    }
  }

  /**
   * @param otlCode code to unlock payment - a privatekey
   * @returns the payment id - public address
   */
  getWithdrawLink(otlCode: string) {
    return this.wallet.eth.accounts.privateKeyToAccount(otlCode).address
  }

  /**
   * checks against oneTimeLink contract, if the specified hash code has already been used to send payment or not.
   * @param {string} link
   * @returns {Promise<boolean>}
   */
  isPaymentLinkAvailable(link: string): Promise<boolean> {
    try {
      return retry(() => this.oneTimePaymentsContract.methods.hasPayment(link).call())
    } catch (exception) {
      const { message } = exception

      log.error('isPaymentLinkAvailable failed', message, exception)
      return false
    }
  }

  /**
   * Depending on what's queried off the blockchain for the OTL code, will return an status to display
   * @param otlCode - one time link code
   * @returns {Promise<{status:'Completed' | 'Cancelled' | 'Pending'}>}
   */
  async getWithdrawDetails(otlCode: string): Promise<{ status: 'Completed' | 'Cancelled' | 'Pending' }> {
    try {
      const hashedCode = this.getWithdrawLink(otlCode)
      const { paymentAmount, hasPayment, paymentSender: sender } = await retry(() =>
        this.oneTimePaymentsContract.methods.payments(hashedCode).call(),
      )

      const amount = toBN(paymentAmount).toNumber()
      let status = WITHDRAW_STATUS_UNKNOWN

      // Check payment availability
      if (hasPayment && amount > 0) {
        status = WITHDRAW_STATUS_PENDING
      }

      if (hasPayment === false && toBN(sender).isZero() === false) {
        status = WITHDRAW_STATUS_COMPLETE
      }

      return {
        hashedCode,
        status,
        amount,
        sender,
      }
    } catch (exception) {
      const { message } = exception

      log.warn('getWithdrawDetails failed', message, exception)
      throw exception
    }
  }

  /**
   * withdraws the payment received in the link to the current wallet holder
   * @param {string} otlCode - the privatekey to unlock payment
   * @param {PromiEvents} callbacks
   */
  withdraw(otlCode: string, callbacks: PromiEvents) {
    let method = 'withdraw'
    let args

    if (Config.simulateWithdrawReverted) {
      method = 'setIdentity'
      args = [this.account, this.account]
    } else {
      const paymentId = this.getWithdrawLink(otlCode)
      const toSign = this.wallet.utils.sha3(this.account)

      const privateKeyProof = this.wallet.eth.accounts.sign(toSign, otlCode)
      log.debug('withdraw:', { paymentId, toSign, otlCode, privateKeyProof })
      args = [paymentId, privateKeyProof.signature]
    }

    const withdrawCall = this.oneTimePaymentsContract.methods[method](...args)

    return this.sendTransaction(withdrawCall, callbacks)
  }

  /**
   * Cancels a Deposit based on its transaction hash
   * @param {string} transactionHash
   * @param {object} txCallbacks
   * @returns {Promise<TransactionReceipt>}
   */
  async cancelOTLByTransactionHash(transactionHash: string, txCallbacks: {} = {}): Promise<TransactionReceipt> {
    const { logs } = await this.getReceiptWithLogs(transactionHash)
    const paymentDepositLog = logs.filter(({ name }) => name === 'PaymentDeposit')[0]

    if (paymentDepositLog && paymentDepositLog.events) {
      const eventHashParam = paymentDepositLog.events.filter(({ name }) => name === 'paymentId')[0]

      if (eventHashParam) {
        const { value: paymentId } = eventHashParam
        return this.cancelOTL(paymentId, txCallbacks)
      }

      throw new Error('No hash available')
    } else {
      throw new Error('Impossible to cancel OTL')
    }
  }

  /**
   * cancels payment link and return the money to the sender (if not been withdrawn already)
   * @param {string} hashedCode
   * @param {object} txCallbacks
   * @returns {Promise<TransactionReceipt>}
   */
  async cancelOTL(hashedCode: string, txCallbacks: {} = {}): Promise<TransactionReceipt> {
    //check if already canceled
    const isValid = await this.isPaymentLinkAvailable(hashedCode)
    if (isValid) {
      const cancelOtlCall = this.oneTimePaymentsContract.methods.cancel(hashedCode)
      return this.sendTransaction(cancelOtlCall, txCallbacks)
    }
  }

  async collectInviteBounties() {
    const tx = this.invitesContract.methods.collectBounties()
    const nativeBalance = await this.balanceOfNative()
    const gas = Math.min(800000, nativeBalance / 1e9 - 150000) //convert to gwei and leave 150K gwei for user
    const res = await this.sendTransaction(tx, {}, { gas })
    return res
  }

  async collectInviteBounty(invitee) {
    try {
      const bountyFor = invitee || this.account
      const canCollect = await retry(() => this.invitesContract.methods.canCollectBountyFor(bountyFor).call())

      if (canCollect) {
        const tx = this.invitesContract.methods.bountyFor(bountyFor)
        const res = await this.sendTransaction(tx, {}, { gas: await tx.estimateGas().catch(e => 600000) })

        return res
      }
    } catch (e) {
      log.warn('collectInviteBounty failed:', e.message, e)
      throw e
    }
  }

  async isInviterCodeValid(inviterCode) {
    try {
      const byteCode = this.wallet.utils.fromUtf8(inviterCode)
      const registered = await retry(() => this.invitesContract.methods.codeToUser(byteCode).call())

      return registered !== NULL_ADDRESS
    } catch (e) {
      log.error('isInviterCodeValid failed:', e.message, e)
      return false
    }
  }

  async hasJoinedInvites(): [boolean, string, string] {
    try {
      const user = await retry(() => this.invitesContract.methods.users(this.account).call())

      return [parseInt(user.joinedAt) > 0, user.invitedBy, user.inviteCode]
    } catch (e) {
      log.error('hasJoinedInvites failed:', e.message, e)
      return false
    }
  }

  async joinInvites(inviter, codeLength = 10) {
    try {
      const [hasJoined, invitedBy, inviteCode] = await this.hasJoinedInvites()

      let myCode = hasJoined
        ? inviteCode
        : this.wallet.utils.fromUtf8(bs58.encode(Buffer.from(this.account.slice(2), 'hex')).slice(0, codeLength))

      //check under which account invitecode is registered, maybe we have a collission
      const registered = !hasJoined && (await retry(() => this.invitesContract.methods.codeToUser(myCode).call()))

      log.debug('joinInvites:', { inviter, myCode, codeLength, hasJoined, invitedBy, inviteCode })

      //code collision
      if (hasJoined === false && registered !== this.account && registered !== NULL_ADDRESS) {
        log.warn('joinInvites code collision:', { inviter, myCode, codeLength, registered })
        return this.joinInvites(inviter, codeLength + 1)
      }

      //not registered or not marked inviter
      if (!hasJoined || (inviter && invitedBy === NULL_ADDRESS)) {
        const tx = this.invitesContract.methods.join(
          myCode,
          (inviter && this.wallet.utils.fromUtf8(inviter)) || '0x0'.padEnd(66, 0),
        )

        log.debug('joinInvites registering:', { inviter, myCode, inviteCode, hasJoined, codeLength, registered })

        await this.sendTransaction(tx).catch(e => {
          log.warn('joinInvites failed:', e.message, e, { inviter, myCode, codeLength, registered })
          throw e
        })
      }

      //already registered
      return this.wallet.utils.toUtf8(myCode)
    } catch (e) {
      log.warn('joinInvites failed:', e.message, e)
      throw e
    }
  }

  async getUserInviteBounty() {
    const user = (await retry(() => this.invitesContract.methods.users(this.account).call()).catch(_ => {})) || {
      level: 0,
    }
    const level = (await retry(() => this.invitesContract.methods.levels(user.level).call()).catch(_ => {})) || {}
    return parseInt(get(level, 'bounty', 10000)) / 100
  }

  async getGasPrice(): Promise<number> {
    let gasPrice = this.gasPrice

    try {
      const networkGasPrice = await retry(() => this.wallet.eth.getGasPrice().then(toBN))

      if (networkGasPrice.gt(toBN('0'))) {
        gasPrice = networkGasPrice.toString()
      }
    } catch (e) {
      log.error('failed to retrieve gas price from network', e.message, e, { category: ExceptionCategory.Blockhain })
    }

    return gasPrice
  }

  // eslint-disable-next-line require-await
  async sendAmount(to: string, amount: number, callbacks: PromiEvents): Promise<TransactionReceipt> {
    return this.sendAmountWithData(to, amount, null, callbacks)
  }

  async sendAmountWithData(
    to: string,
    amount: number,
    data: string,
    callbacks: PromiEvents,
  ): Promise<TransactionReceipt> {
    if (!this.wallet.utils.isAddress(to)) {
      throw new Error('Address is invalid')
    }

    if (amount === 0 || !(await this.canSend(amount))) {
      throw new Error('Amount is bigger than balance')
    }

    log.info({ amount, to, data })
    const transferCall = data
      ? this.tokenContract.methods.transferAndCall(to, amount.toString(), this.wallet.utils.toHex(data))
      : this.tokenContract.methods.transfer(to, amount.toString()) // retusn TX object (not sent to the blockchain yet)

    return this.sendTransaction(transferCall, callbacks) // Send TX to the blockchain
  }

  /**
   * Helper to check if user has enough native token balance, if not try to ask server to topwallet
   * @param {number} wei
   * @param {object} options
   */
  async verifyHasGas(wei: number, options = {}) {
    const TOP_GWEI = 110000 * 1e9 //the gas fee for topWallet faucet call
    const minWei = wei ? wei : 250000 * 1e9

    try {
      const { topWallet = true } = options

      let nativeBalance = await this.balanceOfNative()

      if (nativeBalance > minWei) {
        return {
          ok: true,
        }
      }

      if (!topWallet) {
        return {
          ok: false,
        }
      }

      //self serve using faucet. we verify nativeBalance to prevent loop with sendTransaction which calls this function also
      if (nativeBalance >= TOP_GWEI && (await retry(() => this.faucetContract.methods.canTop(this.account).call()))) {
        log.info('verifyHasGas using faucet...')

        const toptx = this.faucetContract.methods.topWallet(this.account)
        const ok = await this.sendTransaction(toptx, undefined, { isVerifyHasGas: true })
          .then(_ => true)
          .catch(e => {
            log.error('verifyHasGas faucet failed', e.message, e)
            return false
          })
        if (ok) {
          return { ok }
        }
      }

      //if we cant use faucet or it failed then fallback to adminwallet api
      log.info('verifyHasGas no gas, asking for top wallet from server', {
        nativeBalance,
        required: minWei,
        address: this.account,
      })

      const toppingRes = await API.verifyTopWallet()
      const { data } = toppingRes

      if (!data || data.ok !== 1) {
        return {
          ok: false,
          error:
            !data || (data.error && !~data.error.indexOf(`User doesn't need topping`)) || data.sendEtherOutOfSystem,
          message: get(data, 'error'),
        }
      }

      nativeBalance = await this.balanceOfNative()

      return {
        ok: data.ok && nativeBalance > minWei,
      }
    } catch (e) {
      log.error('verifyHasGas failed:', e.message, e, { minWei })
      return {
        ok: false,
        error: true,
        message: e.message,
      }
    }
  }

  /**
   * Helper function to handle a tx Send call
   * @param tx
   * @param {PromiEvents} txCallbacks
   * @param {function} txCallbacks.onTransactionHash
   * @param {function} txCallbacks.onReceipt
   * @param {function} txCallbacks.onConfirmation
   * @param {function} txCallbacks.onError
   * @param {object} gasValues
   * @param {number} gasValues.gas
   * @param {number} gasValues.gasPrice
   * @returns {Promise<Promise|Q.Promise<TransactionReceipt>|Promise<*>|Promise<*>|Promise<*>|*>}
   */
  async sendTransaction(
    tx: any,
    txCallbacks: PromiEvents = defaultPromiEvents,
    { gas: setgas, gasPrice, isVerifyHasGas }: GasValues = {
      gas: undefined,
      gasPrice: undefined,
      isVerifyHasGas: false,
    },
  ) {
    const { onTransactionHash, onReceipt, onConfirmation, onError } = { ...defaultPromiEvents, ...txCallbacks }
    let gas =
      setgas ||
      (await tx
        .estimateGas()
        .then(g => parseInt((g * 1.2).toFixed(0)))
        .catch(e => log.debug('estimate gas failed'))) ||
      300000
    gasPrice = gasPrice || this.gasPrice
    if (Config.network === 'develop' && setgas === undefined) {
      gas *= 2
    }
    log.debug('sendTransaction:', { gas, gasPrice })
    if (isVerifyHasGas !== true) {
      //prevent recursive endless loop when sendTransaction call came from verifyHasGas
      const { ok, error, message } = await this.verifyHasGas(gas * gasPrice)
      if (ok === false) {
        return Promise.reject(
          error
            ? new Error(`sendTransaction verifyHasGas failed: ${message}`)
            : new Error('Reached daily transactions limit or not a citizen'),
        )
      }
    }
    const res = new Promise((res, rej) => {
      tx.send({ gas, gasPrice, chainId: this.networkId })
        .on('transactionHash', h => {
          log.debug('got txhash', h)
          onTransactionHash && onTransactionHash(h)
        })
        .on('receipt', r => {
          log.debug('got receipt', r)
          res(r)
          this._notifyReceipt(r.transactionHash) //although receipt will be received by polling, we do this anyways immediately
          this.getSubscribers('balanceChanged').forEach(cb => cb())

          onReceipt && onReceipt(r)
        })
        .on('confirmation', c => {
          log.debug('got confirmation', c)
          onConfirmation && onConfirmation(c)
        })
        .on('error', e => {
          log.warn('sendTransaction error:', e.message, e, {
            tx: getTxLogArgs(tx),
            category: ExceptionCategory.Blockhain,
          })
          rej(e)
          onError && onError(e)
        })
    })
    return res
  }

  async isKnownFuseAddress(address) {
    const nonce = await this.wallet.eth.getTransactionCount(address)
    return nonce > 0
  }
}

export const WalletType = GoodWallet.WalletType
export type AccountUsage = $Keys<typeof GoodWallet.AccountUsageToPath>
