// import './aa.init'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import {
  EntryPoint,
  EntryPoint__factory,
  ZkProverZkpVerifierWrapper,
  ZkProverZkpVerifierWrapper__factory
  
} from '../typechain-types'
import {
  AddressZero,
  createAddress,
  ONE_ETH,
} from './testutils'
import { parseEther } from 'ethers/lib/utils'
import { compile_yul, halo2zkpVerifierAbi } from '../scripts/utils'
import { utils } from 'ethers'

describe('0.stakeManagement.test', () => {
    let addr: string
    let entryPoint: EntryPoint
    let verifier: ZkProverZkpVerifierWrapper
    const ethersSigner = ethers.provider.getSigner()
    const globalUnstakeDelaySec = 2
    before(async () => {
      addr = await ethersSigner.getAddress()
      let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");

      const factory = new ethers.ContractFactory(
          halo2zkpVerifierAbi,
          verifyCode,
          ethersSigner
        );
        const verifyContract = await factory.deploy();
      verifier = await new ZkProverZkpVerifierWrapper__factory(
        ethersSigner
        ).deploy(verifyContract.address);
      entryPoint = await new EntryPoint__factory(ethersSigner).deploy(verifier.address)

    })

    it('should deposit for transfer into EntryPoint', async () => {
      const signer2 = ethers.provider.getSigner(2)
      await signer2.sendTransaction({ to: entryPoint.address, value: parseEther('1') })
      expect(await entryPoint.balanceOf(await signer2.getAddress())).to.eql(
        parseEther('1')
      )
      const { deposit, staked, unstakeDelaySec, withdrawTime } =
      await entryPoint.getDepositInfo(await signer2.getAddress())
      expect(deposit).to.be.greaterThanOrEqual(parseEther('1'));
      expect(staked).to.eq(false);
      expect(unstakeDelaySec).to.eq(0);
      expect(withdrawTime).to.eq(0);
    })

    it('should fail to withdraw to many deposit', async () => {
      // const signer2 = ethers.provider.getSigner(2)
      const depositAmount = utils.parseEther("0.5");
      const withdrawAmountOverLimit = utils.parseEther("1");
      await ethersSigner.sendTransaction({ to: entryPoint.address, value: depositAmount , gasLimit: 1000000})
      await expect(entryPoint.withdrawTo(AddressZero, withdrawAmountOverLimit)).to.revertedWith(
        'Withdraw amount too large'
      )
    })

    it('succeed to withdraw with proper deposit', async () => {
      const depositAmount = utils.parseEther("0.5");
      const withdrawAmountOver = utils.parseEther("0.1");
      await ethersSigner.sendTransaction({ to: entryPoint.address, value: depositAmount, gasLimit: 1000000})
      await expect(entryPoint.withdrawTo(AddressZero, withdrawAmountOver)).to.be.fulfilled;
    })


    describe('without stake', () => {
      it('should fail to stake without value', async () => {
        await expect(entryPoint.addStake(2)).to.revertedWith(
          'no stake specified'
        )
      })
      it('should fail to stake without delay', async () => {
        await expect(
          entryPoint.addStake(0, { value: ONE_ETH })
        ).to.revertedWith('must specify unstake delay')
      })
      it('should fail to unlock', async () => {
        await expect(entryPoint.unlockStake()).to.revertedWith('not staked')
      })
    })
    describe('with stake of 2 eth', () => {
      before(async () => {
        await entryPoint.addStake(2, { value: parseEther('2') })
      })
      it('should report "staked" state', async () => {
        const { stake, staked, unstakeDelaySec, withdrawTime } =
          await entryPoint.getDepositInfo(addr)

          expect(stake).to.be.greaterThanOrEqual(parseEther('2'));
          expect(staked).to.eq(true);
          expect(unstakeDelaySec).to.eq(2);
          expect(withdrawTime).to.eq(0);
      
      })

      it('should succeed to stake again', async () => {
        const { stake } = await entryPoint.getDepositInfo(addr)
        await entryPoint.addStake(2, { value: ONE_ETH })
        const { stake: stakeAfter } = await entryPoint.getDepositInfo(addr)
        expect(stakeAfter).to.eq(stake.add(ONE_ETH))
      })
      it('should fail to withdraw before unlock', async () => {
        await expect(entryPoint.withdrawStake(AddressZero)).to.revertedWith(
          'must call unlockStake() first'
        )
      })
      describe('with unlocked stake', () => {
        before(async () => {
          await entryPoint.unlockStake()
        })
        it('should report as "not staked"', async () => {
          expect(
            await entryPoint.getDepositInfo(addr).then((info) => info.staked)
          ).to.eq(false)
        })
        it('should report unstake state', async () => {
          const withdrawTime1 =
            (await ethers.provider
              .getBlock('latest')
              .then((block) => block.timestamp)) + globalUnstakeDelaySec
          const { stake, staked, unstakeDelaySec, withdrawTime } =
            await entryPoint.getDepositInfo(addr)
          
            expect(stake).to.be.greaterThanOrEqual(parseEther('3'));
            expect(staked).to.eq(false);
            expect(unstakeDelaySec).to.eq(2);
            expect(withdrawTime).to.eq(withdrawTime1);
        })
        it('should fail to withdraw before unlock timeout', async () => {
          await expect(entryPoint.withdrawStake(AddressZero)).to.revertedWith(
            'Stake withdrawal is not due'
          )
        })
        it('should fail to unlock again', async () => {
          await expect(entryPoint.unlockStake()).to.revertedWith(
            'already unstaking'
          )
        })
        describe('after unstake delay', () => {
          before(async () => {
            // dummy transaction and increase time by 2 seconds
            await ethers.provider.send('evm_increaseTime', [2])
            await ethersSigner.sendTransaction({ to: addr })
          })
          it('adding stake should reset "unlockStake"', async () => {
            let snap
            try {
              snap = await ethers.provider.send('evm_snapshot', [])

              await ethersSigner.sendTransaction({ to: addr })
              await entryPoint.addStake(2, { value: parseEther('2') })
              const { stake, staked, unstakeDelaySec, withdrawTime } =
                await entryPoint.getDepositInfo(addr)
              expect(stake).to.be.greaterThanOrEqual(parseEther('2'));
              expect(staked).to.eq(true);
              expect(unstakeDelaySec).to.eq(2);
              expect(withdrawTime).to.eq(0);

            } finally {
              await ethers.provider.send('evm_revert', [snap])
            }
          })

          it('should fail to unlock again', async () => {
            await expect(entryPoint.unlockStake()).to.revertedWith(
              'already unstaking'
            )
          })
          it('should succeed to withdraw', async () => {
            const { stake } = await entryPoint.getDepositInfo(addr)
            const addr1 = createAddress()
            await entryPoint.withdrawStake(addr1)
            expect(await ethers.provider.getBalance(addr1)).to.eq(stake)
            const {
              stake: stakeAfter,
              withdrawTime,
              unstakeDelaySec
            } = await entryPoint.getDepositInfo(addr)

            expect(stakeAfter).to.eq(0)
            expect(unstakeDelaySec).to.eq(0)
            expect(withdrawTime).to.eq(0)
          })
        })
      })
    })
})
