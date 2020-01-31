const seedrandom = require('seedrandom');
const { VotingStatus, PredefinedDbPaths, WriteDbOperations } = require('../constants');
const PushId = require('../db/push-id');
const MAX_RECENT_PROPOSERS = 20;

class VotingUtil {
  constructor(node) {
    this.node = node;
    this.setStatus(VotingStatus.START_UP);
    this.block = null;
    this.lastVotes = [];
    this.votes = [];
  }

  setStatus(status, setter = "") {
    this.status = status;
    this.statusChangedBlockNumber = this.node.bc.lastBlockNumber();
    this.setter = setter;
  }

  resolveDbPath(pathSubKeys) {
    return pathSubKeys.join('/');
  }

  registerVote(vote) {
    // Transactions can be null (when cascading from proposed_block) and duplicate (when cascading
    // from pre_vote)
    if (vote && !this.votes.find((_vote) => {
      return _vote.hash === vote.hash;
    })) {
      this.votes.push(vote);
    }
  }

  checkPreVotes() {
    const proposer = this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PROPOSER)
    const validatorsMinusProposer = Object.assign({},
        this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_VALIDATORS));
    delete validatorsMinusProposer[proposer];
    const total = Object.values(validatorsMinusProposer).reduce(function(a, b) {
      return a + b;
    }, 0);
    console.log(`Total prevotes from validators : ${total}\n` +
        `Received prevotes ${this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PRE_VOTES)}`);
    return (this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PRE_VOTES) > (total * 2 / 3) ||
        total === 0);
  }

  preVote() {
    // TODO (lia): check this.status === VotingStatus.RECEIVED_BLOCK ?
    const stakes = this.getStakes(this.node.account.address);
    if (stakes) {
      this.setStatus(VotingStatus.PRE_VOTE);
      console.log(
          `Current prevotes are ` +
          `${this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PRE_VOTES)}`);
      const transaction = this.node.createTransaction({
        operation: {
          type: WriteDbOperations.INC_VALUE,
          ref: PredefinedDbPaths.VOTING_ROUND_PRE_VOTES,
          value: stakes
        }
      });
      this.registerVote(transaction);
      return transaction;
    } else {
      return null;
    }
  }

  isCommit() {
    console.log(`Checking status ${this.status}`);
    return this.status !== VotingStatus.COMMITTED && this.checkPreCommits();
  }

  reset() {
    this.setStatus(VotingStatus.COMMITTED);
    this.block = null;
    this.lastVotes = this.votes;
    this.votes = [];
  }

  isSyncedWithNetwork() {
    // This does not currently take in to a count the situation where consensus is not reached.
    // Need to add logic to account for this situation
    const sync = (VotingStatus.COMMITTED === this.status &&
        this.node.bc.lastBlockNumber() + 1 ===
            Number(this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_NUMBER)));
    if (!sync) {
      this.setStatus(VotingStatus.SYNCING);
    }
    return sync;
  }


  preCommit() {
    if (this.status !== VotingStatus.PRE_VOTE) {
      return null;
    }
    const stakes = this.getStakes(this.node.account.address);
    if (stakes) {
      console.log(
          `Current precommits are ` +
          `${this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PRE_COMMITS)}`);
      this.setStatus(VotingStatus.PRE_COMMIT);
      const transaction = this.node.createTransaction({
        operation: {
          type: WriteDbOperations.INC_VALUE,
          ref: PredefinedDbPaths.VOTING_ROUND_PRE_COMMITS,
          value: stakes
        }
      });
      this.registerVote(transaction);
      return transaction;
    } else {
      return null;
    }
  }

  checkPreCommits() {
    const proposer = this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PROPOSER)
    const validatorsMinusProposer = Object.assign({},
        this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_VALIDATORS));
    delete validatorsMinusProposer[proposer];
    const total = Object.values(validatorsMinusProposer).reduce(function(a, b) {
      return a + b;
    }, 0);
    console.log(`Total pre_commits from validators : ${total}\n` +
        `Received pre_commits ` +
        `${this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PRE_COMMITS)}`);
    return (this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PRE_COMMITS) > (total * 2 / 3) ||
        total === 0);
  }


  instantiate() {
    console.log('Initialising voting !!');
    // This method should only be called by the very first node on the network !!
    // This user should establish themselves as the first node on the network, instantiate
    // the first /consensus/voting entry t db and commit this to the blockchain so it will be
    // picked up by new peers on the network
    const time = Date.now();
    const proposer = this.node.account.address;
    const stakes = this.getStakes(proposer);
    if (stakes) {
      const firstVotingData = {
        validators: {[proposer]: stakes},
        next_round_validators: {[proposer]: stakes},
        threshold: -1,
        proposer,
        pre_votes: 0,
        pre_commits: 0,
        time,
        block_hash: '',
        number: this.node.bc.lastBlockNumber() + 1,
        last_hash: this.node.bc.lastBlock().hash
      };
      return this.node.createTransaction({
        operation: {
          type: WriteDbOperations.SET_VALUE,
          ref: PredefinedDbPaths.VOTING_ROUND,
          value: firstVotingData
        }
      });
    } else {
      console.log(`Node should have staked by now but deposit was not made successfully.`)
      return null;
    }
  }

  startNewRound() {
    const lastRound = this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND);
    const time = Date.now();
    let proposer;
    if (Object.keys(lastRound.next_round_validators).length) {
      proposer = this.getProposer(lastRound.next_round_validators);
    } else {
      proposer = this.node.account.address;
    }
    const validatorsMinusProposer = Object.assign({}, lastRound.next_round_validators);
    delete validatorsMinusProposer[proposer];
    const threshold = Math.round(Object.values(validatorsMinusProposer).reduce(function(a, b) {
      return a + b;
    }, 0) * 2 / 3) - 1;
    let nextRound = {
      validators: lastRound.next_round_validators,
      next_round_validators: {},
      threshold,
      proposer,
      pre_votes: 0,
      pre_commits: 0,
      time, block_hash: null
    };
    if (this.checkPreCommits()) {
      nextRound = Object.assign({}, nextRound, {
        number: lastRound.number + 1,
        last_hash: lastRound.block_hash
      });
    } else {
      nextRound = Object.assign({}, nextRound, {
        number: lastRound.number,
        last_hash: lastRound.last_hash
      });
    }
    return this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: PredefinedDbPaths.VOTING_ROUND,
        value: nextRound
      }
    }, false);
  }

  registerForNextRound(number) {
    const votingRound = this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND);
    if ((!votingRound && number !== 0) || (votingRound && votingRound.number !== number)) {
      console.log(`[registerForNextRound] Invalid block number. ` +
          `Expected: ${number}, Actual: ${votingRound.number}`);
      return null;
    }
    const value = this.node.db.getValue(this.resolveDbPath([
        PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS,
        this.node.account.address,
        PredefinedDbPaths.DEPOSIT_VALUE
      ]));
    return this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: this.resolveDbPath([PredefinedDbPaths.VOTING_NEXT_ROUND_VALIDATORS,
            this.node.account.address]),
        value
      }
    });
  }

  setBlock(block, proposal) {
    console.log(`Setting block ${block.hash.substring(0, 5)} with number ${block.number}`);
    this.block = block;
    this.setStatus(VotingStatus.BLOCK_RECEIVED);
    // TODO (lia): fix lastVotes logic while fixing the rounding system
    this.lastVotes = this.votes;
    this.votes = [];
    this.registerVote(proposal);
  }

  getProposer(stakeHolders) {
    const alphabeticallyOrderedStakeHolders = Object.keys(stakeHolders).sort();
    const totalStakedAmount = Object.values(stakeHolders).reduce(function(a, b) {
      return a + b;
    }, 0);
    const seed = this.node.bc.chain.length > 5 ?
        this.node.bc.chain[this.node.bc.chain.length - 4].hash : this.node.bc.chain[0].hash;

    let cumulativeStakeFromPotentialValidators = 0;
    const randomNumGenerator = seedrandom(seed);
    const targetValue = randomNumGenerator() * totalStakedAmount;
    for (let i = 0; i < alphabeticallyOrderedStakeHolders.length; i++) {
      cumulativeStakeFromPotentialValidators += stakeHolders[alphabeticallyOrderedStakeHolders[i]];
      if (targetValue < cumulativeStakeFromPotentialValidators) {
        console.log(`Proposer is ${alphabeticallyOrderedStakeHolders[i]}`);
        return alphabeticallyOrderedStakeHolders[i];
      }
    }
    throw Error(`No proposer was selected from stakeholder dict ${stakeHolders} `);
  }

  isProposer() {
    return this.node.db.getValue(PredefinedDbPaths.VOTING_ROUND_PROPOSER) ===
        this.node.account.address;
  }

  isValidator() {
    return Boolean(this.node.db.getValue(
        this.resolveDbPath([PredefinedDbPaths.VOTING_ROUND_VALIDATORS,
            this.node.account.address])));
  }

  createStakeTransaction(amount) {
    const pushId = PushId.generate();
    return this.node.createTransaction({
        operation: {
          type: WriteDbOperations.SET_VALUE,
          ref: this.resolveDbPath([PredefinedDbPaths.DEPOSIT_CONSENSUS,
              this.node.account.address, pushId, PredefinedDbPaths.DEPOSIT_VALUE]),
          value: amount
        }
      });
  }

  // Returns the staked amount of address. If there is no stake or it's expired,
  // it returns 0.
  getStakes(address) {
    if (!address) address = this.node.account.address;
    const stakes = this.node.db.getValue(this.resolveDbPath([
        PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS,
        address
      ]));
    // TODO (lia): change Date.now() to Date.now() + some constant
    // (e.g. block creation time * X blocks)
    if (stakes && stakes.value > 0 && stakes.expire_at > Date.now()) {
      return stakes.value;
    } else {
      return 0;
    }
  }

  needRestaking(address) {
    if (!address) address = this.node.account.address;
    const stakes = this.node.db.getValue(this.resolveDbPath([
        PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS,
        address
      ]));
    return stakes && stakes.value > 0 && stakes.expire_at <= Date.now();
  }

  updateRecentProposers() {
    // TODO (lia): get recent proposers from the blockchain itself.
    let recentProposers = this.node.db.getValue(PredefinedDbPaths.RECENT_PROPOSERS) || {};
    delete recentProposers[this.node.account.address];
    recentProposers[this.node.account.address] = true;
    while (Object.keys(recentProposers).length > MAX_RECENT_PROPOSERS) {
      delete recentProposers[Objcet.keys(recentProposers)[0]];
    }
    return this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: PredefinedDbPaths.RECENT_PROPOSERS,
        value: recentProposers
      }
    });
  }
}

module.exports = VotingUtil;
